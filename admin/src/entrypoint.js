import revisionedSchema from '../migrations/0003_revisioned_catalog.sql';
import commandSchema from '../migrations/0004_settings_commands.sql';
import {makeVerifier} from './verifier.js';
import {ensureSchema} from './schema.js';
import {
  archiveArtwork,
  allocateUpload,
  commitSuccessfulUpload,
  failUpload,
  getAdminArtwork,
  getManagedMedia,
  getPublicArtwork,
  listAdminArtworks,
  listPublicCatalog,
  mediaCapabilities,
  previewDraft,
  publishArtwork,
  reconcileBaseline,
  restoreArtwork,
  saveDraftBatch,
  saveStoreOrder
} from './catalog.js';
import {
  beginCheckout,
  createQuote,
  getOrder,
  getSettings,
  handlePaymentWebhook,
  listOrders,
  saveSettings,
  updateTracking
} from './commerce.js';
import {sanitizeImage, MEDIA_LIMITS} from './media.js';
import {HttpError, json, noStoreHeaders, publicJson, readJson, requireOrigin, routeError} from './http.js';

const ADMIN_ASSETS = new Set([
  '/admin.html',
  '/recovery.html',
  '/styles.css',
  '/admin.js',
  '/common.js',
  '/session.js',
  '/supabase.js',
  '/auth/password-signin.js',
  '/auth/request-recovery.js',
  '/auth/recovery.js'
]);
const PUBLIC_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_LEGACY_PHOTO = /^\/art-00[1-9]-[1-4]\.jpg$/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let initialized;

function exactOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { throw Error(`${label} is invalid`); }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error(`${label} is invalid`);
  }
  return url.origin;
}

async function ready(env) {
  if (!env.DB) throw Error('Database binding is unavailable');
  if (!initialized) {
    initialized = (async () => {
      await ensureSchema(env.DB, revisionedSchema, commandSchema);
      await reconcileBaseline(env.DB);
    })().catch((error) => {
      initialized = undefined;
      throw error;
    });
  }
  await initialized;
}

