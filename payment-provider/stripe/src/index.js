const MAX_JSON_BYTES = 64 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_MONEY_CENTS = 100_000_000;
const WEBHOOK_TOLERANCE_SECONDS = 300;
const STRIPE_API_ORIGIN = 'https://api.stripe.com';
const STRIPE_API_ROOT = `${STRIPE_API_ORIGIN}/v1`;
const CHECKOUT_ORIGIN = 'https://checkout.stripe.com';

class ProviderError extends Error {
  constructor(status, message, code = 'PAYMENT_PROVIDER_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label, maximum, pattern = null) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || (pattern && !pattern.test(value))) {
    throw new ProviderError(400, `${label} is invalid`, 'INVALID_REQUEST');
  }
  return value;
}

async function bodyBytes(request, maximum) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new ProviderError(413, 'Request body is too large', 'BODY_TOO_LARGE');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw new ProviderError(400, 'Request body is required', 'INVALID_REQUEST');
  if (bytes.length > maximum) throw new ProviderError(413, 'Request body is too large', 'BODY_TOO_LARGE');
  return bytes;
}

async function readJson(request) {
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ProviderError(415, 'JSON is required', 'INVALID_CONTENT_TYPE');
  const bytes = await bodyBytes(request, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!isObject(value)) throw new Error('object required');
    return value;
  } catch {
    throw new ProviderError(400, 'JSON body is invalid', 'INVALID_REQUEST');
  }
}

function configuration(env) {
  if (env?.STRIPE_MODE !== 'sandbox') throw new ProviderError(503, 'Stripe sandbox is not configured', 'CONFIGURATION_ERROR');
  const secretKey = requiredString(env.STRIPE_SECRET_KEY, 'Stripe secret key', 256);
  if (!/^(?:rk|sk)_test_[A-Za-z0-9_]+$/.test(secretKey)) throw new ProviderError(503, 'Stripe sandbox is not configured', 'CONFIGURATION_ERROR');
  const webhookSecret = requiredString(env.STRIPE_WEBHOOK_SECRET, 'Stripe webhook secret', 256);
  if (!webhookSecret.startsWith('whsec_')) throw new ProviderError(503, 'Stripe sandbox is not configured', 'CONFIGURATION_ERROR');
  const merchantReference = requiredString(env.STRIPE_MERCHANT_REFERENCE, 'Stripe merchant reference', 200, /^[A-Za-z0-9_.:-]+$/);
  const apiVersion = requiredString(env.STRIPE_API_VERSION, 'Stripe API version', 80, /^\d{4}-\d{2}-\d{2}\.[a-z]+$/);
  let returnOrigin;
  try { returnOrigin = new URL(env.STRIPE_RETURN_ORIGIN); }
  catch { throw new ProviderError(503, 'Stripe sandbox is not configured', 'CONFIGURATION_ERROR'); }
  if (returnOrigin.protocol !== 'https:' || returnOrigin.username || returnOrigin.password || returnOrigin.origin !== returnOrigin.href.replace(/\/$/, '')) {
    throw new ProviderError(503, 'Stripe sandbox is not configured', 'CONFIGURATION_ERROR');
  }
  return {secretKey, webhookSecret, merchantReference, apiVersion, returnOrigin: returnOrigin.origin};
}

function validateSessionInput(input, config) {
  const payload = {
    order_id: requiredString(input.order_id, 'Order identifier', 120, /^[A-Za-z0-9-]+$/),
    order_number: requiredString(input.order_number, 'Order number', 80, /^[A-Za-z0-9-]+$/),
    quote_id: requiredString(input.quote_id, 'Quote identifier', 120, /^[A-Za-z0-9-]+$/),
    merchant_reference: requiredString(input.merchant_reference, 'Merchant reference', 200, /^[A-Za-z0-9_.:-]+$/),
    idempotency_key: requiredString(input.idempotency_key, 'Idempotency key', 160, /^[\x21-\x7e]+$/),
    return_reference: requiredString(input.return_reference, 'Return reference', 120, /^[A-Za-z0-9-]+$/),
    amount_cents: input.amount_cents,
    currency: input.currency,
    mode: input.mode
  };
  if (payload.idempotency_key.length < 8 || payload.return_reference !== payload.order_id) throw new ProviderError(400, 'Payment session request is invalid', 'INVALID_REQUEST');
  if (!Number.isInteger(payload.amount_cents) || payload.amount_cents < 1 || payload.amount_cents > MAX_MONEY_CENTS) throw new ProviderError(400, 'Payment amount is invalid', 'INVALID_REQUEST');
  if (payload.currency !== 'USD' || payload.mode !== 'sandbox' || payload.merchant_reference !== config.merchantReference) {
    throw new ProviderError(409, 'Payment session does not match the configured sandbox merchant', 'MERCHANT_MISMATCH');
  }
  return payload;
}

