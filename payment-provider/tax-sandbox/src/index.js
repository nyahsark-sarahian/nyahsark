const MAX_JSON_BYTES = 64 * 1024;
const MAX_STRIPE_BYTES = 256 * 1024;
const MAX_MONEY_CENTS = 100_000_000;
const MAX_LINE_ITEMS = 100;
const INTERNAL_HOST = 'tax.internal';
const STRIPE_API_ORIGIN = 'https://api.stripe.com';
const STRIPE_API_ROOT = `${STRIPE_API_ORIGIN}/v1`;
const TAX_CODE = /^txcd_[0-9]{8}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const REGISTRATION_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const TAX_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const TAX_REASON = /^[a-z][a-z0-9_]{0,63}$/;
const PERCENTAGE = /^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,12})?$/;
const NON_COLLECTING_REASONS = new Set(['not_collecting', 'not_supported']);

class TaxProviderError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!isObject(value)) throw new TaxProviderError(400, `${label} is invalid`, 'INVALID_REQUEST');
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TaxProviderError(400, `${label} contains an unsupported field`, 'INVALID_REQUEST');
  }
}

function cleanString(value, label, maximum, pattern = null) {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > maximum ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))
  ) throw new TaxProviderError(400, `${label} is invalid`, 'INVALID_REQUEST');
  return value;
}

function optionalString(value, label, maximum) {
  if (value == null) return null;
  return cleanString(value, label, maximum);
}

function money(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_MONEY_CENTS) {
    throw new TaxProviderError(400, `${label} is invalid`, 'INVALID_REQUEST');
  }
  return value;
}

async function readJson(request) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new TaxProviderError(415, 'Tax quote content type is invalid', 'INVALID_CONTENT_TYPE');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new TaxProviderError(413, 'Tax quote request is too large', 'REQUEST_TOO_LARGE');
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw new TaxProviderError(400, 'Tax quote body is invalid', 'INVALID_REQUEST');
  if (bytes.length > MAX_JSON_BYTES) throw new TaxProviderError(413, 'Tax quote request is too large', 'REQUEST_TOO_LARGE');
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!isObject(value)) throw new Error('object required');
    return value;
  } catch (error) {
    if (error instanceof TaxProviderError) throw error;
    throw new TaxProviderError(400, 'Tax quote body is invalid', 'INVALID_REQUEST');
  }
}

function configuredString(value, label, maximum, pattern = null) {
  try {
    return cleanString(value, label, maximum, pattern);
  } catch {
    throw new TaxProviderError(503, 'Stripe Tax sandbox is not configured', 'CONFIGURATION_ERROR');
  }
}

function configuration(env) {
  if (env?.STRIPE_TAX_MODE !== 'sandbox') {
    throw new TaxProviderError(503, 'Stripe Tax sandbox is not configured', 'CONFIGURATION_ERROR');
  }
  const secretKey = configuredString(env.STRIPE_TAX_SECRET_KEY, 'Stripe Tax secret key', 256);
  if (!/^(?:rk|sk)_test_[A-Za-z0-9_]+$/.test(secretKey)) {
    throw new TaxProviderError(503, 'Stripe Tax sandbox is not configured', 'CONFIGURATION_ERROR');
  }
  const apiVersion = configuredString(env.STRIPE_TAX_API_VERSION, 'Stripe Tax API version', 80, /^\d{4}-\d{2}-\d{2}\.[a-z]+$/);
  const registrationReference = configuredString(
    env.STRIPE_TAX_REGISTRATION_REFERENCE,
    'Tax registration reference',
    200,
    REGISTRATION_REFERENCE
  );
  const merchandiseTaxCode = configuredString(env.STRIPE_TAX_MERCHANDISE_TAX_CODE, 'Merchandise tax code', 13, TAX_CODE);
  const shippingTaxCode = configuredString(env.STRIPE_TAX_SHIPPING_TAX_CODE, 'Shipping tax code', 13, TAX_CODE);
  const handlingTaxCode = configuredString(env.STRIPE_TAX_HANDLING_TAX_CODE, 'Handling tax code', 13, TAX_CODE);
  // Stripe expressly disallows its Handling Charge code in Calculation line_items.
  if (handlingTaxCode === 'txcd_92010004') {
    throw new TaxProviderError(503, 'Stripe Tax sandbox is not configured', 'CONFIGURATION_ERROR');
  }
  return {
    secretKey,
    apiVersion,
    registrationReference,
    merchandiseTaxCode,
    shippingTaxCode,
    handlingTaxCode
  };
}