function numberParameter(url, name, minimum = 1, maximum = 1_000_000) {
  const value = url.searchParams.get(name);
  if (value == null || value === '') return undefined;
  if (!/^\d+$/.test(value)) throw new HttpError(400, `${name} is invalid`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new HttpError(400, `${name} is invalid`);
  return number;
}

function pathIdentifier(pathname, pattern) {
  const match = pattern.exec(pathname);
  if (!match) return null;
  let value;
  try { value = decodeURIComponent(match[1]); } catch { throw new HttpError(404, 'Not found'); }
  if (!OPAQUE_ID.test(value)) throw new HttpError(404, 'Not found');
  return value;
}

function securityHeaders(env, contentType) {
  const supabase = new URL(env.SUPABASE_URL).origin;
  return {
    ...noStoreHeaders,
    'Content-Type': contentType,
    'Content-Security-Policy': `default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: ${exactOrigin(env.STOREFRONT_ORIGIN, 'Storefront origin')}; connect-src 'self' ${supabase}; font-src 'self'; worker-src 'none'; manifest-src 'none'`,
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow'
  };
}

async function adminAsset(request, env, pathname) {
  if (!env.ASSETS?.fetch || !['GET', 'HEAD'].includes(request.method)) return null;
  let asset = pathname;
  if (asset === '/') asset = '/admin.html';
  if (asset === '/auth/recovery' || asset === '/auth/recovery/') asset = '/recovery.html';
  if (!ADMIN_ASSETS.has(asset)) return null;
  const target = new URL(asset, request.url);
  const response = await env.ASSETS.fetch(new Request(target, {method: request.method, headers: {Accept: request.headers.get('Accept') || '*/*'}}));
  if (!response.ok) return new Response('Not found', {status: 404, headers: securityHeaders(env, 'text/plain; charset=utf-8')});
  const type = response.headers.get('content-type') || (asset.endsWith('.css') ? 'text/css; charset=utf-8' : asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  return new Response(request.method === 'HEAD' ? null : response.body, {status: response.status, headers: securityHeaders(env, type)});
}

function configScript(request, env) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed');
  const config = {
    url: new URL(env.SUPABASE_URL).origin,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    subject: env.SARAH_AUTH_SUB,
    adminOrigin: exactOrigin(env.ADMIN_ORIGIN, 'Administrator origin')
  };
  const body = `window.NYAH_PUBLIC_CONFIG=Object.freeze(${JSON.stringify(config).replaceAll('<', '\\u003c')});\n`;
  return new Response(request.method === 'HEAD' ? null : body, {headers: securityHeaders(env, 'text/javascript; charset=utf-8')});
}

function mediaResponse(media, {isPublic = false} = {}) {
  if (!media?.body || media.content_type !== 'image/webp') throw new HttpError(404, 'Photo not found');
  const headers = {
    'Content-Type': 'image/webp',
    'Content-Length': String(media.body.byteLength),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': isPublic ? 'public, max-age=300, must-revalidate' : 'private, no-store, no-transform'
  };
  return new Response(media.body, {headers});
}

async function readRequestBytes(request, maximum) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new HttpError(413, 'Photo must be no larger than 5 MiB');
  if (!request.body) throw new HttpError(400, 'Photo is required');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new HttpError(413, 'Photo must be no larger than 5 MiB');
    }
    chunks.push(value);
  }
  if (!size) throw new HttpError(400, 'Photo is required');
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function legacyPrivateMedia(media, env) {
  if (!SAFE_LEGACY_PHOTO.test(media?.legacy_path || '')) throw new HttpError(404, 'Photo not found');
  const target = new URL(media.legacy_path, exactOrigin(env.STOREFRONT_ORIGIN, 'Storefront origin'));
  const response = await fetch(target, {headers: {Accept: 'image/jpeg'}, redirect: 'error'});
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'image/jpeg') throw new HttpError(404, 'Photo not found');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MEDIA_LIMITS.inputBytes) throw new HttpError(404, 'Photo not found');
  const body = await response.arrayBuffer();
  if (!body.byteLength || body.byteLength > MEDIA_LIMITS.inputBytes) throw new HttpError(404, 'Photo not found');
  return new Response(body, {headers: {
    ...noStoreHeaders,
    'Content-Type': 'image/jpeg',
    'Content-Length': String(body.byteLength),
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin'
  }});
}

function adminListShape(result) {
  return {
    ...result,
    pagination: {
      page: result.page,
      page_size: result.page_size,
      total: result.total,
      total_pages: result.pages,
      showing_from: result.showing_from,
      showing_to: result.showing_to
    },
    counts: {...result.counts, draft: result.counts?.draft ?? result.counts?.drafts ?? 0}
  };
}

function saveBatchShape(result) {
  return {
    ...result,
    results: result.results.map((item) => ({
      ...item,
      id: item.artwork_id ?? item.id,
      version: item.saved_version ?? item.version,
      field_errors: item.field_errors ?? item.details?.fields ?? null
    }))
  };
}

async function publicApi(request, env, url) {
  if (url.origin !== exactOrigin(env.STOREFRONT_ORIGIN, 'Storefront origin')) throw new HttpError(404, 'Not found');
  await ready(env);
  if (request.method === 'GET' && url.pathname === '/api/catalog') {
    const result = await listPublicCatalog(env.DB, {
      page: numberParameter(url, 'page'),
      page_size: numberParameter(url, 'page_size', 1, 48),
      q: url.searchParams.get('q') || '',
      category: url.searchParams.get('category') || '',
      availability: url.searchParams.get('availability') || 'all',
      sort: url.searchParams.get('sort') || 'store'
    });
    return publicJson({...result, pagination: {page: result.page, page_size: result.page_size, total: result.total, pages: result.pages}});
  }
  const detail = /^\/api\/catalog\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'GET' && detail) {
    const id = decodeURIComponent(detail[1]);
    if (!PUBLIC_ID.test(id)) throw new HttpError(404, 'Artwork not found');
    return publicJson({item: await getPublicArtwork(env.DB, id)});
  }
  const media = /^\/catalog-media\/([^/]+)\/(display|thumb)$/.exec(url.pathname);
  if (request.method === 'GET' && media) {
    const id = decodeURIComponent(media[1]);
    if (!OPAQUE_ID.test(id)) throw new HttpError(404, 'Photo not found');
    const result = await getManagedMedia(env.DB, id, media[2] === 'thumb' ? 'thumbnail' : 'display', {publicOnly: true});
    return mediaResponse(result, {isPublic: true});
  }
  if (request.method === 'POST' && url.pathname === '/api/cart/quote') {
    return publicJson(await createQuote(env.DB, await readJson(request, 64 * 1024), env));
  }
  if (request.method === 'POST' && url.pathname === '/api/checkout') {
    const result = await beginCheckout(env.DB, await readJson(request, 64 * 1024), env);
    return publicJson({...result, checkout_url: result.hosted_url || result.checkout_url});
  }
  throw new HttpError(404, 'Not found');
}