async function stripeResponse(response) {
  const text = await response.text();
  if (text.length > 256 * 1024) throw new ProviderError(502, 'Stripe returned an invalid response', 'STRIPE_RESPONSE_INVALID');
  let value;
  try { value = JSON.parse(text); }
  catch { throw new ProviderError(502, 'Stripe returned an invalid response', 'STRIPE_RESPONSE_INVALID'); }
  if (!response.ok) throw new ProviderError(502, 'Stripe rejected the provider request', 'STRIPE_REQUEST_FAILED');
  if (!isObject(value)) throw new ProviderError(502, 'Stripe returned an invalid response', 'STRIPE_RESPONSE_INVALID');
  return value;
}

function requestHeaders(config, idempotencyKey = null) {
  const headers = new Headers({
    authorization: `Bearer ${config.secretKey}`,
    'content-type': 'application/x-www-form-urlencoded',
    'stripe-version': config.apiVersion
  });
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  return headers;
}

async function stripeRequest(fetchImpl, config, path, {method = 'GET', body = null, idempotencyKey = null} = {}) {
  const url = new URL(`${STRIPE_API_ROOT}${path}`);
  if (url.origin !== STRIPE_API_ORIGIN || !url.pathname.startsWith('/v1/')) throw new ProviderError(500, 'Stripe request path is invalid', 'INTERNAL_ERROR');
  let response;
  try {
    response = await fetchImpl(url.href, {
      method,
      headers: requestHeaders(config, idempotencyKey),
      body,
      redirect: 'error',
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined
    });
  } catch {
    throw new ProviderError(503, 'Stripe request outcome is uncertain', 'STRIPE_REQUEST_UNCERTAIN');
  }
  return stripeResponse(response);
}

function metadataParameters(parameters, prefix, payload) {
  for (const key of ['order_id','order_number','quote_id','merchant_reference','mode']) parameters.set(`${prefix}[${key}]`, String(payload[key]));
}

