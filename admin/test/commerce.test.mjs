import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {
  getSettings, saveSettings, createQuote, beginCheckout, handlePaymentWebhook,
  listOrders, getOrder, updateTracking
} from '../src/commerce.js';

const migrationNames = [
  '0001_legacy_inventory.sql',
  '0002_private_image_objects.sql',
  '0003_revisioned_catalog.sql',
  '0004_settings_commands.sql'
];
const migrations = migrationNames.map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const sql of migrations) sqlite.exec(sql);
  const wrap = (sql, values = []) => ({
    bind(...next) {
      return wrap(sql, next.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
    },
    run() {
      const meta = sqlite.prepare(sql).run(...values);
      return {meta: {changes: Number(meta.changes), last_row_id: Number(meta.lastInsertRowid)}};
    },
    first() {
      return sqlite.prepare(sql).get(...values) ?? null;
    },
    all() {
      return {results: sqlite.prepare(sql).all(...values)};
    }
  });
  const DB = {
    prepare(sql) { return wrap(sql); },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql) {
      sqlite.exec(sql);
      return {count: 0};
    }
  };
  return {sqlite, DB};
}

const settingsPayload = (expectedVersion = 0, overrides = {}) => ({
  expected_version: expectedVersion,
  settings: {
    shipping_origin: {
      line1: '1 Studio Way', line2: null, city: 'New York', region: 'NY',
      postal_code: '10001', country_code: 'US'
    },
    destinations: [{id: 'US-NY', label: 'New York'}],
    shipping_services: [{id: 'ground', label: 'Ground'}],
    handling_amount_cents: 250,
    handling_scope: 'order',
    fulfillment_methods: ['shipping'],
    tax_status: 'configured',
    ...overrides
  },
  packing_profiles: [{
    id: 'packing-profile-0001', label: 'Artwork carton',
    length: 12, width: 10.5, height: 2.25, weight: 3, units: 'in_lb'
  }]
});

function seedArtwork(sqlite, stock = 1) {
  const artworkId = 'artwork-internal-0001';
  const revisionId = 'revision-published-0001';
  const baseConfiguration = 'configuration-base-0001';
  const frameConfiguration = 'configuration-frame-0001';
  sqlite.prepare('INSERT INTO catalog_artworks(id,stable_id) VALUES(?,?)').run(artworkId, 'art-001');
  sqlite.prepare(
    `INSERT INTO catalog_artwork_revisions(
       id,artwork_id,revision_number,source,title,description,category,base_price_cents,
       width_eighths,height_eighths,offered_for_sale,snapshot_json,content_hash,actor
     ) VALUES(?,?,1,'admin','Blue Heron','Original painting','Wildlife',10000,80,64,1,?,?,?)`
  ).run(revisionId, artworkId, JSON.stringify({title: 'Blue Heron'}), 'content-hash-000000000001', 'test');
  sqlite.prepare('INSERT INTO catalog_configurations(id,artwork_id) VALUES(?,?)').run(baseConfiguration, artworkId);
  sqlite.prepare('INSERT INTO catalog_configurations(id,artwork_id) VALUES(?,?)').run(frameConfiguration, artworkId);
  sqlite.prepare(
    'INSERT INTO catalog_revision_configurations(revision_id,configuration_id,label,enabled,price_add_on_cents,packing_profile_id,position) VALUES(?,?,?,1,?,?,?)'
  ).run(revisionId, baseConfiguration, 'Unframed', 0, 'packing-profile-0001', 0);
  sqlite.prepare(
    'INSERT INTO catalog_revision_configurations(revision_id,configuration_id,label,enabled,price_add_on_cents,packing_profile_id,position) VALUES(?,?,?,1,?,?,?)'
  ).run(revisionId, frameConfiguration, 'Walnut frame', 2500, 'packing-profile-0001', 1);
  sqlite.prepare(
    'INSERT INTO catalog_artwork_heads(artwork_id,working_revision_id,published_revision_id,last_published_revision_id,working_version) VALUES(?,?,?,?,1)'
  ).run(artworkId, revisionId, revisionId, revisionId);
  sqlite.prepare('INSERT INTO catalog_inventory(artwork_id,physical_stock) VALUES(?,?)').run(artworkId, stock);
  sqlite.prepare('INSERT INTO catalog_store_order(artwork_id,position) VALUES(?,0)').run(artworkId);
  return {artworkId, revisionId, baseConfiguration, frameConfiguration};
}

