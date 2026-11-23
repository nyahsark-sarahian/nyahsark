import revisionedSchema from '../migrations/0003_revisioned_catalog.sql';
import commandSchema from '../migrations/0004_settings_commands.sql';
import complianceSchema from '../migrations/0005_listing_compliance.sql';
import governanceSchema from '../migrations/0006_ai_governance.sql';
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
import {aiAssistCapabilities, generateListingAssistance} from './ai-assist.js';
import {reserveComplianceAssistance} from './ai-compliance-workflow.js';
import {deterministicPolicyPreflight, dispatchDraftCopyIfAllowed} from './ai-policy-gate.js';
import {
  AiBudgetError,
  failAiInferenceBudget,
  getAiBudgetStatus,
  reconcileAiInferenceBudget,
  reserveAiInferenceBudget
} from './ai-budget.js';
import {getListingPriceGuidance} from './pricing-service.js';
import {savePricingPreference, saveReviewEscalation} from './listing-governance.js';
import {
  POLICY_VERSION,
  getActiveAssessment,
  runDeterministicAssessment,
  saveAssessment,
  saveAiSuggestion,
  saveHumanReview
} from './compliance.js';
import {HttpError, json, noStoreHeaders, publicJson, readJson, requireOrigin, routeError} from './http.js';
import {assertPublicationAllowed, calibrationMode, verifyCalibrationPublicationGuards} from './calibration.js';

const ADMIN_ASSETS = new Set([
  '/admin.html',
  '/recovery.html',
  '/styles.css',
  '/admin.js',
  '/common.js',
  '/session.js',
  '/supabase.js',
  '/nyahs-ark-logo.svg',
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
      await ensureSchema(env.DB, revisionedSchema, commandSchema, complianceSchema, governanceSchema);
      if (calibrationMode(env)) await verifyCalibrationPublicationGuards(env.DB);
      else await reconcileBaseline(env.DB);
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

async function readLegacyPhoto(media, env) {
  if (!SAFE_LEGACY_PHOTO.test(media?.legacy_path || '')) throw new HttpError(404, 'Photo not found');
  const target = new URL(media.legacy_path, exactOrigin(env.STOREFRONT_ORIGIN, 'Storefront origin'));
  const response = await fetch(target, {headers: {Accept: 'image/jpeg'}, redirect: 'error'});
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'image/jpeg') throw new HttpError(404, 'Photo not found');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MEDIA_LIMITS.inputBytes) throw new HttpError(404, 'Photo not found');
  const body = await response.arrayBuffer();
  if (!body.byteLength || body.byteLength > MEDIA_LIMITS.inputBytes) throw new HttpError(404, 'Photo not found');
  return body;
}

async function legacyPrivateMedia(media, env) {
  const body = await readLegacyPhoto(media, env);
  return new Response(body, {headers: {
    ...noStoreHeaders,
    'Content-Type': 'image/jpeg',
    'Content-Length': String(body.byteLength),
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin'
  }});
}

function requireCurrentVersion(body, artwork) {
  if (!Number.isSafeInteger(body?.expected_version)) throw new HttpError(400, 'Expected version is required');
  if (body.expected_version !== artwork.version) {
    throw new HttpError(409, 'Draft changed in another session', {code: 'HEAD_CONFLICT', current_version: artwork.version});
  }
  if (artwork.state === 'archived') throw new HttpError(409, 'Restore this artwork before using Listing Copilot', {code: 'ARTWORK_ARCHIVED'});
}

function aiActionIdentifier(body, purpose) {
  const supplied = body?.request_id;
  if (typeof supplied !== 'string' || supplied.length < 8 || supplied.length > 100 || !OPAQUE_ID.test(supplied)) {
    throw new HttpError(400, 'AI request identifier is required');
  }
  return `copilot:${purpose}:${supplied}`;
}

function budgetHttpError(error) {
  return error instanceof AiBudgetError
    ? new HttpError(error.status, error.message, {code: error.code})
    : error;
}

async function sanitizedAssistanceImage(env, photo) {
  const media = await getManagedMedia(env.DB, photo.asset_id, 'display');
  if (media.body && media.content_type === 'image/webp') {
    return {asset_id: photo.asset_id, bytes: new Uint8Array(media.body)};
  }
  const raw = await readLegacyPhoto(media, env);
  const processed = await sanitizeImage(env.IMAGE_TRANSFORM, raw, 'image/jpeg', env.IMAGE_TRANSFORM_QUALIFIED);
  const display = processed.objects.find((item) => item.role === 'display' && item.contentType === 'image/webp');
  if (!display?.bytes) throw new HttpError(503, 'A sanitized display photo could not be prepared');
  return {asset_id: photo.asset_id, bytes: display.bytes};
}

