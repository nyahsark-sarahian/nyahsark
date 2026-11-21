import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { proxyPublicRequest } from '../gallery-worker.js';

const origin = 'https://nyahsark.com';

function request(path, init = {}) {
  return new Request(origin + path, init);
}

function environment(handler) {
  return {
    GALLERY_ORIGIN: origin,
    CATALOG_PUBLIC_ORIGIN: origin,
    PUBLISHED_CATALOG: { fetch: handler },
    ASSETS: { fetch: async () => new Response('asset') }
  };
}

test('catalog list forwards only safe headers and query', async () => {
  let observed;
  const env = environment(async req => {
    observed = req;
    return Response.json({ items: [] }, { headers: { 'Set-Cookie': 'secret=bad', 'Cache-Control': 'public' } });
  });
  const response = await proxyPublicRequest(request('/api/catalog?sort=price_asc', {
    headers: { Authorization: 'Bearer secret', Cookie: 'private=yes', 'X-Private': 'no' }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(new URL(observed.url).pathname + new URL(observed.url).search, '/api/catalog?sort=price_asc');
  assert.equal(observed.headers.get('authorization'), null);
  assert.equal(observed.headers.get('cookie'), null);
  assert.equal(observed.headers.get('x-private'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('detail and display media are allowed; original and admin media are denied', async () => {
  const calls = [];
  const env = environment(async req => {
    calls.push(new URL(req.url).pathname);
    return new Response('ok', { headers: { 'Content-Type': 'image/webp' } });
  });
  assert.equal((await proxyPublicRequest(request('/api/catalog/art-001'), env)).status, 200);
  assert.equal((await proxyPublicRequest(request('/catalog-media/asset_123/display'), env)).status, 200);
  assert.equal((await proxyPublicRequest(request('/catalog-media/asset_123/original'), env)).status, 404);
  assert.equal((await proxyPublicRequest(request('/api/admin/artworks'), env)).status, 404);
  assert.deepEqual(calls, ['/api/catalog/art-001', '/catalog-media/asset_123/display']);
});

test('quote and checkout accept bounded JSON without caller credentials', async () => {
  const calls = [];
  const env = environment(async req => {
    calls.push({ path: new URL(req.url).pathname, body: await req.json(), authorization: req.headers.get('authorization') });
    return Response.json({ checkout_enabled: false });
  });
  const init = body => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private' },
    body: JSON.stringify(body)
  });
  assert.equal((await proxyPublicRequest(request('/api/cart/quote', init({ items: [] })), env)).status, 200);
  assert.equal((await proxyPublicRequest(request('/api/checkout', init({ quote_id: 'q' })), env)).status, 200);
  assert.deepEqual(calls.map(call => call.path), ['/api/cart/quote', '/api/checkout']);
  assert.ok(calls.every(call => call.authorization === null));
});

test('unsafe methods, invalid bodies, and absent binding fail closed', async () => {
  const env = environment(async () => Response.json({}));
  assert.equal((await proxyPublicRequest(request('/api/catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env)).status, 404);
  assert.equal((await proxyPublicRequest(request('/api/cart/quote', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }), env)).status, 415);
  assert.equal((await proxyPublicRequest(request('/api/cart/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), env)).status, 400);
  assert.equal((await proxyPublicRequest(request('/api/catalog'), {})).status, 503);
});

test('worker serves assets outside the narrow API surface', async () => {
  const env = environment(async () => Response.json({}));
  assert.equal(await (await worker.fetch(request('/site.css'), env)).text(), 'asset');
  assert.equal((await worker.fetch(new Request('https://other.example/site.css'), env)).status, 404);
});