async function fixture({stock = 1, payment = true, packingStrategy = 'separate_packages'} = {}) {
  const state = d1();
  await saveSettings(state.DB, settingsPayload(), 'test');
  const config = {
    packing_strategy: packingStrategy,
    tax_registration_reference: 'ny-registration-1',
    payment_merchant_reference: 'merchant-test-1'
  };
  state.sqlite.prepare(
    'UPDATE catalog_store_settings SET payment_status=?,payment_mode=?,config_json=? WHERE id=1'
  ).run(payment ? 'sandbox' : 'missing', payment ? 'sandbox' : 'disabled', JSON.stringify(config));
  const catalog = seedArtwork(state.sqlite, stock);
  return {...state, ...catalog};
}

const address = (postalCode = '10002') => ({
  recipient: 'Buyer', line1: '2 Buyer Street', line2: null, city: 'New York',
  region: 'NY', postal_code: postalCode, country_code: 'US'
});

const quoteRequest = (configurationId = 'configuration-base-0001', overrides = {}) => ({
  items: [{artwork_id: 'art-001', configuration_id: configurationId, quantity: 1}],
  delivery_address: address(),
  shipping_service_id: 'ground',
  ...overrides
});

function providerEnvironment() {
  const calls = {shipping: [], tax: [], sessions: [], verifies: []};
  const environment = {
    PAYMENT_PROVIDER_NAME: 'testpay',
    SHIPPING_PROVIDER: {
      async fetch(request) {
        const body = await request.json();
        calls.shipping.push(body);
        return Response.json({currency: 'USD', shipping_cents: 1000, service_reference: 'ship-rate-1'});
      }
    },
    TAX_PROVIDER: {
      async fetch(request) {
        const body = await request.json();
        calls.tax.push(body);
        return Response.json({
          currency: 'USD', tax_cents: 999, taxable_basis_cents: body.taxable_basis_cents,
          breakdown: {
            jurisdiction: 'New York City', jurisdiction_code: 'US-NY-NYC',
            rates: [{name: 'combined', rate_basis_points: 887.5}],
            source_reference: 'tax-source-1', calculated_at: '2026-11-20T12:00:00Z'
          }
        });
      }
    },
    PAYMENT_PROVIDER: {
      event: null,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/sessions') {
          const body = await request.json();
          calls.sessions.push(body);
          return Response.json({
            session_id: `session-${body.order_id}`,
            hosted_url: `https://checkout.example.test/${body.order_id}`,
            order_id: body.order_id,
            amount_cents: body.amount_cents,
            currency: body.currency,
            mode: body.mode,
            merchant_reference: body.merchant_reference
          });
        }
        const raw = await request.text();
        calls.verifies.push({headers: Object.fromEntries(request.headers), raw});
        return Response.json(this.event || {verified: false});
      }
    }
  };
  return {environment, calls};
}

function paymentEvent(order, overrides = {}) {
  return {
    verified: true,
    provider: 'testpay',
    event_id: 'event-paid-0001',
    order_id: order.order_id,
    event_type: 'payment.completed',
    status: 'paid',
    amount_cents: order.amount_cents,
    currency: 'USD',
    merchant_reference: 'merchant-test-1',
    mode: 'sandbox',
    occurred_at: 1_795_176_000,
    ...overrides
  };
}

const webhookRequest = (eventId = 'raw-event') => new Request('https://store.test/api/payment/webhook', {
  method: 'POST',
  headers: {'content-type': 'application/json', 'x-provider-signature': 'valid-test-signature'},
  body: JSON.stringify({event_id: eventId})
});

async function readyQuote(state, environment, overrides = {}, context = {now: 1_795_176_000}) {
  return createQuote(state.DB, quoteRequest('configuration-base-0001', overrides), environment, context);
}

async function checkedOut(state, environment, {quoteOverrides = {}, checkoutKey = 'checkout-key-0001'} = {}) {
  const quote = await readyQuote(state, environment, quoteOverrides);
  const checkout = await beginCheckout(state.DB, {
    quote_id: quote.quote_id,
    idempotency_key: checkoutKey
  }, environment, {now: 1_795_176_100});
  return {...checkout, quote, amount_cents: quote.grand_total_cents};
}

