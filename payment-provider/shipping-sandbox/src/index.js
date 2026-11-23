const MAX_JSON_BYTES = 64 * 1024;
const MAX_MONEY_CENTS = 100_000_000;
const MAX_PACKAGES = 100;
const INTERNAL_HOST = 'shipping.internal';
const SERVICE_CODE = /^[A-Za-z0-9_.:-]{1,160}$/;
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;

class ShippingError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (value, status = 200) => Response.json(value, {
  status,
  headers: {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  }
});

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cents = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MONEY_CENTS;

function text(value, label, maximum, pattern = null) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.trim() !== value || (pattern && !pattern.test(value))) {
    throw new ShippingError(400, `${label} is invalid`, 'INVALID_REQUEST');
  }
  return value;
}

async function readJson(request) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new ShippingError(415, 'Shipping quote content type is invalid', 'INVALID_CONTENT_TYPE');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new ShippingError(413, 'Shipping quote is too large', 'REQUEST_TOO_LARGE');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_JSON_BYTES) throw new ShippingError(400, 'Shipping quote body is invalid', 'INVALID_REQUEST');
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!object(value)) throw new Error('object required');
    return value;
  } catch {
    throw new ShippingError(400, 'Shipping quote body is invalid', 'INVALID_REQUEST');
  }
}

function address(value, label) {
  if (!object(value)) throw new ShippingError(400, `${label} is invalid`, 'INVALID_REQUEST');
  const country = text(value.country_code, `${label} country`, 2, /^[A-Z]{2}$/);
  return {
    recipient: value.recipient == null ? null : text(value.recipient, `${label} recipient`, 160),
    line1: text(value.line1, `${label} line 1`, 200),
    line2: value.line2 == null ? null : text(value.line2, `${label} line 2`, 200),
    city: text(value.city, `${label} city`, 120),
    region: text(value.region, `${label} region`, 100, /^[A-Z0-9 -]+$/),
    postal_code: text(value.postal_code, `${label} postal code`, 32, /^[A-Za-z0-9 -]+$/),
    country_code: country
  };
}

function positiveScaled(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000) {
    throw new ShippingError(400, `${label} is invalid`, 'INVALID_REQUEST');
  }
  return value;
}

function packages(value, packingStrategy) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PACKAGES) {
    throw new ShippingError(400, 'Packages are invalid', 'INVALID_REQUEST');
  }
  let itemCount = 0;
  const normalized = value.map((item) => {
    if (!object(item)) throw new ShippingError(400, 'Package is invalid', 'INVALID_REQUEST');
    const quantity = item.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw new ShippingError(400, 'Package quantity is invalid', 'INVALID_REQUEST');
    itemCount += quantity;
    if (!Number.isSafeInteger(itemCount) || itemCount > 500) throw new ShippingError(400, 'Package quantity is invalid', 'INVALID_REQUEST');
    const dimensionUnit = text(item.dimension_unit, 'Package dimension unit', 2);
    const weightUnit = text(item.weight_unit, 'Package weight unit', 2);
    if (!['in', 'cm'].includes(dimensionUnit) || !['oz', 'lb', 'g', 'kg'].includes(weightUnit) || item.value_scale !== 1000) {
      throw new ShippingError(400, 'Package units are invalid', 'INVALID_REQUEST');
    }
    return {
      artwork_id: text(item.artwork_id, 'Artwork identifier', 120, ID),
      configuration_id: text(item.configuration_id, 'Configuration identifier', 120, ID),
      quantity,
      id: text(item.id, 'Packing profile identifier', 120, ID),
      label: text(item.label, 'Packing profile label', 160),
      length_value: positiveScaled(item.length_value, 'Package length'),
      width_value: positiveScaled(item.width_value, 'Package width'),
      height_value: positiveScaled(item.height_value, 'Package height'),
      dimension_unit: dimensionUnit,
      weight_value: positiveScaled(item.weight_value, 'Package weight'),
      weight_unit: weightUnit,
      value_scale: 1000
    };
  });
  if (packingStrategy === 'single_package' && (normalized.length !== 1 || itemCount !== 1)) {
    throw new ShippingError(409, 'Single-package sandbox quotes require exactly one item', 'PACKING_STRATEGY_MISMATCH');
  }
  return {normalized, itemCount, parcelCount: packingStrategy === 'separate_packages' ? itemCount : 1};
}