async function assistanceImages(env, artwork, allPhotos) {
  const photos = Array.isArray(artwork.draft?.photos) ? artwork.draft.photos : [];
  const main = photos.find((item) => item.is_main === true && item.asset_id);
  if (!main) throw new HttpError(400, 'Save a main photo before using Listing Copilot', {fields: {photos: ['A saved main photo is required.']}});
  const selected = allPhotos ? [main, ...photos.filter((item) => item.asset_id && item.asset_id !== main.asset_id)] : [main];
  return Promise.all(selected.map((photo) => sanitizedAssistanceImage(env, photo)));
}

async function assertUnchangedArtwork(env, original) {
  const current = await getAdminArtwork(env.DB, original.id);
  if (current.version !== original.version || current.working_revision_id !== original.working_revision_id) {
    throw new HttpError(409, 'Draft changed while Listing Copilot was working', {code: 'HEAD_CONFLICT', current_version: current.version});
  }
  return current;
}

async function assertSupportedActivePolicy(database) {
  const active = await database.prepare(`SELECT id FROM catalog_policy_versions
    WHERE status='active' ORDER BY activated_at DESC,id DESC LIMIT 1`).first();
  if (active?.id !== POLICY_VERSION) {
    throw new HttpError(503, 'Canonical listing review is unavailable during a policy update', {code: 'POLICY_VERSION_UNAVAILABLE'});
  }
}

async function prepareAssistance(env, artwork, actor, {allPhotos = false, actionId} = {}) {
  if (!aiAssistCapabilities(env).enabled) {
    throw new HttpError(503, 'AI listing assistance is not configured', {code: 'AI_ASSIST_UNAVAILABLE'});
  }
  const images = await assistanceImages(env, artwork, allPhotos);
  let reservation;
  try {
    reservation = await reserveAiInferenceBudget(env.DB, {
      actionId: actionId || `copilot:internal:${crypto.randomUUID()}`,
      imageCount: images.length,
      modelId: env.AI_ASSIST_MODEL,
      actor
    }, {env});
  } catch (error) {
    throw budgetHttpError(error);
  }
  // A replayed identifier may represent an in-flight or already billed call.
  // Never dispatch it again without a fresh user action identifier.
  if (reservation.reused) {
    throw new HttpError(409, 'This Listing Copilot action was already submitted; start a new action to try again', {code: 'AI_ACTION_REPLAY'});
  }
  return {images, reservation};
}

async function prepareComplianceAssistance(env, artwork, actor, {allPhotos = false, actionId} = {}) {
  if (!aiAssistCapabilities(env).enabled) {
    throw new HttpError(503, 'AI listing assistance is not configured', {code: 'AI_ASSIST_UNAVAILABLE'});
  }
  const images = await assistanceImages(env, artwork, allPhotos);
  const reservation = await reserveComplianceAssistance(env, artwork, actor, {
    imageCount: images.length,
    actionId
  });
  return {images, reservation};
}

