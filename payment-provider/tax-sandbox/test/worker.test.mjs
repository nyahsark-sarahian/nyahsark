import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaxSandboxWorker} from '../src/index.js';

const NOW = 1_795_315_200;
const ENV = Object.freeze({
  STRIPE_TAX_MODE: 'sandbox',
  STRIPE_TAX_SECRET_KEY: 'rk_test_unit_only_not_a_real_key',
  STRIPE_TAX_API_VERSION: '2026-11-18.endive',
  STRIPE_TAX_REGISTRATION_REFERENCE: 'sandbox-registration-reviewed-001',
  STRIPE_TAX_MERCHANDISE_TAX_CODE: 'txcd_12345678',
  STRIPE_TAX_SHIPPING_TAX_CODE: 'txcd_87654321',
  STRIPE_TAX_HANDLING_TAX_CODE: 'txcd_11223344'
});

const INPUT = Object.freeze({
  currency: 'USD',
  destination: {
    recipient: 'Test Buyer',
    line1: '10 Test Lane',
    line2: null,
    city: 'Testville',
    region: 'NJ',
    postal_code: '07001',
    country_code: 'US'
  },
  merchandise_cents: 4000,
  seller_shipping_cents: 500,
  seller_handling_cents: 250,
  taxable_basis_cents: 4750,
  registration_reference: 'sandbox-registration-reviewed-001',
  lines: [
    {artwork_id: 'art-001', quantity: 1, line_total_cents: 2500},
    {artwork_id: 'art-002', quantity: 2, line_total_cents: 1500}
  ]
});

function stripeLine({id, amount, amountTax, quantity, reference, taxCode}) {
  return {
    id,
    object: 'tax.calculation_line_item',
    amount,
    amount_tax: amountTax,
    livemode: false,
    product: null,
    quantity,
    reference,
    tax_behavior: 'exclusive',
    tax_code: taxCode
  };
}

function calculation(overrides = {}) {
  return {
    id: 'taxcalc_testCalculation001',
    object: 'tax.calculation',
    amount_total: 5065,
    currency: 'usd',
    customer: null,
    customer_details: {
      address: {
        city: 'Testville', country: 'US', line1: '10 Test Lane', line2: null,
        postal_code: '07001', state: 'NJ'
      },
      address_source: 'shipping',
      ip_address: null,
      tax_ids: [],
      taxability_override: 'none'
    },
    expires_at: NOW + 86_400,
    line_items: {
      object: 'list',
      data: [
        stripeLine({
          id: 'tax_li_test001', amount: 2500, amountTax: 166, quantity: 1,
          reference: 'nya:0:art-001', taxCode: ENV.STRIPE_TAX_MERCHANDISE_TAX_CODE
        }),
        stripeLine({
          id: 'tax_li_test002', amount: 1500, amountTax: 99, quantity: 2,
          reference: 'nya:1:art-002', taxCode: ENV.STRIPE_TAX_MERCHANDISE_TAX_CODE
        }),
        stripeLine({
          id: 'tax_li_test003', amount: 250, amountTax: 17, quantity: 1,
          reference: 'nya:seller-handling', taxCode: ENV.STRIPE_TAX_HANDLING_TAX_CODE
        })
      ],
      has_more: false,
      total_count: 3,
      url: '/v1/tax/calculations/taxcalc_testCalculation001/line_items'
    },
    livemode: false,
    ship_from_details: null,
    shipping_cost: {
      amount: 500,
      amount_tax: 33,
      tax_behavior: 'exclusive',
      tax_code: ENV.STRIPE_TAX_SHIPPING_TAX_CODE
    },
    tax_amount_exclusive: 315,
    tax_amount_inclusive: 0,
    tax_breakdown: [{
      amount: 315,
      inclusive: false,
      tax_rate_details: {
        country: 'US', percentage_decimal: '6.625', state: 'NJ', tax_type: 'sales_tax'
      },
      taxability_reason: 'standard_rated',
      taxable_amount: 4750
    }],
    tax_date: NOW,
    ...overrides
  };
}

