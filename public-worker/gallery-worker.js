const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_PUBLIC_BODY = 64 * 1024;

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'Content-Type': JSON_TYPE,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
});

function exactHttpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new Error('Invalid storefront origin');
  }
  return url.origin;
}

function publicRoute(pathname, method) {
  if (method === 'GET' && /^\/api\/catalog(?:\/[a-z0-9][a-z0-9-]{0,79})?$/.test(pathname)) {
    return 'catalog';
  }
  if (method === 'GET' && /^\/catalog-media\/[a-z0-9][a-z0-9_-]{0,99}\/(?:display|thumb)$/.test(pathname)) {
    return 'media';
  }
  if (method === 'POST' && pathname === '/api/cart/quote') return 'quote';
  if (method === 'POST' && pathname === '/api/checkout') return 'checkout';
  return null;
}

async function boundedJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    throw Object.assign(new Error('JSON required'), { status: 415 });
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PUBLIC_BODY) {
    throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_PUBLIC_BODY) {
    throw Object.assign(new Error(bytes.length ? 'Request too large' : 'JSON required'), { status: bytes.length ? 413 : 400 });
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('JSON object required'), { status: 400 });
  }
  return value;
}

function responseHeaders(upstream, route) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  const type = upstream.headers.get('content-type');
  if (type) headers.set('Content-Type', type);
  if (route === 'media') {
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  }
  return headers;
}

export async function proxyPublicRequest(request, env) {
  const url = new URL(request.url);
  const route = publicRoute(url.pathname, request.method);
  if (!route) return json({ error: 'Not found' }, 404);
  if (!env?.PUBLISHED_CATALOG?.fetch) return json({ error: 'Catalog temporarily unavailable' }, 503);

  let origin;
  try {
    origin = exactHttpsOrigin(env.CATALOG_PUBLIC_ORIGIN || env.GALLERY_ORIGIN || url.origin);
  } catch {
    return json({ error: 'Catalog temporarily unavailable' }, 503);
  }
  const target = new URL(url.pathname + (route === 'catalog' ? url.search : ''), origin);
  const headers = new Headers({ Accept: route === 'media' ? 'image/avif,image/webp,image/*,*/*;q=0.5' : 'application/json' });
  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method === 'POST') {
    try {
      init.body = JSON.stringify(await boundedJson(request));
      headers.set('Content-Type', 'application/json');
    } catch (error) {
      return json({ error: error.message }, error.status || 400);
    }
  }

  let upstream;
  try {
    upstream = await env.PUBLISHED_CATALOG.fetch(new Request(target, init));
  } catch {
    return json({ error: 'Catalog temporarily unavailable' }, 503);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return json({ error: 'Unexpected catalog response' }, 502);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream, route)
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (env.GALLERY_ORIGIN && url.origin !== exactHttpsOrigin(env.GALLERY_ORIGIN)) {
        return json({ error: 'Not found' }, 404);
      }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/catalog-media/')) {
        return proxyPublicRequest(request, env);
      }
      if (!env.ASSETS?.fetch || !['GET', 'HEAD'].includes(request.method)) {
        return json({ error: 'Not found' }, 404);
      }
      return env.ASSETS.fetch(request);
    } catch {
      return json({ error: 'Request could not be completed' }, 500);
    }
  }
};