test('settings use UI shapes, preserve read-only payment state, and reject stale saves atomically', async () => {
  const {sqlite, DB} = d1();
  const saved = await saveSettings(DB, {
    ...settingsPayload(),
    settings: {...settingsPayload().settings, payment_status: 'live', payment_mode: 'live'}
  }, 'owner');
  assert.equal(saved.version, 1);
  assert.equal(saved.tax_status, 'verified');
  assert.equal(saved.settings.tax_status, 'configured');
  assert.equal(saved.payment_status, 'missing');
  assert.equal(saved.payment_mode, 'disabled');
  assert.equal(saved.packing_profiles[0].length, 12);
  assert.equal(saved.packing_profiles[0].width, 10.5);
  assert.equal(sqlite.prepare('SELECT length_value,width_value FROM catalog_packing_profiles').get().length_value, 12000);
  assert.equal(sqlite.prepare('SELECT width_value FROM catalog_packing_profiles').get().width_value, 10500);

  const stale = settingsPayload(0, {shipping_origin: {...settingsPayload().settings.shipping_origin, line1: 'Changed'}});
  stale.packing_profiles.push({id: 'packing-profile-stale', label: 'Stale', length: 1, width: 1, height: 1, weight: 1, units: 'in_lb'});
  await assert.rejects(() => saveSettings(DB, stale, 'stale-owner'), (error) => error.status === 409);
  const after = await getSettings(DB);
  assert.equal(after.version, 1);
  assert.equal(after.shipping_origin.line1, '1 Studio Way');
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM catalog_packing_profiles WHERE id='packing-profile-stale'").get().n, 0);
  assert.equal(sqlite.prepare("SELECT enabled FROM catalog_packing_profiles WHERE id='packing-profile-0001'").get().enabled, 1);

  const editedProfile = {...after.packing_profiles[0], length: 15, weight: 4, units: 'cm_kg'};
  const roundTripped = await saveSettings(DB, {
    expected_version: 1,
    settings: after.settings,
    packing_profiles: [editedProfile]
  }, 'owner');
  assert.equal(roundTripped.version, 2);
  assert.equal(roundTripped.packing_profiles[0].length, 15);
  assert.equal(roundTripped.packing_profiles[0].weight, 4);
  assert.equal(roundTripped.packing_profiles[0].units, 'cm_kg');
  assert.deepEqual(
    {...sqlite.prepare('SELECT length_value,weight_value,dimension_unit,weight_unit FROM catalog_packing_profiles').get()},
    {length_value: 15000, weight_value: 4000, dimension_unit: 'cm', weight_unit: 'kg'}
  );
});

test('an incomplete provider-neutral quote persists null unresolved totals and clear setup gaps', async () => {
  const state = await fixture();
  const quote = await createQuote(state.DB, quoteRequest(), {}, {now: 1_795_176_000});
  assert.equal(quote.status, 'incomplete');
  assert.equal(quote.shipping_cents, null);
  assert.equal(quote.handling_cents, null);
  assert.equal(quote.tax_cents, null);
  assert.equal(quote.grand_total_cents, null);
  assert.equal(quote.merchandise_subtotal_cents, 10000);
  assert.deepEqual(quote.shipping_services, [{id: 'ground', label: 'Ground'}]);
  assert.equal(quote.checkout_enabled, false);
  assert.equal(quote.checkout_status, 'Checkout not yet available');
  assert.deepEqual(new Set(quote.missing_setup), new Set(['shipping_provider', 'tax_provider']));
  const persisted = state.sqlite.prepare('SELECT status,shipping_cents,tax_cents,grand_total_cents,address_json FROM catalog_quotes WHERE id=?').get(quote.quote_id);
  assert.equal(persisted.status, 'incomplete');
  assert.equal(persisted.shipping_cents, null);
  assert.equal(persisted.tax_cents, null);
  assert.equal(persisted.grand_total_cents, null);
  assert.deepEqual(JSON.parse(persisted.address_json), address());
});