function jsonResponse(value, status = 200, contentType = 'application/json') {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': contentType}});
}

function request(body, options = {}) {
  return new Request(options.url || 'https://tax.internal/quote', {
    method: options.method || 'POST',
    headers: {'content-type': options.type || 'application/json'},
    body: options.method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
}

async function invoke(worker, body = INPUT, env = ENV, options = {}) {
  const response = await worker.fetch(request(body, options), env);
  return {response, body: await response.json()};
}

test('creates an exact test-mode Stripe Tax calculation and returns the admin quote contract', async () => {
  let outbound;
  const worker = createTaxSandboxWorker({now: () => NOW, fetchImpl: async (url, options) => {
    outbound = {url, options};
    return jsonResponse(calculation());
  }});
  const result = await invoke(worker);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, {
    currency: 'USD',
    tax_cents: 315,
    taxable_basis_cents: 4750,
    breakdown: {
      jurisdiction: 'US-NJ',
      jurisdiction_code: 'US-NJ',
      rates: [{
        name: 'Sales tax (Standard rated; US-NJ)',
        rate: 0.06625,
        amount_cents: 315,
        taxable_amount_cents: 4750,
        taxability_reason: 'standard_rated',
        jurisdiction_code: 'US-NJ'
      }],
      source_reference: 'taxcalc_testCalculation001',
      calculated_at: new Date(NOW * 1000).toISOString()
    }
  });
  assert.equal(outbound.url, 'https://api.stripe.com/v1/tax/calculations');
  assert.equal(outbound.options.method, 'POST');
  assert.equal(outbound.options.redirect, 'error');
  assert.equal(outbound.options.headers.authorization, `Bearer ${ENV.STRIPE_TAX_SECRET_KEY}`);
  assert.equal(outbound.options.headers['stripe-version'], ENV.STRIPE_TAX_API_VERSION);
  assert.match(outbound.options.headers['idempotency-key'], /^nya-tax-sbx-[a-f0-9]{64}$/);
  assert.doesNotMatch(outbound.options.headers['idempotency-key'], /Test|07001/);
  const form = outbound.options.body;
  assert.equal(form.get('customer_details[address][postal_code]'), '07001');
  assert.equal(form.get('customer_details[address_source]'), 'shipping');
  assert.equal(form.get('line_items[0][amount]'), '2500');
  assert.equal(form.get('line_items[1][quantity]'), '2');
  assert.equal(form.get('line_items[2][reference]'), 'nya:seller-handling');
  assert.equal(form.get('line_items[2][tax_code]'), ENV.STRIPE_TAX_HANDLING_TAX_CODE);
  assert.equal(form.get('shipping_cost[amount]'), '500');
  assert.equal(form.get('shipping_cost[tax_behavior]'), 'exclusive');
  assert.equal(form.get('expand[0]'), 'line_items');
});

test('derives a stable, opaque idempotency key from every tax-significant input', async () => {
  const keys = [];
  const worker = createTaxSandboxWorker({now: () => NOW, fetchImpl: async (_url, options) => {
    keys.push(options.headers['idempotency-key']);
    const postal = options.body.get('customer_details[address][postal_code]');
    const response = calculation({
      customer_details: {
        ...calculation().customer_details,
        address: {...calculation().customer_details.address, postal_code: postal}
      }
    });
    return jsonResponse(response);
  }});
  assert.equal((await invoke(worker)).response.status, 200);
  assert.equal((await invoke(worker)).response.status, 200);
  assert.equal((await invoke(worker, {...INPUT, destination: {...INPUT.destination, postal_code: '07002'}})).response.status, 200);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
});

test('fails closed for live mode, live keys, incomplete tax-code configuration, and disallowed handling code', async () => {
  const worker = createTaxSandboxWorker({fetchImpl: async () => { throw new Error('must not dispatch'); }});
  const variants = [
    {...ENV, STRIPE_TAX_MODE: 'live'},
    {...ENV, STRIPE_TAX_SECRET_KEY: 'sk_live_forbidden'},
    {...ENV, STRIPE_TAX_SECRET_KEY: 'rk_live_forbidden'},
    {...ENV, STRIPE_TAX_MERCHANDISE_TAX_CODE: 'replace-me'},
    {...ENV, STRIPE_TAX_HANDLING_TAX_CODE: 'txcd_92010004'}
  ];
  for (const env of variants) {
    const result = await invoke(worker, INPUT, env);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.code, 'CONFIGURATION_ERROR');
  }
});