async function createSession(input, env, fetchImpl, now) {
  const config = configuration(env);
  const payload = validateSessionInput(input, config);
  const parameters = new URLSearchParams();
  parameters.set('mode', 'payment');
  parameters.set('client_reference_id', payload.order_id);
  parameters.set('success_url', `${config.returnOrigin}/cart.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  parameters.set('cancel_url', `${config.returnOrigin}/cart.html?checkout=cancelled`);
  parameters.set('expires_at', String(now() + 31 * 60));
  parameters.set('billing_address_collection', 'required');
  parameters.set('submit_type', 'pay');
  parameters.set('payment_method_types[0]', 'card');
  parameters.set('line_items[0][quantity]', '1');
  parameters.set('line_items[0][price_data][currency]', 'usd');
  parameters.set('line_items[0][price_data][unit_amount]', String(payload.amount_cents));
  parameters.set('line_items[0][price_data][product_data][name]', `Nyah's Ark order ${payload.order_number}`);
  metadataParameters(parameters, 'metadata', payload);
  metadataParameters(parameters, 'payment_intent_data[metadata]', payload);
  const session = await stripeRequest(fetchImpl, config, '/checkout/sessions', {
    method: 'POST', body: parameters, idempotencyKey: payload.idempotency_key
  });
  let hosted;
  try { hosted = new URL(session.url); }
  catch { hosted = null; }
  if (
    typeof session.id !== 'string' || !/^cs_test_[A-Za-z0-9_]+$/.test(session.id) ||
    !hosted || hosted.origin !== CHECKOUT_ORIGIN || hosted.username || hosted.password ||
    session.livemode !== false || session.mode !== 'payment' || session.status !== 'open' ||
    session.amount_total !== payload.amount_cents || session.currency !== 'usd' ||
    session.client_reference_id !== payload.order_id || !isObject(session.metadata) ||
    session.metadata.order_id !== payload.order_id || session.metadata.merchant_reference !== payload.merchant_reference ||
    session.metadata.order_number !== payload.order_number || session.metadata.quote_id !== payload.quote_id ||
    session.metadata.mode !== 'sandbox'
  ) throw new ProviderError(502, 'Stripe returned an invalid Checkout Session', 'STRIPE_RESPONSE_INVALID');
  return {
    session_id: session.id,
    hosted_url: hosted.href,
    order_id: payload.order_id,
    amount_cents: payload.amount_cents,
    currency: 'USD',
    mode: 'sandbox',
    merchant_reference: payload.merchant_reference
  };
}

function validateCancellation(input) {
  const sessionId = requiredString(input.session_id, 'Session identifier', 200, /^cs_test_[A-Za-z0-9_]+$/);
  const orderId = requiredString(input.order_id, 'Order identifier', 120, /^[A-Za-z0-9-]+$/);
  const idempotencyKey = requiredString(input.idempotency_key, 'Idempotency key', 160, /^[\x21-\x7e]+$/);
  requiredString(input.reason, 'Cancellation reason', 120, /^[A-Za-z0-9_.:-]+$/);
  if (idempotencyKey.length < 8) throw new ProviderError(400, 'Cancellation request is invalid', 'INVALID_REQUEST');
  return {sessionId, orderId, idempotencyKey};
}

function assertOwnedSession(session, expected, config) {
  if (
    session?.id !== expected.sessionId || session.livemode !== false || !isObject(session.metadata) ||
    session.metadata.order_id !== expected.orderId || session.metadata.mode !== 'sandbox' ||
    session.metadata.merchant_reference !== config.merchantReference
  ) throw new ProviderError(409, 'Checkout Session does not match the order', 'SESSION_MISMATCH');
}

async function cancelSession(input, env, fetchImpl) {
  const config = configuration(env);
  const expected = validateCancellation(input);
  const encoded = encodeURIComponent(expected.sessionId);
  let session = await stripeRequest(fetchImpl, config, `/checkout/sessions/${encoded}`);
  assertOwnedSession(session, expected, config);
  if (session.status === 'expired') return {cancelled: true, session_id: expected.sessionId, order_id: expected.orderId, idempotent: true};
  if (session.status !== 'open') throw new ProviderError(409, 'Checkout Session can no longer be cancelled', 'SESSION_NOT_CANCELLABLE');
  session = await stripeRequest(fetchImpl, config, `/checkout/sessions/${encoded}/expire`, {
    method: 'POST', body: new URLSearchParams(), idempotencyKey: expected.idempotencyKey
  });
  assertOwnedSession(session, expected, config);
  if (session.status !== 'expired') throw new ProviderError(502, 'Stripe did not confirm Checkout Session expiration', 'STRIPE_RESPONSE_INVALID');
  return {cancelled: true, session_id: expected.sessionId, order_id: expected.orderId, idempotent: false};
}

function signatureParts(header) {
  if (typeof header !== 'string' || header.length > 4096) throw new ProviderError(401, 'Stripe signature is invalid', 'SIGNATURE_INVALID');
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && timestamp === null && /^\d{1,16}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[a-f0-9]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (!Number.isSafeInteger(timestamp) || !signatures.length) throw new ProviderError(401, 'Stripe signature is invalid', 'SIGNATURE_INVALID');
  return {timestamp, signatures};
}

function hexBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function verifySignature(bytes, header, secret, now) {
  const {timestamp, signatures} = signatureParts(header);
  if (Math.abs(now() - timestamp) > WEBHOOK_TOLERANCE_SECONDS) throw new ProviderError(401, 'Stripe signature is stale', 'SIGNATURE_STALE');
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
  for (const signature of signatures) {
    if (await crypto.subtle.verify('HMAC', key, hexBytes(signature), signed)) return;
  }
  throw new ProviderError(401, 'Stripe signature is invalid', 'SIGNATURE_INVALID');
}

function normalizedEvent(event, config) {
  if (!isObject(event) || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_]+$/.test(event.id) || event.livemode !== false || !Number.isInteger(event.created)) {
    throw new ProviderError(400, 'Stripe event is invalid', 'EVENT_INVALID');
  }
  const object = event.data?.object;
  if (!isObject(object) || object.livemode !== false || !isObject(object.metadata)) throw new ProviderError(400, 'Stripe event is invalid', 'EVENT_INVALID');
  let status;
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (object.payment_status !== 'paid') throw new ProviderError(422, 'Stripe payment is not settled', 'EVENT_NOT_SETTLED');
    status = 'paid';
  } else if (event.type === 'checkout.session.async_payment_failed') status = 'failed';
  else if (event.type === 'checkout.session.expired' || event.type === 'payment_intent.canceled') status = 'expired';
  else if (event.type === 'payment_intent.succeeded') status = 'paid';
  else if (event.type === 'payment_intent.amount_capturable_updated') status = 'authorized';
  else if (event.type === 'charge.refunded') {
    if (
      !Number.isInteger(object.amount) || object.amount < 1 || object.amount > MAX_MONEY_CENTS ||
      !Number.isInteger(object.amount_refunded) || object.amount_refunded <= 0 || object.amount_refunded > object.amount
    ) {
      throw new ProviderError(400, 'Stripe refund event is invalid', 'EVENT_INVALID');
    }
    status = object.amount_refunded === object.amount ? 'refunded' : 'partial_refund';
  } else throw new ProviderError(422, 'Stripe event type is unsupported', 'EVENT_UNSUPPORTED');
  const amount = event.type.startsWith('checkout.session.') ? object.amount_total : object.amount;
  const orderId = object.metadata.order_id || object.client_reference_id;
  if (
    !Number.isInteger(amount) || amount < 0 || amount > MAX_MONEY_CENTS || object.currency !== 'usd' ||
    typeof orderId !== 'string' || !orderId || orderId.length > 120 ||
    object.metadata.merchant_reference !== config.merchantReference || object.metadata.mode !== 'sandbox'
  ) throw new ProviderError(409, 'Stripe event does not match the configured sandbox merchant', 'EVENT_MISMATCH');
  const normalized = {
    verified: true,
    provider: 'stripe',
    event_id: event.id,
    order_id: orderId,
    event_type: event.type,
    status,
    amount_cents: amount,
    currency: 'USD',
    merchant_reference: config.merchantReference,
    mode: 'sandbox',
    occurred_at: event.created
  };
  if (status === 'partial_refund') normalized.refunded_amount_cents = object.amount_refunded;
  return normalized;
}