test('ready quotes use exact provider totals, taxable shipping/handling, idempotency, and settings invalidation', async () => {
  const state = await fixture();
  const {environment, calls} = providerEnvironment();
  const browserAddress = {...address()};
  browserAddress.country = browserAddress.country_code;
  delete browserAddress.country_code;
  const request = quoteRequest('configuration-base-0001', {idempotency_key: 'quote-key-0001', delivery_address: browserAddress});
  const quote = await createQuote(state.DB, request, environment, {now: 1_795_176_000});
  assert.equal(quote.status, 'ready');
  assert.equal(quote.merchandise_cents, 10000);
  assert.equal(quote.shipping_cents, 1000);
  assert.equal(quote.handling_cents, 250);
  assert.equal(quote.tax_cents, 999);
  assert.equal(quote.grand_total_cents, 12249);
  assert.equal(quote.checkout_enabled, true);
  assert.equal(calls.shipping.length, 1);
  assert.equal(calls.shipping[0].packages[0].value_scale, 1000);
  assert.equal(calls.tax[0].taxable_basis_cents, 11250);
  assert.equal(calls.tax[0].seller_shipping_cents, 1000);
  assert.equal(calls.tax[0].seller_handling_cents, 250);
  assert.equal(quote.tax_breakdown.jurisdiction_code, 'US-NY-NYC');
  assert.equal(quote.tax_breakdown.taxable_basis_cents, 11250);

  const duplicate = await createQuote(state.DB, request, environment, {now: 1_795_176_010});
  assert.equal(duplicate.quote_id, quote.quote_id);
  assert.equal(calls.shipping.length, 1);
  await assert.rejects(() => createQuote(state.DB, {
    ...request,
    delivery_address: address('10003')
  }, environment, {now: 1_795_176_010}), (error) => error.status === 409);
  await assert.rejects(
    () => createQuote(state.DB, request, environment, {now: 1_795_176_901}),
    /idempotent quote expired/i
  );

  state.sqlite.prepare('UPDATE catalog_store_settings SET version=version+1 WHERE id=1').run();
  await assert.rejects(() => beginCheckout(state.DB, {
    quote_id: quote.quote_id,
    idempotency_key: 'checkout-settings-stale'
  }, environment, {now: 1_795_176_100}), /settings changed/i);
  assert.equal(state.sqlite.prepare('SELECT count(*) AS n FROM catalog_orders').get().n, 0);
});

test('shared physical stock is aggregated across frame choices and multi-unit shipping needs an explicit strategy', async () => {
  const one = await fixture({stock: 1});
  const providers = providerEnvironment();
  await assert.rejects(() => createQuote(one.DB, quoteRequest('configuration-base-0001', {
    items: [
      {artwork_id: 'art-001', configuration_id: 'configuration-base-0001', quantity: 1},
      {artwork_id: 'art-001', configuration_id: 'configuration-frame-0001', quantity: 1}
    ]
  }), providers.environment), /shared artwork stock/i);
  assert.equal(one.sqlite.prepare('SELECT count(*) AS n FROM catalog_quotes').get().n, 0);

  const noStrategy = await fixture({stock: 2, packingStrategy: null});
  const quote = await createQuote(noStrategy.DB, quoteRequest('configuration-base-0001', {
    items: [{artwork_id: 'art-001', configuration_id: 'configuration-base-0001', quantity: 2}]
  }), providers.environment);
  assert.equal(quote.status, 'incomplete');
  assert.equal(quote.shipping_cents, null);
  assert.equal(quote.grand_total_cents, null);
  assert(quote.missing_setup.includes('multi_item_packing_strategy'));
  assert.equal(providers.calls.shipping.length, 0);
});

test('checkout is idempotent, aggregates reservations, and never trusts a provider redirect alone', async () => {
  const state = await fixture({stock: 3});
  const {environment, calls} = providerEnvironment();
  const first = await checkedOut(state, environment, {quoteOverrides: {
    items: [
      {artwork_id: 'art-001', configuration_id: 'configuration-base-0001', quantity: 1},
      {artwork_id: 'art-001', configuration_id: 'configuration-frame-0001', quantity: 1}
    ]
  }});
  assert.equal(first.payment_status, 'pending');
  assert.equal(first.checkout_url, first.hosted_url);
  assert.match(first.hosted_url, /^https:\/\/checkout\.example\.test\//);
  const duplicate = await beginCheckout(state.DB, {
    quote_id: first.quote.quote_id,
    idempotency_key: 'checkout-key-0001'
  }, environment, {now: 1_795_176_120});
  assert.equal(duplicate.order_id, first.order_id);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.checkout_url, first.checkout_url);
  assert.equal(calls.sessions.length, 1);
  assert.equal(state.sqlite.prepare('SELECT count(*) AS n FROM catalog_orders').get().n, 1);
  assert.equal(state.sqlite.prepare('SELECT count(*) AS n FROM catalog_inventory_reservations').get().n, 1);
  assert.equal(state.sqlite.prepare('SELECT quantity FROM catalog_inventory_reservations').get().quantity, 2);
  assert.equal(state.sqlite.prepare('SELECT reserved_stock FROM catalog_inventory').get().reserved_stock, 2);
  assert.equal(state.sqlite.prepare('SELECT payment_status FROM catalog_orders').get().payment_status, 'pending');

  const otherQuote = await readyQuote(state, environment, {idempotency_key: 'quote-key-other'});
  await assert.rejects(() => beginCheckout(state.DB, {
    quote_id: otherQuote.quote_id,
    idempotency_key: 'checkout-key-0001'
  }, environment), (error) => error.status === 409);
});