function destination(value) {
  exactKeys(value, new Set(['recipient', 'line1', 'line2', 'city', 'region', 'postal_code', 'country_code']), 'Tax destination');
  const result = {
    recipient: optionalString(value.recipient, 'Tax destination recipient', 160),
    line1: cleanString(value.line1, 'Tax destination line 1', 200),
    line2: optionalString(value.line2, 'Tax destination line 2', 200),
    city: cleanString(value.city, 'Tax destination city', 120),
    region: cleanString(value.region, 'Tax destination region', 100, /^[A-Z0-9][A-Z0-9 .'-]{0,99}$/),
    postal_code: cleanString(value.postal_code, 'Tax destination postal code', 32, /^[A-Za-z0-9][A-Za-z0-9 .'-]{0,31}$/),
    country_code: cleanString(value.country_code, 'Tax destination country', 2, /^[A-Z]{2}$/)
  };
  return result;
}

function quoteLines(value, merchandiseCents, config, handlingCents) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LINE_ITEMS) {
    throw new TaxProviderError(400, 'Tax quote lines are invalid', 'INVALID_REQUEST');
  }
  const expected = [];
  let sum = 0;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    exactKeys(item, new Set(['artwork_id', 'quantity', 'line_total_cents']), 'Tax quote line');
    const artworkId = cleanString(item.artwork_id, 'Artwork identifier', 120, IDENTIFIER);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000) {
      throw new TaxProviderError(400, 'Tax quote line quantity is invalid', 'INVALID_REQUEST');
    }
    const amount = money(item.line_total_cents, 'Tax quote line total', 1);
    sum += amount;
    if (!Number.isSafeInteger(sum) || sum > MAX_MONEY_CENTS) {
      throw new TaxProviderError(400, 'Tax quote merchandise total is invalid', 'INVALID_REQUEST');
    }
    expected.push({
      amount,
      quantity: item.quantity,
      reference: `nya:${index}:${artworkId}`,
      taxCode: config.merchandiseTaxCode
    });
  }
  if (sum !== merchandiseCents) {
    throw new TaxProviderError(409, 'Tax quote merchandise total does not reconcile', 'BASIS_MISMATCH');
  }
  if (handlingCents > 0) {
    if (expected.length >= MAX_LINE_ITEMS) {
      throw new TaxProviderError(400, 'Tax quote has too many line items', 'INVALID_REQUEST');
    }
    expected.push({
      amount: handlingCents,
      quantity: 1,
      reference: 'nya:seller-handling',
      taxCode: config.handlingTaxCode
    });
  }
  return expected;
}

function validateQuoteInput(input, config) {
  exactKeys(input, new Set([
    'currency', 'destination', 'merchandise_cents', 'seller_shipping_cents',
    'seller_handling_cents', 'taxable_basis_cents', 'registration_reference', 'lines'
  ]), 'Tax quote');
  if (input.currency !== 'USD') throw new TaxProviderError(400, 'Tax quote currency is invalid', 'INVALID_REQUEST');
  const normalizedDestination = destination(input.destination);
  const merchandiseCents = money(input.merchandise_cents, 'Merchandise total', 1);
  const shippingCents = money(input.seller_shipping_cents, 'Shipping total');
  const handlingCents = money(input.seller_handling_cents, 'Handling total');
  const taxableBasisCents = money(input.taxable_basis_cents, 'Taxable basis', 1);
  const computedBasis = merchandiseCents + shippingCents + handlingCents;
  if (!Number.isSafeInteger(computedBasis) || computedBasis > MAX_MONEY_CENTS || computedBasis !== taxableBasisCents) {
    throw new TaxProviderError(409, 'Taxable basis does not reconcile', 'BASIS_MISMATCH');
  }
  const registrationReference = cleanString(input.registration_reference, 'Tax registration reference', 200, REGISTRATION_REFERENCE);
  if (registrationReference !== config.registrationReference) {
    throw new TaxProviderError(409, 'Tax registration reference does not match the sandbox configuration', 'REGISTRATION_MISMATCH');
  }
  const expectedLines = quoteLines(input.lines, merchandiseCents, config, handlingCents);
  return {
    currency: 'USD',
    destination: normalizedDestination,
    merchandiseCents,
    shippingCents,
    handlingCents,
    taxableBasisCents,
    registrationReference,
    expectedLines
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

async function idempotencyKey(payload, config) {
  const material = canonical({
    contract: 'nyahsark-tax-quote-v1',
    destination: {
      line1: payload.destination.line1,
      line2: payload.destination.line2,
      city: payload.destination.city,
      region: payload.destination.region,
      postal_code: payload.destination.postal_code,
      country_code: payload.destination.country_code
    },
    taxable_basis_cents: payload.taxableBasisCents,
    shipping_cents: payload.shippingCents,
    lines: payload.expectedLines,
    registration_reference: payload.registrationReference,
    shipping_tax_code: config.shippingTaxCode
  });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(material))));
  const hex = [...digest].map((part) => part.toString(16).padStart(2, '0')).join('');
  return `nya-tax-sbx-${hex}`;
}