function rates(env) {
  if (env?.SHIPPING_MODE !== 'sandbox') throw new ShippingError(503, 'Sandbox shipping is not configured', 'CONFIGURATION_ERROR');
  let parsed;
  try { parsed = JSON.parse(env.SANDBOX_SERVICE_RATES_JSON); }
  catch { parsed = null; }
  if (!object(parsed) || Object.keys(parsed).length < 1 || Object.keys(parsed).length > 20) {
    throw new ShippingError(503, 'Sandbox shipping is not configured', 'CONFIGURATION_ERROR');
  }
  const output = new Map();
  for (const [code, rate] of Object.entries(parsed)) {
    if (!SERVICE_CODE.test(code) || !object(rate) || !cents(rate.base_cents) || !cents(rate.per_parcel_cents) || !cents(rate.per_item_cents)) {
      throw new ShippingError(503, 'Sandbox shipping is not configured', 'CONFIGURATION_ERROR');
    }
    output.set(code, {
      base_cents: rate.base_cents,
      per_parcel_cents: rate.per_parcel_cents,
      per_item_cents: rate.per_item_cents
    });
  }
  return output;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

async function reference(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(stable(value)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest].map((part) => part.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 24);
}

async function quote(input, env) {
  if (input.currency !== 'USD') throw new ShippingError(400, 'Shipping currency is invalid', 'INVALID_REQUEST');
  const serviceCode = text(input.service_code, 'Shipping service code', 160, SERVICE_CODE);
  const packingStrategy = text(input.packing_strategy, 'Packing strategy', 30);
  if (!['single_package', 'separate_packages'].includes(packingStrategy)) throw new ShippingError(400, 'Packing strategy is invalid', 'INVALID_REQUEST');
  const origin = address(input.origin, 'Shipping origin');
  const destination = address(input.destination, 'Shipping destination');
  const bundle = packages(input.packages, packingStrategy);
  const serviceRates = rates(env);
  const rate = serviceRates.get(serviceCode);
  if (!rate) throw new ShippingError(409, 'Sandbox shipping service is not configured', 'SERVICE_NOT_CONFIGURED');
  const total = rate.base_cents + rate.per_parcel_cents * bundle.parcelCount + rate.per_item_cents * bundle.itemCount;
  if (!cents(total)) throw new ShippingError(503, 'Sandbox shipping rate is invalid', 'CONFIGURATION_ERROR');
  const fingerprint = await reference({
    mode: 'sandbox', serviceCode, origin, destination, packages: bundle.normalized,
    packingStrategy, itemCount: bundle.itemCount, parcelCount: bundle.parcelCount, rate
  });
  return {
    currency: 'USD',
    shipping_cents: total,
    service_reference: `sandbox:${serviceCode}:${fingerprint}`,
    sandbox: true
  };
}

export function createShippingSandboxWorker() {
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        if (url.protocol !== 'https:' || url.host !== INTERNAL_HOST || url.pathname !== '/quote' || url.search || request.method !== 'POST') {
          throw new ShippingError(404, 'Not found', 'NOT_FOUND');
        }
        return json(await quote(await readJson(request), env));
      } catch (error) {
        const known = error instanceof ShippingError;
        return json({error: known ? error.message : 'Shipping quote failed', code: known ? error.code : 'INTERNAL_ERROR'}, known ? error.status : 500);
      }
    }
  };
}

export default createShippingSandboxWorker();
