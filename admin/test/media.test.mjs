import test from 'node:test';
import assert from 'node:assert/strict';
import {MEDIA_LIMITS, imageType, mediaCapabilities, sanitizeImage} from '../src/media.js';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAKJ/dLkAAAAASUVORK5CYII=', 'base64'));
const webp = Uint8Array.from(Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));

function ftyp(major, compatible = []) {
  const result = Buffer.alloc(16 + compatible.length * 4);
  result.writeUInt32BE(result.length, 0);
  result.write('ftyp', 4, 4, 'ascii');
  result.write(major, 8, 4, 'ascii');
  compatible.forEach((brand, index) => result.write(brand, 16 + index * 4, 4, 'ascii'));
  return Uint8Array.from(result);
}

const heic = ftyp('mif1', ['heic']);

function binding(info = {format: 'image/png', width: 1, height: 1}, transforms = null) {
  return {
    async info() { return info; },
    input() {
      return {
        transform(options) {
          if (Array.isArray(transforms)) transforms.push(options);
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
  assert.deepEqual(capabilities.supported_mime_types, ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
  assert.equal(capabilities.max_input_bytes, 5 * 1024 * 1024);
  assert.equal(capabilities.max_pixels, 16_000_000);
  assert.equal(capabilities.max_side_pixels, 8192);
  assert.equal(capabilities.max_photos_per_artwork, 4);
  assert.equal(capabilities.heic_supported, true);
  assert.equal(capabilities.heif_supported, true);
  assert.equal(mediaCapabilities('no').heic_supported, false);
  assert.equal(mediaCapabilities('no').uploads_enabled, false);
});

test('recognizes bounded still HEIC brands without accepting sequences or unrelated ISO media', () => {
  for (const brand of ['heic', 'heix', 'heim', 'heis']) assert.deepEqual(imageType(ftyp(brand)), {mime: 'image/heic', format: 'heic'});
  assert.deepEqual(imageType(ftyp('mif1', ['heic'])), {mime: 'image/heic', format: 'heic'});
  for (const brand of ['hevc', 'hevx', 'hevm', 'hevs', 'msf1', 'avif', 'mp42', 'qt  ']) assert.equal(imageType(ftyp(brand)), null);
  assert.equal(imageType(ftyp('heic', ['hevc'])), null);
  const truncated = ftyp('heic');
  truncated[3] += 4;
  assert.equal(imageType(truncated), null);
  assert.equal(imageType(Uint8Array.from(Buffer.from('not an ftyp box containing heic'))), null);
});

test('fully processed upload yields private master, display, and thumbnail WebP objects', async () => {
  const transforms = [];
  const result = await sanitizeImage(binding(undefined, transforms), png, 'image/png', 'yes');
  assert.deepEqual(result.input, {mime: 'image/png', width: 1, height: 1, bytes: png.length});
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.objects.map((item) => [item.role, item.contentType]), [
    ['master', 'image/webp'], ['display', 'image/webp'], ['thumbnail', 'image/webp']
  ]);
  assert.ok(result.objects.every((item) => imageType(item.bytes)?.mime === 'image/webp'));
  assert.equal(transforms.length, 3);
  assert.ok(transforms.every((options) => options.metadata === 'none'));
});

test('accepts the MIME format names returned by the production Images binding', async () => {
  const result = await sanitizeImage(binding({format: 'image/jpeg', width: 1200, height: 1600}),
    Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg', 'yes');
  assert.deepEqual(result.input, {mime: 'image/jpeg', width: 1200, height: 1600, bytes: 4});
});

test('accepts HEIC and HEIF MIME aliases and always returns WebP derivatives', async () => {
  for (const declared of ['image/heic', 'image/heif']) {
    const result = await sanitizeImage(binding({format: declared, width: 3024, height: 4032}), heic, declared, 'yes');
    assert.deepEqual(result.input, {mime: 'image/heic', width: 3024, height: 4032, bytes: heic.length});
    assert.equal(result.objects.length, 3);
    assert.ok(result.objects.every((item) => item.contentType === 'image/webp' && imageType(item.bytes)?.mime === 'image/webp'));
  }
});

test('unqualified processing, MIME mismatch, malformed bytes, unsupported HEIF, and excessive dimensions fail closed', async () => {
  await assert.rejects(() => sanitizeImage(binding(), png, 'image/png', 'no'), (error) => error.status === 503);
  await assert.rejects(() => sanitizeImage(binding(), png, 'image/jpeg', 'yes'), (error) => error.status === 415);
  await assert.rejects(() => sanitizeImage(binding(), new Uint8Array([1, 2, 3]), 'image/png', 'yes'), (error) => error.status === 415);
  await assert.rejects(() => sanitizeImage(binding({format: 'image/heic', width: 1, height: 1}), png, 'image/heic', 'yes'), (error) => error.status === 415);
  await assert.rejects(() => sanitizeImage(binding({format: 'image/heic', width: 1, height: 1}), ftyp('mif1'), 'image/heif', 'yes'), (error) => error.status === 415);
  await assert.rejects(() => sanitizeImage(binding({format: 'image/png', width: MEDIA_LIMITS.maxSide + 1, height: 1}), png, 'image/png', 'yes'), (error) => error.status === 415);
});

