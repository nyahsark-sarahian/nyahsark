import {HttpError} from './http.js';

export const MEDIA_LIMITS = Object.freeze({
  inputBytes: 5 * 1024 * 1024,
  maxPixels: 16_000_000,
  maxSide: 8192,
  maxPhotos: 4,
  masterBytes: 1_800_000,
  displayBytes: 512 * 1024,
  thumbnailBytes: 192 * 1024,
  supportedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
});

const HEIC_STILL_BRANDS = new Set(['heic', 'heix', 'heim', 'heis']);
const HEIC_SEQUENCE_BRANDS = new Set(['hevc', 'hevx', 'hevm', 'hevs', 'msf1']);

function fourCC(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return '';
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function heicType(bytes) {
  if (bytes.length < 16 || fourCC(bytes, 4) !== 'ftyp') return null;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (size < 16 || size > bytes.length || size > 4096 || (size - 16) % 4 !== 0) return null;
  const brands = [fourCC(bytes, 8)];
  for (let offset = 16; offset < size; offset += 4) brands.push(fourCC(bytes, offset));
  if (brands.some((brand) => HEIC_SEQUENCE_BRANDS.has(brand))) return null;
  return brands.some((brand) => HEIC_STILL_BRANDS.has(brand)) ? {mime: 'image/heic', format: 'heic'} : null;
}

export function imageType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return {mime: 'image/webp', format: 'webp'};
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return {mime: 'image/png', format: 'png'};
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return {mime: 'image/jpeg', format: 'jpeg'};
  }
  return heicType(bytes);
}

function normalizedDeclaredType(value) {
  const type = String(value || '').toLowerCase().split(';')[0].trim();
  return type === 'image/heif' ? 'image/heic' : type;
}

async function readLimited(response, maximum) {
  if (!response.ok || response.headers.get('content-type') !== 'image/webp' || !response.body) {
    throw new HttpError(415, 'Image conversion failed');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new HttpError(413, 'Processed image is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (imageType(bytes)?.mime !== 'image/webp') throw new HttpError(415, 'Image conversion failed');
  return bytes;
}

async function render(binding, raw, transform, quality, maximum) {
  const stream = () => new Blob([raw]).stream();
  const output = await binding
    .input(stream())
    .transform({...transform, fit: 'scale-down', metadata: 'none'})
    .output({format: 'image/webp', quality});
  return readLimited(output.response(), maximum);
}

const hex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');

export async function sanitizeImage(binding, rawInput, declaredType, qualified) {
  if (qualified !== 'yes' || !binding?.info || !binding?.input) throw new HttpError(503, 'Photo processing is not available');
  const raw = rawInput instanceof Uint8Array ? rawInput : new Uint8Array(rawInput || 0);
  if (!raw.length || raw.length > MEDIA_LIMITS.inputBytes) throw new HttpError(413, 'Photo must be no larger than 5 MiB');
  const sniffed = imageType(raw);
  const suppliedType = String(declaredType || '').toLowerCase().split(';')[0].trim();
  if (!sniffed || !MEDIA_LIMITS.supportedMimeTypes.includes(suppliedType) || sniffed.mime !== normalizedDeclaredType(suppliedType)) {
    throw new HttpError(415, 'Supported photo types are JPEG, PNG, WebP, HEIC, and HEIF');
  }

  try {
    const info = await binding.info(new Blob([raw]).stream());
    const reportedFormat = String(info?.format || '').toLowerCase();
    const bareFormat = reportedFormat.startsWith('image/') ? reportedFormat.slice('image/'.length) : reportedFormat;
    const format = bareFormat === 'jpg' ? 'jpeg' : bareFormat;
    const decodedFormatMatches = sniffed.format === 'heic' ? ['heic', 'heif'].includes(format) : format === sniffed.format;
    if (
      !decodedFormatMatches ||
      !Number.isSafeInteger(info.width) ||
      !Number.isSafeInteger(info.height) ||
      info.width < 1 ||
      info.height < 1 ||
      info.width > MEDIA_LIMITS.maxSide ||
      info.height > MEDIA_LIMITS.maxSide ||
      info.width * info.height > MEDIA_LIMITS.maxPixels
    ) throw new HttpError(415, 'Photo dimensions or decoded format are unsupported');

    let master;
    try {
      master = await render(binding, raw, {width: 2800, height: 2800}, 88, MEDIA_LIMITS.masterBytes);
    } catch (error) {
      if (error?.status !== 413) throw error;
      master = await render(binding, raw, {width: 2200, height: 2200}, 82, MEDIA_LIMITS.masterBytes);
    }
    const [display, thumbnail] = await Promise.all([
      render(binding, raw, {width: 1600, height: 1600}, 82, MEDIA_LIMITS.displayBytes),
      render(binding, raw, {width: 600, height: 600}, 78, MEDIA_LIMITS.thumbnailBytes)
    ]);
    const checksum = hex(await crypto.subtle.digest('SHA-256', master));
    return {
      input: {mime: sniffed.mime, width: info.width, height: info.height, bytes: raw.length},
      checksum,
      objects: [
        {role: 'master', contentType: 'image/webp', bytes: master},
        {role: 'display', contentType: 'image/webp', bytes: display},
        {role: 'thumbnail', contentType: 'image/webp', bytes: thumbnail}
      ]
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(415, 'Photo could not be safely decoded');
  }
}

export function mediaCapabilities(qualified) {
  return {
    uploads_enabled: qualified === 'yes',
    supported_mime_types: [...MEDIA_LIMITS.supportedMimeTypes],
    max_input_bytes: MEDIA_LIMITS.inputBytes,
    max_pixels: MEDIA_LIMITS.maxPixels,
    max_side_pixels: MEDIA_LIMITS.maxSide,
    max_photos_per_artwork: MEDIA_LIMITS.maxPhotos,
    heic_supported: qualified === 'yes',
    heif_supported: qualified === 'yes'
  };
}