async function verifyWebhook(request, env, now) {
  const config = configuration(env);
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ProviderError(415, 'Stripe webhook content type is invalid', 'INVALID_CONTENT_TYPE');
  const bytes = await bodyBytes(request, MAX_WEBHOOK_BYTES);
  await verifySignature(bytes, request.headers.get('stripe-signature'), config.webhookSecret, now);
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw new ProviderError(400, 'Stripe event JSON is invalid', 'EVENT_INVALID'); }
  return normalizedEvent(event, config);
}

export function createStripeWorker({fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000)} = {}) {
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        if (url.protocol !== 'https:' || url.hostname !== 'payment.internal' || url.port || url.search) {
          throw new ProviderError(404, 'Not found', 'NOT_FOUND');
        }
        if (request.method !== 'POST') throw new ProviderError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED');
        if (url.pathname === '/sessions') return json(await createSession(await readJson(request), env, fetchImpl, now));
        if (url.pathname === '/sessions/cancel') return json(await cancelSession(await readJson(request), env, fetchImpl));
        if (url.pathname === '/webhooks/verify') return json(await verifyWebhook(request, env, now));
        throw new ProviderError(404, 'Not found', 'NOT_FOUND');
      } catch (error) {
        const status = error instanceof ProviderError ? error.status : 500;
        const code = error instanceof ProviderError ? error.code : 'INTERNAL_ERROR';
        const message = error instanceof ProviderError ? error.message : 'Payment provider failed';
        return json({error: message, code}, status);
      }
    }
  };
}

export default createStripeWorker();