test('verified payment webhooks commit once, deduplicate events, and support protected order/tracking views', async () => {
  const state = await fixture();
  const {environment} = providerEnvironment();
  const checkout = await checkedOut(state, environment);
  environment.PAYMENT_PROVIDER.event = paymentEvent(checkout);
  state.sqlite.prepare(
    "UPDATE catalog_store_settings SET version=version+1,payment_status='live',payment_mode='live',config_json=? WHERE id=1"
  ).run(JSON.stringify({packing_strategy: 'separate_packages', payment_merchant_reference: 'rotated-merchant'}));
  const first = await handlePaymentWebhook(state.DB, webhookRequest('paid-1'), environment, {now: 1_795_176_200});
  assert.deepEqual(first, {accepted: true, duplicate: false, manual_review: false});
  assert.deepEqual({...state.sqlite.prepare('SELECT physical_stock,reserved_stock FROM catalog_inventory').get()}, {physical_stock: 0, reserved_stock: 0});
  assert.equal(state.sqlite.prepare('SELECT state FROM catalog_inventory_reservations').get().state, 'committed');
  assert.equal(state.sqlite.prepare('SELECT payment_status FROM catalog_orders').get().payment_status, 'paid');

  const duplicate = await handlePaymentWebhook(state.DB, webhookRequest('paid-1-retry'), environment, {now: 1_795_176_210});
  assert.deepEqual(duplicate, {accepted: true, duplicate: true});
  assert.deepEqual({...state.sqlite.prepare('SELECT physical_stock,reserved_stock FROM catalog_inventory').get()}, {physical_stock: 0, reserved_stock: 0});

  const listed = await listOrders(state.DB, {page: 1, status: 'paid'});
  assert.equal(listed.pagination.total_pages, 1);
  assert.equal(listed.items[0].total_cents, checkout.amount_cents);
  assert.equal(listed.items[0].lines[0].title, 'Blue Heron');
  assert.equal(listed.items[0].lines[0].configuration_label, 'Unframed');
  const tracked = await updateTracking(state.DB, checkout.order_id, {tracking: 'TRACK-0001'}, 'owner');
  assert.equal(tracked.tracking, 'TRACK-0001');
  assert.equal(tracked.fulfillment_status, 'unfulfilled');
  assert.equal((await getOrder(state.DB, checkout.order_id)).tracking, 'TRACK-0001');
});

test('failed payment releases once and a later verified success is manual review without overselling', async () => {
  const state = await fixture();
  const {environment} = providerEnvironment();
  const checkout = await checkedOut(state, environment);
  environment.PAYMENT_PROVIDER.event = paymentEvent(checkout, {
    event_id: 'event-failed-0001', event_type: 'payment.failed', status: 'failed'
  });
  await handlePaymentWebhook(state.DB, webhookRequest('failed-1'), environment);
  assert.deepEqual({...state.sqlite.prepare('SELECT physical_stock,reserved_stock FROM catalog_inventory').get()}, {physical_stock: 1, reserved_stock: 0});
  assert.equal(state.sqlite.prepare('SELECT state FROM catalog_inventory_reservations').get().state, 'released');
  assert.equal(state.sqlite.prepare('SELECT payment_status FROM catalog_orders').get().payment_status, 'failed');
  assert.equal((await handlePaymentWebhook(state.DB, webhookRequest('failed-1-retry'), environment)).duplicate, true);

  environment.PAYMENT_PROVIDER.event = paymentEvent(checkout, {
    event_id: 'event-late-paid-0002', event_type: 'payment.completed', status: 'paid'
  });
  const late = await handlePaymentWebhook(state.DB, webhookRequest('late-paid-2'), environment);
  assert.equal(late.manual_review, true);
  assert.deepEqual({...state.sqlite.prepare('SELECT physical_stock,reserved_stock FROM catalog_inventory').get()}, {physical_stock: 1, reserved_stock: 0});
  assert.equal(state.sqlite.prepare('SELECT state FROM catalog_inventory_reservations').get().state, 'released');
  assert.equal(state.sqlite.prepare('SELECT payment_status FROM catalog_orders').get().payment_status, 'session_uncertain');
  assert.equal(state.sqlite.prepare("SELECT count(*) AS n FROM catalog_audit_events WHERE action='late_payment_manual_review'").get().n, 1);
});

