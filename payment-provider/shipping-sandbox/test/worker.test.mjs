import test from 'node:test';
import assert from 'node:assert/strict';
import {createShippingSandboxWorker} from '../src/index.js';

const worker = createShippingSandboxWorker();
const env = {
  SHIPPING_MODE: 'sandbox',
  SANDBOX_SERVICE_RATES_JSON: JSON.stringify({
    TEST_GROUND: {base_cents: 300, per_parcel_cents: 200, per_item_cents: 50},
    TEST_PICKUP: {base_cents: 0, per_parcel_cents: 0, per_item_cents: 0}
  })
};

const address = (region = 'NJ') => ({line1: '1 Test Way', line2: null, city: 'Testville', region, postal_code: '07001', country_code: 'US'});
const pack = (quantity = 1) => ({
  artwork_id: 'art-0001', configuration_id: 'config-0001', quantity,
  id: 'packing-0001', label: 'Test carton',
  length_value: 12000, width_value: 10000, height_value: 3000, dimension_unit: 'in',
  weight_value: 2000, weight_unit: 'lb', value_scale: 1000
});
const input = (overrides = {}) => ({
  currency: 'USD', origin: address(), destination: address('NY'), service_code: 'TEST_GROUND',
  packages: [pack()], packing_strategy: 'single_package', ...overrides
});
const request = (body, options = {}) => new Request(options.url || 'https://shipping.internal/quote', {
  method: options.method || 'POST',
  headers: {'content-type': options.type || 'application/json'},
  body: options.method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
});

test('quotes one sandbox parcel deterministically with an opaque reference', async () => {
  const first = await worker.fetch(request(input()), env);
  const second = await worker.fetch(request(input()), env);
  assert.equal(first.status, 200);
  const a = await first.json();
  const b = await second.json();
  assert.equal(a.shipping_cents, 550);
  assert.equal(a.currency, 'USD');
  assert.equal(a.sandbox, true);
  assert.match(a.service_reference, /^sandbox:TEST_GROUND:[a-f0-9]{24}$/);
  assert.equal(a.service_reference, b.service_reference);
  assert.doesNotMatch(a.service_reference, /Testville|07001/);
});

test('separate-package rate accounts for every unit and parcel', async () => {
  const response = await worker.fetch(request(input({packages: [pack(2), {...pack(3), artwork_id: 'art-0002'}], packing_strategy: 'separate_packages'})), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).shipping_cents, 1550);
});

test('single-package mode rejects multiple units instead of underquoting', async () => {
  const response = await worker.fetch(request(input({packages: [pack(2)]})), env);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'PACKING_STRATEGY_MISMATCH');
});

test('unknown service and live mode fail closed', async () => {
  const unknown = await worker.fetch(request(input({service_code: 'REAL_CARRIER'})), env);
  assert.equal(unknown.status, 409);
  const live = await worker.fetch(request(input()), {...env, SHIPPING_MODE: 'live'});
  assert.equal(live.status, 503);
  assert.equal((await live.json()).code, 'CONFIGURATION_ERROR');
});

test('malformed rate configuration fails closed', async () => {
  for (const value of ['{}', '{', JSON.stringify({TEST_GROUND: {base_cents: -1, per_parcel_cents: 2, per_item_cents: 3.5}})]) {
    const response = await worker.fetch(request(input()), {...env, SANDBOX_SERVICE_RATES_JSON: value});
    assert.equal(response.status, 503);
  }
});

test('currency, addresses, quantities, dimensions, and units are validated', async () => {
  const invalid = [
    input({currency: 'EUR'}),
    input({service_code: 'bad service'}),
    input({packing_strategy: 'consolidated'}),
    input({destination: {...address(), country_code: 'usa'}}),
    input({origin: {...address(), recipient: ''}}),
    input({packages: [pack(0)]}),
    input({packages: [{...pack(), label: ''}]}),
    input({packages: [{...pack(), length_value: 0}]}),
    input({packages: [{...pack(), weight_unit: 'stone'}]}),
    input({packages: [{...pack(), value_scale: 1}]})
  ];
  for (const body of invalid) assert.equal((await worker.fetch(request(body), env)).status, 400);
});

test('route, method, query, content type, and JSON object are strict', async () => {
  assert.equal((await worker.fetch(request(input(), {url: 'https://other.internal/quote'}), env)).status, 404);
  assert.equal((await worker.fetch(request(input(), {url: 'http://shipping.internal/quote'}), env)).status, 404);
  assert.equal((await worker.fetch(request(input(), {url: 'https://shipping.internal:8443/quote'}), env)).status, 404);
  assert.equal((await worker.fetch(request(input(), {url: 'https://shipping.internal/quote?x=1'}), env)).status, 404);
  assert.equal((await worker.fetch(request(null, {method: 'GET'}), env)).status, 404);
  assert.equal((await worker.fetch(request(input(), {type: 'text/plain'}), env)).status, 415);
  assert.equal((await worker.fetch(request('[]'), env)).status, 400);
});

test('zero-cost pickup remains explicit sandbox data', async () => {
  const response = await worker.fetch(request(input({service_code: 'TEST_PICKUP'})), env);
  const result = await response.json();
  assert.equal(result.shipping_cents, 0);
  assert.match(result.service_reference, /^sandbox:TEST_PICKUP:/);
});