function calculationParameters(payload, config) {
  const parameters = new URLSearchParams();
  parameters.set('currency', 'usd');
  parameters.set('customer_details[address][line1]', payload.destination.line1);
  if (payload.destination.line2) parameters.set('customer_details[address][line2]', payload.destination.line2);
  parameters.set('customer_details[address][city]', payload.destination.city);
  parameters.set('customer_details[address][state]', payload.destination.region);
  parameters.set('customer_details[address][postal_code]', payload.destination.postal_code);
  parameters.set('customer_details[address][country]', payload.destination.country_code);
  parameters.set('customer_details[address_source]', 'shipping');
  for (let index = 0; index < payload.expectedLines.length; index += 1) {
    const item = payload.expectedLines[index];
    parameters.set(`line_items[${index}][amount]`, String(item.amount));
    parameters.set(`line_items[${index}][quantity]`, String(item.quantity));
    parameters.set(`line_items[${index}][reference]`, item.reference);
    parameters.set(`line_items[${index}][tax_behavior]`, 'exclusive');
    parameters.set(`line_items[${index}][tax_code]`, item.taxCode);
  }
  if (payload.shippingCents > 0) {
    parameters.set('shipping_cost[amount]', String(payload.shippingCents));
    parameters.set('shipping_cost[tax_behavior]', 'exclusive');
    parameters.set('shipping_cost[tax_code]', config.shippingTaxCode);
  }
  parameters.set('expand[0]', 'line_items');
  return parameters;
}

async function stripeJson(response) {
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_STRIPE_BYTES || type !== 'application/json') {
    throw new TaxProviderError(502, 'Stripe Tax returned an invalid response', 'STRIPE_RESPONSE_INVALID');
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    throw new TaxProviderError(502, 'Stripe Tax returned an invalid response', 'STRIPE_RESPONSE_INVALID');
  }
  if (!response.ok) throw new TaxProviderError(502, 'Stripe Tax rejected the calculation', 'STRIPE_REQUEST_FAILED');
  if (!isObject(value)) throw new TaxProviderError(502, 'Stripe Tax returned an invalid response', 'STRIPE_RESPONSE_INVALID');
  return value;
}

