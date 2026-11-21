export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const noStoreHeaders = {
  'Cache-Control': 'private, no-store, no-transform',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

export function json(value, status = 200, headers = {}) {
  return Response.json(value, {status, headers: {...noStoreHeaders, ...headers}});
}

export function publicJson(value, status = 200, headers = {}) {
  return Response.json(value, {
    status,
    headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}
  });
}

export async function readJson(request, limit = 256 * 1024) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON required');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Request is too large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) throw new HttpError(413, 'Request is too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function requireOrigin(request, expected) {
  const value = request.headers.get('Origin');
  if (value !== expected) throw new HttpError(403, 'Origin rejected');
}

export function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw Error('Invalid origin');
  return url.origin;
}

export function routeError(error) {
  if (error instanceof HttpError || Number.isInteger(error?.status)) {
    return json({
      error: error.message || 'Request failed',
      details: error.details,
      field_errors: error.details?.fields
    }, error.status || 500);
  }
  return json({error: 'Request could not be completed'}, 500);
}

export function assertInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `${label} is invalid`);
  return value;
}

const UNSAFE_TEXT_CHARACTERS = /[\p{Cf}\p{Cs}]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export function assertText(value, max, label, {allowBlank = false, status = 400} = {}) {
  if (typeof value !== 'string') throw new HttpError(status, `${label} is invalid`);
  const normalized = value.normalize('NFKC');
  if (normalized.length > max || UNSAFE_TEXT_CHARACTERS.test(normalized) || (!allowBlank && !normalized.trim())) {
    throw new HttpError(status, `${label} is invalid`);
  }
  return normalized;
}

