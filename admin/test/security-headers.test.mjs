import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noStoreHeaders, publicJson} from '../src/http.js';

const HSTS = 'max-age=31536000; includeSubDomains';

test('admin API and no-store responses advertise one-year HTTPS enforcement', () => {
  assert.equal(noStoreHeaders['Strict-Transport-Security'], HSTS);
  assert.equal(publicJson({ok: true}).headers.get('strict-transport-security'), HSTS);
});

test('admin static assets and media use the shared HTTPS enforcement policy', () => {
  const source = readFileSync(new URL('../src/entrypoint.js', import.meta.url), 'utf8');
  assert.match(source, /function securityHeaders[\s\S]*?\.\.\.noStoreHeaders/);
  assert.match(source, /function mediaResponse[\s\S]*?'Strict-Transport-Security': STRICT_TRANSPORT_SECURITY/);
});

test('storefront static header policy advertises the same HTTPS enforcement', () => {
  const headers = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8');
  assert.match(headers, /^\s*Strict-Transport-Security: max-age=31536000; includeSubDomains\s*$/m);
});