test('expired quotes and uncertain hosted sessions create no unsafe release or false payment success', async () => {
  const expiredState = await fixture();
  const providers = providerEnvironment();
  const quote = await readyQuote(expiredState, providers.environment, {}, {now: 1_795_176_000});
  await assert.rejects(() => beginCheckout(expiredState.DB, {
    quote_id: quote.quote_id,
    idempotency_key: 'checkout-expired-0001'
  }, providers.environment, {now: 1_795_176_901}), /expired/i);
  assert.equal(expiredState.sqlite.prepare('SELECT count(*) AS n FROM catalog_orders').get().n, 0);

  const uncertainState = await fixture();
  const uncertainProviders = providerEnvironment();
  uncertainProviders.environment.PAYMENT_PROVIDER.fetch = async (request) => {
    if (new URL(request.url).pathname === '/sessions') throw new Error('provider timeout');
    return Response.json({verified: false});
  };
  const uncertainQuote = await readyQuote(uncertainState, uncertainProviders.environment);
  await assert.rejects(() => beginCheckout(uncertainState.DB, {
    quote_id: uncertainQuote.quote_id,
    idempotency_key: 'checkout-timeout-0001'
  }, uncertainProviders.environment, {now: 1_795_176_100}), /outcome is uncertain/i);
  assert.equal(uncertainState.sqlite.prepare('SELECT payment_status FROM catalog_orders').get().payment_status, 'session_uncertain');
  assert.equal(uncertainState.sqlite.prepare('SELECT state FROM catalog_inventory_reservations').get().state, 'active');
  assert.equal(uncertainState.sqlite.prepare('SELECT reserved_stock FROM catalog_inventory').get().reserved_stock, 1);

  const redirectState = await fixture();
  const redirectProviders = providerEnvironment();
  redirectProviders.environment.PAYMENT_PROVIDER.fetch = async (request) => {
    const body = await request.json();
    return Response.json({
      session_id: `session-${body.order_id}`,
      hosted_url: 'http://unverified.example.test/checkout',
      order_id: body.order_id,
      amount_cents: body.amount_cents,
      currency: body.currency,
      mode: body.mode,
      merchant_reference: body.merchant_reference
    });
  };
  const redirectQuote = await readyQuote(redirectState, redirectProviders.environment);
  await assert.rejects(() => beginCheckout(redirectState.DB, {
    quote_id: redirectQuote.quote_id,
    idempotency_key: 'checkout-redirect-0001'
  }, redirectProviders.environment, {now: 1_795_176_100}), /outcome is uncertain/i);
  assert.equal(redirectState.sqlite.prepare('SELECT payment_status FROM catalog_orders').get().payment_status, 'session_uncertain');
  assert.equal(redirectState.sqlite.prepare('SELECT state FROM catalog_inventory_reservations').get().state, 'active');
});

test('unverified or mismatched webhook payloads cannot change orders', async () => {
  const state = await fixture();
  const {environment} = providerEnvironment();
  const checkout = await checkedOut(state, environment);
  environment.PAYMENT_PROVIDER.event = paymentEvent(checkout, {verified: false});
  await assert.rejects(() => handlePaymentWebhook(state.DB, webhookRequest('unverified'), environment), (error) => error.status === 401);
  assert.equal(state.sqlite.prepare('SELECT payment_status FROM catalog_orders').get().payment_status, 'pending');
  assert.equal(state.sqlite.prepare('SELECT reserved_stock FROM catalog_inventory').get().reserved_stock, 1);

  environment.PAYMENT_PROVIDER.event = paymentEvent(checkout, {event_id: 'event-wrong-amount', amount_cents: checkout.amount_cents + 1});
  await assert.rejects(() => handlePaymentWebhook(state.DB, webhookRequest('wrong-amount'), environment), (error) => error.status === 409);
  assert.equal(state.sqlite.prepare('SELECT count(*) AS n FROM catalog_payment_events').get().n, 0);
  assert.equal(state.sqlite.prepare('SELECT payment_status FROM catalog_orders').get().payment_status, 'pending');
});