async function generateAndSaveAssistance(env, artwork, actor, {allPhotos = false, actionId, prepared} = {}) {
  const work = prepared || await prepareAssistance(env, artwork, actor, {allPhotos, actionId});
  const {images, reservation} = work;
  let results;
  try {
    results = await Promise.all(images.map((image) => generateListingAssistance(env, {
      image,
      draft: artwork.draft,
      disclosures: artwork.draft.compliance
    })));
  } catch (error) {
    try {
      await failAiInferenceBudget(env.DB, {
        reservationId: reservation.reservation_id,
        errorCode: error?.details?.code || 'workers_ai_failed'
      });
    } catch (reconciliationError) {
      throw budgetHttpError(reconciliationError);
    }
    throw error;
  }
  try {
    await reconcileAiInferenceBudget(env.DB, {
      reservationId: reservation.reservation_id,
      state: 'completed',
      actualCostMicrousd: reservation.estimated_cost_microusd,
      usage: {billing_basis: 'conservative_pre_dispatch_estimate', image_count: images.length}
    });
  } catch (error) {
    throw budgetHttpError(error);
  }
  await assertUnchangedArtwork(env, artwork);
  const primary = results[0];
  const suggestions = {
    ...primary.suggestions,
    alt_texts: results.flatMap((result) => result.suggestions.alt_texts)
  };
  const observations = results.flatMap((result, index) => result.observations.map((item) => ({...item, asset_id: images[index].asset_id})));
  const uncertainties = [...new Set(results.flatMap((result) => result.uncertainties))];
  const saved = await saveAiSuggestion(env.DB, {
    artworkId: artwork.id,
    revisionId: artwork.working_revision_id,
    assetIds: images.map((image) => image.asset_id),
    promptVersion: primary.prompt_version,
    model: primary.model,
    suggestions,
    observations,
    uncertainties
  }, actor);
  await assertUnchangedArtwork(env, artwork);
  return {
    assistance: {...primary, suggestions, observations, uncertainties},
    saved
  };
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
    let budget;
    try { budget = await getAiBudgetStatus(env.DB, env); }
    catch (error) { throw budgetHttpError(error); }
    return json({
      media: mediaCapabilities(env.IMAGE_TRANSFORM_QUALIFIED),
      ai: {...aiAssistCapabilities(env), budget},
      compliance: {policy_version: POLICY_VERSION, deterministic_enforcement: true, human_review: true, priest_escalation: true}
    });
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
  const assistDraft = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/assist\/draft-copy$/);
  if (request.method === 'POST' && assistDraft) {
    const body = await readJson(request, 32 * 1024);
    const artwork = await getAdminArtwork(env.DB, assistDraft);
    requireCurrentVersion(body, artwork);
    const {assistance} = await dispatchDraftCopyIfAllowed(artwork.draft, () => generateAndSaveAssistance(env, artwork, actor, {
      allPhotos: true,
      actionId: aiActionIdentifier(body, 'draft-copy')
    }));
    return json({
      suggestion: {
        ...assistance.suggestions,
        observations: assistance.observations,
        uncertainties: assistance.uncertainties
      },
      observations: assistance.observations,
      uncertainties: assistance.uncertainties,
      prompt_version: assistance.prompt_version,
      message: 'Editable wording suggestions are ready. Nothing was saved to the listing or published.'
    });
  }
  const assistPrice = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/assist\/price$/);
  if (request.method === 'POST' && assistPrice) {
    const body = await readJson(request, 32 * 1024);
    const artwork = await getAdminArtwork(env.DB, assistPrice);
    requireCurrentVersion(body, artwork);
    const pricingPreference = await savePricingPreference(env.DB, {
      artwork_id: artwork.id,
      seller_floor_cents: body.seller_floor_cents
    }, actor);
    const guidance = await getListingPriceGuidance(env.DB, {
      artwork_id: artwork.id,
      revision_id: artwork.working_revision_id
    });
    await assertUnchangedArtwork(env, artwork);
    return json({...guidance, pricing_preference: pricingPreference, message: 'Advisory price guidance is ready. The seller floor was saved. No price was changed or published.'});
  }
  const assessCompliance = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/compliance\/assess$/);
  if (request.method === 'POST' && assessCompliance) {
    const body = await readJson(request, 32 * 1024);
    const artwork = await getAdminArtwork(env.DB, assessCompliance);
    requireCurrentVersion(body, artwork);
    await assertSupportedActivePolicy(env.DB);
    const preflight = deterministicPolicyPreflight(artwork.draft);
    if (preflight.decision === 'block') {
      const assessment = await runDeterministicAssessment(env.DB, {
        artwork_id: artwork.id,
        revision_id: artwork.working_revision_id,
        offered_for_sale: artwork.draft.offered_for_sale,
        disclosures: artwork.draft.compliance,
        observations: [],
        source: 'deterministic'
      }, actor);
      await assertSupportedActivePolicy(env.DB);
      await assertUnchangedArtwork(env, artwork);
      return json({
        assessment,
        suggestion: null,
        ai_observations_used: 0,
        message: 'Canonical listing review recorded a deterministic sale block from the saved listing facts. Workers AI was not invoked.'
      });
    }
    const capabilities = aiAssistCapabilities(env);
    let observations = [];
    let suggestion = null;
    let model = null;
    let promptVersion = null;
    if (artwork.draft.offered_for_sale && capabilities.enabled) {
      let aiAttemptStarted = false;
      try {
        const prepared = await prepareComplianceAssistance(env, artwork, actor, {
          allPhotos: true,
          actionId: aiActionIdentifier(body, 'compliance')
        });
        aiAttemptStarted = true;
        const {assistance} = await generateAndSaveAssistance(env, artwork, actor, {
          allPhotos: true,
          prepared
        });
        observations = assistance.observations;
        suggestion = {
          ...assistance.suggestions,
          observations: assistance.observations,
          uncertainties: assistance.uncertainties
        };
        model = assistance.model;
        promptVersion = assistance.prompt_version;
      } catch (error) {
        if (aiAttemptStarted && error?.details?.code !== 'HEAD_CONFLICT') {
          await saveAssessment(env.DB, {
            artwork_id: artwork.id,
            revision_id: artwork.working_revision_id,
            policy_version: POLICY_VERSION,
            decision: 'error',
            source: 'ai_assisted',
            reason_codes: ['visual_analysis_unavailable'],
            messages: ['Visual analysis could not be completed. Sale publication remains unavailable until a new assessment succeeds.'],
            citations: []
          }, actor);
        }
        throw error;
      }
    }
    await assertSupportedActivePolicy(env.DB);
    const assessment = await runDeterministicAssessment(env.DB, {
      artwork_id: artwork.id,
      revision_id: artwork.working_revision_id,
      offered_for_sale: artwork.draft.offered_for_sale,
      disclosures: artwork.draft.compliance,
      observations,
      source: model ? 'ai_assisted' : 'deterministic',
      model_id: model,
      prompt_version: promptVersion
    }, actor);
    await assertSupportedActivePolicy(env.DB);
    await assertUnchangedArtwork(env, artwork);
    return json({
      assessment,
      suggestion,
      ai_observations_used: observations.length,
      message: capabilities.enabled && artwork.draft.offered_for_sale
        ? 'Canonical listing review completed using all saved photographs and seller disclosures.'
        : 'Canonical listing review completed from the saved seller disclosures.'
    });
  }
  const reviewCompliance = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/compliance\/review$/);
  if (request.method === 'POST' && reviewCompliance) {
    const body = await readJson(request, 32 * 1024);
    const artwork = await getAdminArtwork(env.DB, reviewCompliance);
    requireCurrentVersion(body, artwork);
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length < 8 || note.length > 2000) throw new HttpError(400, 'A review note of 8 to 2,000 characters is required');
    if (!['approve', 'block', 'request_information'].includes(body.decision)) throw new HttpError(400, 'Review decision is invalid');
    await assertSupportedActivePolicy(env.DB);
    const current = await getActiveAssessment(env.DB, artwork.working_revision_id);
    if (!current) throw new HttpError(409, 'Run canonical listing review before recording a human decision', {code: 'ASSESSMENT_REQUIRED'});
    await assertUnchangedArtwork(env, artwork);
    await assertSupportedActivePolicy(env.DB);
    const assessment = await saveHumanReview(env.DB, {
      assessment_id: current.id,
      decision: body.decision,
      note
    }, actor);
    await assertSupportedActivePolicy(env.DB);
    await assertUnchangedArtwork(env, artwork);
    return json({assessment, message: 'Human review decision recorded in the immutable audit history.'});
  }
  const escalateCompliance = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/compliance\/escalate$/);
  if (request.method === 'POST' && escalateCompliance) {
    const body = await readJson(request, 32 * 1024);
    const artwork = await getAdminArtwork(env.DB, escalateCompliance);
    requireCurrentVersion(body, artwork);
    await assertSupportedActivePolicy(env.DB);
    const current = await getActiveAssessment(env.DB, artwork.working_revision_id);
    if (!current) throw new HttpError(409, 'Run canonical listing review before recording a consultation', {code: 'ASSESSMENT_REQUIRED'});
    await assertUnchangedArtwork(env, artwork);
    const result = await saveReviewEscalation(env.DB, {
      assessment_id: current.id,
      stage: body.stage,
      outcome: body.outcome,
      reviewer_role: body.reviewer_role,
      note: body.note
    }, actor);
    await assertSupportedActivePolicy(env.DB);
    await assertUnchangedArtwork(env, artwork);
    return json({...result, message: 'Human consultation recorded in the immutable compliance history.'});
  }
  const preview = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/preview$/);
  if (request.method === 'POST' && preview) {
    const body = await readJson(request);
    return json(await previewDraft(env.DB, preview, body.draft));
  }
  const publish = pathIdentifier(url.pathname, /^\/api\/admin\/artworks\/([^/]+)\/publish$/);
  if (request.method === 'POST' && publish) {
    assertPublicationAllowed(env);
    return json({artwork: await publishArtwork(env.DB, publish, await readJson(request), actor), message: 'Artwork published.'});
  }
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
    if (!MEDIA_LIMITS.supportedMimeTypes.includes(String(body.content_type || '').toLowerCase())) throw new HttpError(415, 'Supported photo types are JPEG, PNG, WebP, HEIC, and HEIF');
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