test('requires the exact configured registration reference without claiming it proves registration', async () => {
  const worker = createTaxSandboxWorker({fetchImpl: async () => { throw new Error('must not dispatch'); }});
  for (const registration_reference of [null, '', 'a-different-reference']) {
    const result = await invoke(worker, {...INPUT, registration_reference});
    assert.ok([400, 409].includes(result.response.status));
  }
});

test('rejects unreconciled basis, merchandise lines, unsafe extras, and malformed money', async () => {
  const worker = createTaxSandboxWorker({fetchImpl: async () => { throw new Error('must not dispatch'); }});
  const invalid = [
    {...INPUT, taxable_basis_cents: 4749},
    {...INPUT, merchandise_cents: 3999, taxable_basis_cents: 4749},
    {...INPUT, seller_shipping_cents: 2.5},
    {...INPUT, lines: [{...INPUT.lines[0], line_total_cents: 2499}, INPUT.lines[1]]},
    {...INPUT, api_key: 'must-never-be-accepted'},
    {...INPUT, destination: {...INPUT.destination, token: 'must-never-be-accepted'}},
    {...INPUT, lines: [{...INPUT.lines[0], tax_code: 'txcd_00000000'}, INPUT.lines[1]]}
  ];
  for (const body of invalid) {
    const result = await invoke(worker, body);
    assert.ok([400, 409].includes(result.response.status));
  }
});

test('validates route, HTTPS host, method, query, content type, JSON object, and body size', async () => {
  const worker = createTaxSandboxWorker({fetchImpl: async () => { throw new Error('must not dispatch'); }});
  assert.equal((await invoke(worker, INPUT, ENV, {url: 'https://other.internal/quote'})).response.status, 404);
  assert.equal((await invoke(worker, INPUT, ENV, {url: 'http://tax.internal/quote'})).response.status, 404);
  assert.equal((await invoke(worker, INPUT, ENV, {url: 'https://tax.internal/quote?retry=1'})).response.status, 404);
  assert.equal((await invoke(worker, null, ENV, {method: 'GET'})).response.status, 404);
  assert.equal((await invoke(worker, INPUT, ENV, {type: 'text/plain'})).response.status, 415);
  assert.equal((await invoke(worker, '[]')).response.status, 400);
  const tooLarge = await worker.fetch(new Request('https://tax.internal/quote', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({padding: 'x'.repeat(70_000)})
  }), ENV);
  assert.equal(tooLarge.status, 413);
});

test('rejects live, stale, foreign, inclusive, or unreconciled Stripe calculations', async () => {
  const malformed = [
    calculation({livemode: true}),
    calculation({currency: 'eur'}),
    calculation({amount_total: 5064}),
    calculation({tax_amount_inclusive: 1}),
    calculation({expires_at: NOW}),
    calculation({customer_details: {...calculation().customer_details, address: {...calculation().customer_details.address, state: 'NY'}}}),
    calculation({line_items: {...calculation().line_items, total_count: 2}}),
    calculation({shipping_cost: {...calculation().shipping_cost, amount: 499}}),
    calculation({tax_amount_exclusive: 314, amount_total: 5064}),
    calculation({tax_breakdown: [{...calculation().tax_breakdown[0], amount: 314}]})
  ];
  for (const responseBody of malformed) {
    const worker = createTaxSandboxWorker({now: () => NOW, fetchImpl: async () => jsonResponse(responseBody)});
    const result = await invoke(worker);
    assert.equal(result.response.status, 502);
    assert.match(result.body.code, /^STRIPE_RESPONSE_/);
  }
});

