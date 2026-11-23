import test from 'node:test';
import assert from 'node:assert/strict';
import {createStripeWorker} from '../src/index.js';

const NOW = 1_795_315_200;
const ENV = Object.freeze({
  STRIPE_MODE: 'sandbox',
  STRIPE_SECRET_KEY: 'sk_test_unit_only_not_a_real_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_unit_only_not_a_real_secret',
  STRIPE_MERCHANT_REFERENCE: 'acct_test_nyahsark',
  STRIPE_API_VERSION: '2026-11-18.endive',
  STRIPE_RETURN_ORIGIN: 'https://nyahsark.com'
});

const SESSION_INPUT = Object.freeze({
  order_id: '4dd7ea13-6b5f-4e44-ae74-69fbca2396b7',
  order_number: 'NYA-20261122-4DD7EA13',
  quote_id: '7e01dd42-214c-451e-8532-70093f0cdd20',
  amount_cents: 4250,
  currency: 'USD',
  mode: 'sandbox',
  merchant_reference: 'acct_test_nyahsark',
  idempotency_key: 'checkout-unit-0001',
  return_reference: '4dd7ea13-6b5f-4e44-ae74-69fbca2396b7'
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
}

function session(overrides = {}) {
  return {
    id: 'cs_test_session0001',
    url: 'https://checkout.stripe.com/c/pay/cs_test_session0001',
    livemode: false,
    mode: 'payment',
    status: 'open',
    amount_total: 4250,
    currency: 'usd',
    client_reference_id: SESSION_INPUT.order_id,
    metadata: {
      order_id: SESSION_INPUT.order_id,
      order_number: SESSION_INPUT.order_number,
      quote_id: SESSION_INPUT.quote_id,
      merchant_reference: SESSION_INPUT.merchant_reference,
      mode: 'sandbox'
    },
    ...overrides
  };
}

async function providerJson(worker, path, body, env = ENV, headers = {}) {
  const response = await worker.fetch(new Request(`https://payment.internal${path}`, {
    method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: typeof body === 'string' ? body : JSON.stringify(body)
  }), env);
  return {response, body: await response.json()};
}

async function signature(secret, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function signedWebhook(worker, event, {secret = ENV.STRIPE_WEBHOOK_SECRET, timestamp = NOW, body = JSON.stringify(event)} = {}) {
  const digest = await signature(secret, timestamp, body);
  return providerJson(worker, '/webhooks/verify', body, ENV, {'stripe-signature': `t=${timestamp},v1=${digest}`});
}

function paidEvent(overrides = {}) {
  return {
    id: 'evt_checkout_paid_0001',
    livemode: false,
    created: NOW - 1,
    type: 'checkout.session.completed',
    data: {object: {
      id: 'cs_test_session0001',
      livemode: false,
      payment_status: 'paid',
      amount_total: 4250,
      currency: 'usd',
      client_reference_id: SESSION_INPUT.order_id,
      metadata: {
        order_id: SESSION_INPUT.order_id,
        merchant_reference: SESSION_INPUT.merchant_reference,
        mode: 'sandbox'
      }
    }},
    ...overrides
  };
}

test('creates an exact sandbox Checkout Session with Stripe idempotency and no caller-controlled URL', async () => {
  let outbound;
  const worker = createStripeWorker({now: () => NOW, fetchImpl: async (url, options) => {
    outbound = {url, options};
    return jsonResponse(session());
  }});
  const result = await providerJson(worker, '/sessions', SESSION_INPUT);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, {
    session_id: 'cs_test_session0001',
    hosted_url: 'https://checkout.stripe.com/c/pay/cs_test_session0001',
    order_id: SESSION_INPUT.order_id,
    amount_cents: 4250,
    currency: 'USD',
    mode: 'sandbox',
    merchant_reference: SESSION_INPUT.merchant_reference
  });
  assert.equal(outbound.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(outbound.options.headers.get('idempotency-key'), SESSION_INPUT.idempotency_key);
  assert.equal(outbound.options.headers.get('stripe-version'), ENV.STRIPE_API_VERSION);
  const form = outbound.options.body;
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '4250');
  assert.equal(form.get('payment_method_types[0]'), 'card');
  assert.equal(form.get('expires_at'), String(NOW + 31 * 60));
  assert.equal(form.get('success_url'), 'https://nyahsark.com/cart.html?checkout=success&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(form.get('metadata[order_id]'), SESSION_INPUT.order_id);
  assert.equal(form.get('payment_intent_data[metadata][merchant_reference]'), SESSION_INPUT.merchant_reference);
});

test('fails closed for live mode, merchant mismatch, malformed money, or a live secret key', async () => {
  const worker = createStripeWorker({now: () => NOW, fetchImpl: async () => { throw new Error('must not dispatch'); }});
  for (const body of [
    {...SESSION_INPUT, mode: 'live'},
    {...SESSION_INPUT, merchant_reference: 'acct_other'},
    {...SESSION_INPUT, amount_cents: 42.5}
  ]) {
    const result = await providerJson(worker, '/sessions', body);
    assert.ok([400, 409].includes(result.response.status));
  }
  for (const secretKey of ['sk_live_forbidden', 'rk_live_forbidden', 'sk_test_bad key']) {
    const result = await providerJson(worker, '/sessions', SESSION_INPUT, {...ENV, STRIPE_SECRET_KEY: secretKey});
    assert.equal(result.response.status, 503);
  }
});

test('accepts a least-privilege restricted Stripe test key', async () => {
  const worker = createStripeWorker({now: () => NOW, fetchImpl: async () => jsonResponse(session())});
  const result = await providerJson(worker, '/sessions', SESSION_INPUT, {
    ...ENV,
    STRIPE_SECRET_KEY: 'rk_test_restricted_unit_only'
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.session_id, 'cs_test_session0001');
});

test('rejects a Stripe response with a foreign amount, merchant, mode, or hosted origin', async () => {
  for (const malformed of [
    session({amount_total: 4200}),
    session({url: 'https://evil.example/checkout'}),
    session({livemode: true}),
    session({metadata: {...session().metadata, merchant_reference: 'acct_other'}})
  ]) {
    const worker = createStripeWorker({now: () => NOW, fetchImpl: async () => jsonResponse(malformed)});
    const result = await providerJson(worker, '/sessions', SESSION_INPUT);
    assert.equal(result.response.status, 502);
  }
});

test('cancels an open Checkout Session only after retrieving and matching its order metadata', async () => {
  const calls = [];
  const worker = createStripeWorker({fetchImpl: async (url, options) => {
    calls.push({url, options});
    return calls.length === 1 ? jsonResponse(session()) : jsonResponse(session({status: 'expired', url: null}));
  }});
  const result = await providerJson(worker, '/sessions/cancel', {
    session_id: 'cs_test_session0001', order_id: SESSION_INPUT.order_id,
    reason: 'listing_compliance_changed', idempotency_key: 'cancel-unit-0001'
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.cancelled, true);
  assert.equal(result.body.idempotent, false);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions/cs_test_session0001');
  assert.equal(calls[1].url, 'https://api.stripe.com/v1/checkout/sessions/cs_test_session0001/expire');
  assert.equal(calls[1].options.headers.get('idempotency-key'), 'cancel-unit-0001');
});

test('treats an already expired owned Session as an idempotent cancellation', async () => {
  let calls = 0;
  const worker = createStripeWorker({fetchImpl: async () => { calls += 1; return jsonResponse(session({status: 'expired', url: null})); }});
  const result = await providerJson(worker, '/sessions/cancel', {
    session_id: 'cs_test_session0001', order_id: SESSION_INPUT.order_id,
    reason: 'payment_state_changed', idempotency_key: 'cancel-unit-0002'
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.idempotent, true);
  assert.equal(calls, 1);
});

test('refuses to expire completed or foreign Checkout Sessions', async () => {
  for (const value of [session({status: 'complete'}), session({metadata: {...session().metadata, order_id: 'other-order'}})]) {
    const worker = createStripeWorker({fetchImpl: async () => jsonResponse(value)});
    const result = await providerJson(worker, '/sessions/cancel', {
      session_id: 'cs_test_session0001', order_id: SESSION_INPUT.order_id,
      reason: 'payment_state_changed', idempotency_key: 'cancel-unit-0003'
    });
    assert.equal(result.response.status, 409);
  }
});

test('verifies the exact raw Stripe body and normalizes a settled Checkout event', async () => {
  const worker = createStripeWorker({now: () => NOW});
  const result = await signedWebhook(worker, paidEvent());
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, {
    verified: true,
    provider: 'stripe',
    event_id: 'evt_checkout_paid_0001',
    order_id: SESSION_INPUT.order_id,
    event_type: 'checkout.session.completed',
    status: 'paid',
    amount_cents: 4250,
    currency: 'USD',
    merchant_reference: SESSION_INPUT.merchant_reference,
    mode: 'sandbox',
    occurred_at: NOW - 1
  });
});

test('rejects invalid, stale, and body-mismatched Stripe signatures', async () => {
  const worker = createStripeWorker({now: () => NOW});
  const event = paidEvent();
  const body = JSON.stringify(event);
  const validDigest = await signature(ENV.STRIPE_WEBHOOK_SECRET, NOW, body);
  const cases = [
    {timestamp: NOW, header: `t=${NOW},v1=${'0'.repeat(64)}`, body},
    {timestamp: NOW - 301, header: `t=${NOW - 301},v1=${await signature(ENV.STRIPE_WEBHOOK_SECRET, NOW - 301, body)}`, body},
    {timestamp: NOW, header: `t=${NOW},v1=${validDigest}`, body: `${body} `}
  ];
  for (const item of cases) {
    const result = await providerJson(worker, '/webhooks/verify', item.body, ENV, {'stripe-signature': item.header});
    assert.equal(result.response.status, 401);
  }
});

test('normalizes supported terminal events and routes partial refunds to manual review', async () => {
  const worker = createStripeWorker({now: () => NOW});
  const examples = [
    ['checkout.session.async_payment_failed', {...paidEvent().data.object, payment_status: 'unpaid'}, 'failed'],
    ['checkout.session.expired', {...paidEvent().data.object, payment_status: 'unpaid'}, 'expired'],
    ['payment_intent.amount_capturable_updated', {livemode:false, amount:4250, currency:'usd', metadata:paidEvent().data.object.metadata}, 'authorized'],
    ['charge.refunded', {livemode:false, amount:4250, amount_refunded:4250, currency:'usd', metadata:paidEvent().data.object.metadata}, 'refunded']
  ];
  for (const [type, object, expected] of examples) {
    const event = paidEvent({id:`evt_${expected}_0001`, type, data:{object}});
    const result = await signedWebhook(worker, event);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, expected);
  }
  const partial = paidEvent({id:'evt_partial_0001', type:'charge.refunded', data:{object:{
    livemode:false, amount:4250, amount_refunded:1000, currency:'usd', metadata:paidEvent().data.object.metadata
  }}});
  const result = await signedWebhook(worker, partial);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.status, 'partial_refund');
  assert.equal(result.body.amount_cents, 4250);
  assert.equal(result.body.refunded_amount_cents, 1000);
});

test('does not convert a retryable PaymentIntent failure into a terminal Checkout failure', async () => {
  const worker = createStripeWorker({now: () => NOW});
  const event = paidEvent({
    id: 'evt_payment_intent_failed_0001',
    type: 'payment_intent.payment_failed',
    data: {object: {
      livemode: false,
      amount: 4250,
      currency: 'usd',
      metadata: paidEvent().data.object.metadata
    }}
  });
  const result = await signedWebhook(worker, event);
  assert.equal(result.response.status, 422);
  assert.equal(result.body.code, 'EVENT_UNSUPPORTED');
});

test('requires POST, exact routes, JSON for internal calls, and a verified settled event', async () => {
  const worker = createStripeWorker({now: () => NOW, fetchImpl: async () => jsonResponse(session())});
  const get = await worker.fetch(new Request('https://payment.internal/sessions'), ENV);
  assert.equal(get.status, 405);
  for (const url of [
    'http://payment.internal/sessions',
    'https://foreign.internal/sessions',
    'https://payment.internal:8443/sessions',
    'https://payment.internal/sessions?debug=1'
  ]) {
    const response = await worker.fetch(new Request(url, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(SESSION_INPUT)
    }), ENV);
    assert.equal(response.status, 404);
  }
  const missing = await providerJson(worker, '/unknown', {});
  assert.equal(missing.response.status, 404);
  const text = await worker.fetch(new Request('https://payment.internal/sessions', {method:'POST', headers:{'content-type':'text/plain'}, body:'{}'}), ENV);
  assert.equal(text.status, 415);
  const unpaid = paidEvent({data:{object:{...paidEvent().data.object, payment_status:'unpaid'}}});
  const unsettled = await signedWebhook(worker, unpaid);
  assert.equal(unsettled.response.status, 422);
});