async function stripeCalculation(fetchImpl, config, parameters, key) {
  let response;
  try {
    response = await fetchImpl(`${STRIPE_API_ROOT}/tax/calculations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': key,
        'stripe-version': config.apiVersion
      },
      body: parameters,
      redirect: 'error',
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined
    });
  } catch {
    throw new TaxProviderError(503, 'Stripe Tax calculation outcome is uncertain', 'STRIPE_REQUEST_UNCERTAIN');
  }
  return stripeJson(response);
}

function validStripeInteger(value, maximum = MAX_MONEY_CENTS) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function assertStripeAddress(calculation, payload) {
  const details = calculation.customer_details;
  const address = details?.address;
  if (
    !isObject(details) || !isObject(address) || details.address_source !== 'shipping' ||
    details.taxability_override !== 'none' || !Array.isArray(details.tax_ids) || details.tax_ids.length !== 0 ||
    address.line1 !== payload.destination.line1 || (address.line2 ?? null) !== payload.destination.line2 ||
    address.city !== payload.destination.city || address.state !== payload.destination.region ||
    address.postal_code !== payload.destination.postal_code || address.country !== payload.destination.country_code
  ) throw new TaxProviderError(502, 'Stripe Tax returned a mismatched destination', 'STRIPE_RESPONSE_INVALID');
}

function assertStripeLines(calculation, payload, config) {
  const list = calculation.line_items;
  if (
    !isObject(list) || list.object !== 'list' || list.has_more !== false ||
    list.total_count !== payload.expectedLines.length || !Array.isArray(list.data) ||
    list.data.length !== payload.expectedLines.length
  ) throw new TaxProviderError(502, 'Stripe Tax returned mismatched line items', 'STRIPE_RESPONSE_INVALID');
  const returned = new Map();
  for (const item of list.data) {
    if (!isObject(item) || typeof item.reference !== 'string' || returned.has(item.reference)) {
      throw new TaxProviderError(502, 'Stripe Tax returned mismatched line items', 'STRIPE_RESPONSE_INVALID');
    }
    returned.set(item.reference, item);
  }
  let tax = 0;
  for (const expected of payload.expectedLines) {
    const item = returned.get(expected.reference);
    if (
      !isObject(item) || item.object !== 'tax.calculation_line_item' || item.livemode !== false ||
      item.amount !== expected.amount || item.quantity !== expected.quantity || item.tax_behavior !== 'exclusive' ||
      item.tax_code !== expected.taxCode || !validStripeInteger(item.amount_tax)
    ) throw new TaxProviderError(502, 'Stripe Tax returned mismatched line items', 'STRIPE_RESPONSE_INVALID');
    tax += item.amount_tax;
  }
  const shipping = calculation.shipping_cost;
  if (payload.shippingCents === 0) {
    if (shipping != null) throw new TaxProviderError(502, 'Stripe Tax returned a mismatched shipping amount', 'STRIPE_RESPONSE_INVALID');
  } else if (
    !isObject(shipping) || shipping.amount !== payload.shippingCents || shipping.tax_behavior !== 'exclusive' ||
    shipping.tax_code !== config.shippingTaxCode || !validStripeInteger(shipping.amount_tax)
  ) throw new TaxProviderError(502, 'Stripe Tax returned a mismatched shipping amount', 'STRIPE_RESPONSE_INVALID');
  else tax += shipping.amount_tax;
  return tax;
}

function readable(value) {
  return value.split('_').map((part, index) => index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part).join(' ');
}

function normalizedBreakdown(calculation, payload) {
  if (!Array.isArray(calculation.tax_breakdown) || calculation.tax_breakdown.length < 1 || calculation.tax_breakdown.length > 20) {
    throw new TaxProviderError(502, 'Stripe Tax returned an invalid tax breakdown', 'STRIPE_RESPONSE_INVALID');
  }
  let total = 0;
  const rates = calculation.tax_breakdown.map((entry) => {
    const details = entry?.tax_rate_details;
    if (
      !isObject(entry) || entry.inclusive !== false || !validStripeInteger(entry.amount) ||
      !validStripeInteger(entry.taxable_amount) || !isObject(details) ||
      typeof details.country !== 'string' || !/^[A-Z]{2}$/.test(details.country) ||
      details.country !== payload.destination.country_code ||
      !(details.state == null || (typeof details.state === 'string' && /^[A-Z0-9-]{1,12}$/.test(details.state))) ||
      typeof details.tax_type !== 'string' || !TAX_TYPE.test(details.tax_type) ||
      typeof details.percentage_decimal !== 'string' || !PERCENTAGE.test(details.percentage_decimal) ||
      typeof entry.taxability_reason !== 'string' || !TAX_REASON.test(entry.taxability_reason)
    ) throw new TaxProviderError(502, 'Stripe Tax returned an invalid tax breakdown', 'STRIPE_RESPONSE_INVALID');
    if (NON_COLLECTING_REASONS.has(entry.taxability_reason)) {
      throw new TaxProviderError(409, 'Stripe Tax did not confirm collection for this jurisdiction', 'TAX_COLLECTION_NOT_READY');
    }
    const percentage = Number(details.percentage_decimal);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw new TaxProviderError(502, 'Stripe Tax returned an invalid tax rate', 'STRIPE_RESPONSE_INVALID');
    }
    total += entry.amount;
    if (!Number.isSafeInteger(total) || total > MAX_MONEY_CENTS) {
      throw new TaxProviderError(502, 'Stripe Tax returned an invalid tax total', 'STRIPE_RESPONSE_INVALID');
    }
    const code = [details.country, details.state].filter(Boolean).join('-');
    return {
      name: `${readable(details.tax_type)} (${readable(entry.taxability_reason)}; ${code})`,
      rate: percentage / 100,
      amount_cents: entry.amount,
      taxable_amount_cents: entry.taxable_amount,
      taxability_reason: entry.taxability_reason,
      jurisdiction_code: code
    };
  });
  if (total !== calculation.tax_amount_exclusive) {
    throw new TaxProviderError(502, 'Stripe Tax breakdown does not reconcile', 'STRIPE_RESPONSE_INVALID');
  }
  return rates;
}

function validateCalculation(calculation, payload, config, now) {
  if (
    typeof calculation.id !== 'string' || !/^taxcalc_[A-Za-z0-9]+$/.test(calculation.id) || calculation.id.length > 200 ||
    calculation.object !== 'tax.calculation' || calculation.livemode !== false || calculation.currency !== 'usd' ||
    !validStripeInteger(calculation.tax_amount_exclusive) || calculation.tax_amount_inclusive !== 0 ||
    !validStripeInteger(calculation.amount_total, MAX_MONEY_CENTS * 2) ||
    calculation.amount_total !== payload.taxableBasisCents + calculation.tax_amount_exclusive ||
    !Number.isSafeInteger(calculation.tax_date) || calculation.tax_date < 1 ||
    !Number.isSafeInteger(calculation.expires_at) || calculation.expires_at <= now() || calculation.expires_at <= calculation.tax_date
  ) throw new TaxProviderError(502, 'Stripe Tax returned an invalid calculation', 'STRIPE_RESPONSE_INVALID');
  assertStripeAddress(calculation, payload);
  const componentTax = assertStripeLines(calculation, payload, config);
  if (componentTax !== calculation.tax_amount_exclusive) {
    throw new TaxProviderError(502, 'Stripe Tax component totals do not reconcile', 'STRIPE_RESPONSE_INVALID');
  }
  const rates = normalizedBreakdown(calculation, payload);
  const jurisdictionCode = `${payload.destination.country_code}-${payload.destination.region}`;
  return {
    currency: 'USD',
    tax_cents: calculation.tax_amount_exclusive,
    taxable_basis_cents: payload.taxableBasisCents,
    breakdown: {
      jurisdiction: jurisdictionCode,
      jurisdiction_code: jurisdictionCode,
      rates,
      source_reference: calculation.id,
      calculated_at: new Date(calculation.tax_date * 1000).toISOString()
    }
  };
}

async function quote(input, env, fetchImpl, now) {
  const config = configuration(env);
  const payload = validateQuoteInput(input, config);
  const parameters = calculationParameters(payload, config);
  const key = await idempotencyKey(payload, config);
  const calculation = await stripeCalculation(fetchImpl, config, parameters, key);
  return validateCalculation(calculation, payload, config, now);
}

export function createTaxSandboxWorker({fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000)} = {}) {
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        if (
          url.protocol !== 'https:' || url.hostname !== INTERNAL_HOST || url.port ||
          url.pathname !== '/quote' || url.search || request.method !== 'POST'
        ) throw new TaxProviderError(404, 'Not found', 'NOT_FOUND');
        return json(await quote(await readJson(request), env, fetchImpl, now));
      } catch (error) {
        const known = error instanceof TaxProviderError;
        return json({
          error: known ? error.message : 'Tax quote failed',
          code: known ? error.code : 'INTERNAL_ERROR'
        }, known ? error.status : 500);
      }
    }
  };
}

export default createTaxSandboxWorker();