test('treats not_collecting and not_supported as an unresolved registration or jurisdiction gate', async () => {
  for (const taxability_reason of ['not_collecting', 'not_supported']) {
    const responseBody = calculation({
      amount_total: 4750,
      tax_amount_exclusive: 0,
      line_items: {
        ...calculation().line_items,
        data: calculation().line_items.data.map((line) => ({...line, amount_tax: 0}))
      },
      shipping_cost: {...calculation().shipping_cost, amount_tax: 0},
      tax_breakdown: [{
        ...calculation().tax_breakdown[0],
        amount: 0,
        tax_rate_details: {...calculation().tax_breakdown[0].tax_rate_details, percentage_decimal: '0.0'},
        taxability_reason
      }]
    });
    const worker = createTaxSandboxWorker({now: () => NOW, fetchImpl: async () => jsonResponse(responseBody)});
    const result = await invoke(worker);
    assert.equal(result.response.status, 409);
    assert.equal(result.body.code, 'TAX_COLLECTION_NOT_READY');
  }
});

test('accepts a fully reconciled legitimate zero-rated Stripe result', async () => {
  const responseBody = calculation({
    amount_total: 4750,
    tax_amount_exclusive: 0,
    line_items: {
      ...calculation().line_items,
      data: calculation().line_items.data.map((line) => ({...line, amount_tax: 0}))
    },
    shipping_cost: {...calculation().shipping_cost, amount_tax: 0},
    tax_breakdown: [{
      ...calculation().tax_breakdown[0],
      amount: 0,
      tax_rate_details: {...calculation().tax_breakdown[0].tax_rate_details, percentage_decimal: '0.0'},
      taxability_reason: 'zero_rated'
    }]
  });
  const worker = createTaxSandboxWorker({now: () => NOW, fetchImpl: async () => jsonResponse(responseBody)});
  const result = await invoke(worker);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.tax_cents, 0);
  assert.equal(result.body.breakdown.rates[0].rate, 0);
  assert.equal(result.body.breakdown.rates[0].taxability_reason, 'zero_rated');
});

test('maps Stripe rejection, malformed content, and uncertain network outcomes to safe errors', async () => {
  const cases = [
    [async () => jsonResponse({error: {message: 'secret provider detail'}}, 400), 502, 'STRIPE_REQUEST_FAILED'],
    [async () => new Response('<html>bad gateway</html>', {status: 200, headers: {'content-type': 'text/html'}}), 502, 'STRIPE_RESPONSE_INVALID'],
    [async () => { throw new Error('connection reset'); }, 503, 'STRIPE_REQUEST_UNCERTAIN']
  ];
  for (const [fetchImpl, status, code] of cases) {
    const worker = createTaxSandboxWorker({now: () => NOW, fetchImpl});
    const result = await invoke(worker);
    assert.equal(result.response.status, status);
    assert.equal(result.body.code, code);
    assert.doesNotMatch(JSON.stringify(result.body), /secret provider detail|connection reset/);
  }
});

test('omits zero shipping and zero handling while preserving the exact taxable basis', async () => {
  const body = {
    ...INPUT,
    merchandise_cents: 4000,
    seller_shipping_cents: 0,
    seller_handling_cents: 0,
    taxable_basis_cents: 4000
  };
  let outbound;
  const responseBody = calculation({
    amount_total: 4265,
    tax_amount_exclusive: 265,
    line_items: {
      ...calculation().line_items,
      data: calculation().line_items.data.slice(0, 2),
      total_count: 2
    },
    shipping_cost: null,
    tax_breakdown: [{...calculation().tax_breakdown[0], amount: 265, taxable_amount: 4000}]
  });
  const worker = createTaxSandboxWorker({now: () => NOW, fetchImpl: async (url, options) => {
    outbound = {url, options};
    return jsonResponse(responseBody);
  }});
  const result = await invoke(worker, body);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.taxable_basis_cents, 4000);
  assert.equal(outbound.options.body.has('shipping_cost[amount]'), false);
  assert.equal(outbound.options.body.has('line_items[2][amount]'), false);
});
