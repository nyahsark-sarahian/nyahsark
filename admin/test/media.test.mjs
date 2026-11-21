import test from 'node:test';
import assert from 'node:assert/strict';
import {MEDIA_LIMITS, imageType, mediaCapabilities, sanitizeImage} from '../src/media.js';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAKJ/dLkAAAAASUVORK5CYII=', 'base64'));
const webp = Uint8Array.from(Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));

function binding(info = {format: 'image/png', width: 1, height: 1}) {
  return {
    async info() { return info; },
    input() {
      return {
        transform() {
          return {
            output() {
              return {response: () => new Response(webp, {headers: {'Content-Type': 'image/webp'}})};
            }
          };
        }
      };
    }
  };
}

test('reports the same explicit uploader limits used by validation', () => {
  const capabilities = mediaCapabilities('yes');
  assert.equal(capabilities.uploads_enabled, true);
  assert.deepEqual(capabilities.supported_mime_types, ['image/jpeg', 'image/png', 'image/webp']);
  assert.equal(capabilities.max_input_bytes, 5 * 1024 * 1024);
  assert.equal(capabilities.max_pixels, 16_000_000);
  assert.equal(capabilities.max_side_pixels, 8192);
  assert.equal(capabilities.max_photos_per_artwork, 4);
  assert.equal(capabilities.heic_supported, false);
  assert.equal(mediaCapabilities('no').uploads_enabled, false);
});

test('fully processed upload yields private master, display, and thumbnail WebP objects', async () => {
  const result = await sanitizeImage(binding(), png, 'image/png', 'yes');
  assert.deepEqual(result.input, {mime: 'image/png', width: 1, height: 1, bytes: png.length});
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.objects.map((item) => [item.role, item.contentType]), [
    ['master', 'image/webp'], ['display', 'image/webp'], ['thumbnail', 'image/webp']
  ]);
  assert.ok(result.objects.every((item) => imageType(item.bytes)?.mime === 'image/webp'));
});

test('accepts the MIME format names returned by the production Images binding', async () => {
  const result = await sanitizeImage(binding({format: 'image/jpeg', width: 1200, height: 1600}),
    Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg', 'yes');
  assert.deepEqual(result.input, {mime: 'image/jpeg', width: 1200, height: 1600, bytes: 4});
});

test('unqualified processing, MIME mismatch, malformed bytes, HEIC, and excessive dimensions fail closed', async () => {
  await assert.rejects(() => sanitizeImage(binding(), png, 'image/png', 'no'), (error) => error.status === 503);
  await assert.rejects(() => sanitizeImage(binding(), png, 'image/jpeg', 'yes'), (error) => error.status === 415);
  await assert.rejects(() => sanitizeImage(binding(), new Uint8Array([1, 2, 3]), 'image/png', 'yes'), (error) => error.status === 415);
  await assert.rejects(() => sanitizeImage(binding(), png, 'image/heic', 'yes'), (error) => error.status === 415);
  await assert.rejects(() => sanitizeImage(binding({format: 'image/png', width: MEDIA_LIMITS.maxSide + 1, height: 1}), png, 'image/png', 'yes'), (error) => error.status === 415);
});