async function adminApi(request, env, url) {
  if (url.origin !== exactOrigin(env.ADMIN_ORIGIN, 'Administrator origin')) throw new HttpError(404, 'Not found');
  const identity = await makeVerifier(env)(request);
  if (WRITE_METHODS.has(request.method)) requireOrigin(request, env.ADMIN_ORIGIN);
  await ready(env);
  const actor = `admin:${identity.subject}`;

  if (request.method === 'GET' && url.pathname === '/api/admin/capabilities') {
    return json({media: mediaCapabilities(env.IMAGE_TRANSFORM_QUALIFIED)});
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/capabilities/probe') {
    const type = (request.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    const bytes = await readRequestBytes(request, MEDIA_LIMITS.inputBytes);
    const processed = await sanitizeImage(env.IMAGE_TRANSFORM, bytes, type, 'yes');
    return json({qualified: true, input: processed.input, output_roles: processed.objects.map((item) => item.role)});
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/artworks') {
    return json(adminListShape(await listAdminArtworks(env.DB, {
      page: numberParameter(url, 'page'),
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || 'all'
    })));
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/artwork-drafts:batch') {
    return json(saveBatchShape(await saveDraftBatch(env.DB, await readJson(request), actor)));
  }
  const adminArtwork = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)$/);
  if (request.method === 'GET' && adminArtwork) return json({artwork: await getAdminArtwork(env.DB, adminArtwork)});
  const preview = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/preview$/);
  if (request.method === 'POST' && preview) {
    const body = await readJson(request);
    return json(await previewDraft(env.DB, preview, body.draft));
  }
  const publish = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/publish$/);
  if (request.method === 'POST' && publish) return json({artwork: await publishArtwork(env.DB, publish, await readJson(request), actor), message: 'Artwork published.'});
  const archive = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/archive$/);
  if (request.method === 'POST' && archive) {
    const body = await readJson(request);
    return json({artwork: await archiveArtwork(env.DB, archive, body.expected_version, actor)});
  }
  const restore = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/restore$/);
  if (request.method === 'POST' && restore) {
    const body = await readJson(request);
    return json({artwork: await restoreArtwork(env.DB, restore, body.expected_version, actor)});
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/store-order') {
    const result = await saveStoreOrder(env.DB, await readJson(request), actor);
    return json({...result, order_version: result.version});
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/uploads') {
    if (env.IMAGE_TRANSFORM_QUALIFIED !== 'yes') throw new HttpError(503, 'Photo processing is not available');
    const body = await readJson(request, 32 * 1024);
    if (!MEDIA_LIMITS.supportedMimeTypes.includes(body.content_type)) throw new HttpError(415, 'Supported photo types are JPEG, PNG, and WebP');
    if (!Number.isSafeInteger(body.byte_size) || body.byte_size < 1 || body.byte_size > MEDIA_LIMITS.inputBytes) {
      throw new HttpError(413, 'Photo must be no larger than 5 MiB');
    }
    if (typeof body.filename !== 'string' || !body.filename || body.filename.length > 255) throw new HttpError(400, 'Photo filename is invalid');
    const result = await allocateUpload(env.DB, body);
    return json({...result, upload_url: `/api/admin/uploads/${result.upload_id}`}, result.state === 'allocated' ? 201 : 200);
  }
  const upload = pathIdentifier(url.pathname, /^\/api\/admin\/uploads\/([^/]+)$/);
  if (request.method === 'PUT' && upload) {
    const type = (request.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    const bytes = await readRequestBytes(request, MEDIA_LIMITS.inputBytes);
    try {
      const processed = await sanitizeImage(env.IMAGE_TRANSFORM, bytes, type, env.IMAGE_TRANSFORM_QUALIFIED);
      const committed = await commitSuccessfulUpload(env.DB, upload, processed, actor);
      const owner = await env.DB.prepare('SELECT artwork_id FROM catalog_media_assets WHERE id=?').bind(committed.asset_id).first();
      if (!owner?.artwork_id) throw new HttpError(500, 'Uploaded photo owner could not be confirmed');
      return json({...committed, version: committed.saved_version, artwork: await getAdminArtwork(env.DB, owner.artwork_id)});
    } catch (error) {
      try { await failUpload(env.DB, upload, error?.status ? `HTTP_${error.status}` : 'PROCESSING_FAILED'); } catch {}
      throw error;
    }
  }
  const privateMedia = /^\/api\/admin\/media\/([^/]+)\/(master|display|thumb|thumbnail)$/.exec(url.pathname);
  if (request.method === 'GET' && privateMedia) {
    const id = decodeURIComponent(privateMedia[1]);
    if (!OPAQUE_ID.test(id)) throw new HttpError(404, 'Photo not found');
    const role = privateMedia[2] === 'thumb' ? 'thumbnail' : privateMedia[2];
    const result = await getManagedMedia(env.DB, id, role);
    return result.legacy_path ? legacyPrivateMedia(result, env) : mediaResponse(result);
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/settings') return json(await getSettings(env.DB));
  if (request.method === 'PUT' && url.pathname === '/api/admin/settings') {
    const body = await readJson(request);
    return json(await saveSettings(env.DB, body, actor));
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/orders') {
    const result = await listOrders(env.DB, {page: numberParameter(url, 'page'), status: url.searchParams.get('status') || undefined});
    return json(result);
  }
  const tracking = pathIdentifier(url.pathname, /^\/api\/admin\/orders\/([^/]+)\/tracking$/);
  if (request.method === 'POST' && tracking) {
    const body = await readJson(request, 32 * 1024);
    const existing = await getOrder(env.DB, tracking);
    const trackingReference = body.tracking_reference ?? body.tracking ?? null;
    const fulfillmentStatus = body.fulfillment_status || (trackingReference ? 'shipped' : existing.fulfillment_status);
    return json({order: await updateTracking(env.DB, tracking, {fulfillment_status: fulfillmentStatus, tracking_reference: trackingReference}, actor)});
  }
  throw new HttpError(404, 'Not found');
}

async function dispatch(request, env) {
  if (env.STAGING_ENABLED !== 'yes') throw new HttpError(503, 'Administrator staging is disabled');
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET' && [env.ADMIN_ORIGIN, env.STOREFRONT_ORIGIN].includes(url.origin)) {
    return publicJson({ok: true, service: 'nyahsark-catalog'});
  }
  if (url.pathname === '/api/payment/webhook' && request.method === 'POST' && url.origin === env.ADMIN_ORIGIN) {
    await ready(env);
    return publicJson(await handlePaymentWebhook(env.DB, request, env));
  }
  if (url.pathname.startsWith('/api/admin/')) return adminApi(request, env, url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/catalog-media/')) return publicApi(request, env, url);
  if (url.origin !== exactOrigin(env.ADMIN_ORIGIN, 'Administrator origin')) throw new HttpError(404, 'Not found');
  if (url.pathname === '/config.js') return configScript(request, env);
  const asset = await adminAsset(request, env, url.pathname);
  if (asset) return asset;
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    try {
      return await dispatch(request, env);
    } catch (error) {
      if (!(error instanceof HttpError) && !Number.isInteger(error?.status)) {
        console.error('nyahsark_worker_failure', String(error?.name || 'Error').slice(0, 80), String(error?.message || error).slice(0, 500));
      }
      return routeError(error);
    }
  }
};

export {dispatch};
