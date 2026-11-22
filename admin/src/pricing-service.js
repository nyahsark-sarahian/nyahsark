import {HttpError} from './http.js';
import {getActiveAssessment} from './compliance.js';
import {getPricingPreference} from './listing-governance.js';
import {suggestInitialPrice, suggestMarkdown} from './pricing-assist.js';

const DAY_SECONDS = 86_400;
const MAX_CENTS = 100_000_000;
const MAX_COMPARABLE_ROWS = 100;

const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const all = async (statement) => (await statement.all()).results ?? [];

function opaque(value, label) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 160) throw new HttpError(400, `${label} is invalid`);
  return value;
}
function elapsedDays(now, timestamp) {
  return Math.max(0, Math.floor((now - Math.min(now, Number(timestamp) || now)) / DAY_SECONDS));
}

function normalizedCategory(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function dimensionSimilarity(target, candidate) {
  const values = [target.width_eighths, target.height_eighths, candidate.width_eighths, candidate.height_eighths];
  if (values.some((value) => !integer(value, 1, 1_000_000))) return 0;
  const widthDifference = Math.abs(target.width_eighths - candidate.width_eighths) / Math.max(target.width_eighths, candidate.width_eighths);
  const heightDifference = Math.abs(target.height_eighths - candidate.height_eighths) / Math.max(target.height_eighths, candidate.height_eighths);
  const difference = (widthDifference + heightDifference) / 2;
  return difference <= 0.25 ? 0.1 : difference <= 0.5 ? 0.05 : 0;
}

function comparableSimilarity(target, candidate) {
  let score = 0.4;
  let semanticMatch = false;
  const targetCategory = normalizedCategory(target.category);
  const candidateCategory = normalizedCategory(candidate.category);
  if (targetCategory && candidateCategory && targetCategory === candidateCategory) {
    score += 0.3;
    semanticMatch = true;
  }
  if (
    target.object_kind && target.object_kind !== 'unknown' &&
    candidate.object_kind && candidate.object_kind !== 'unknown' &&
    target.object_kind === candidate.object_kind
  ) {
    score += 0.2;
    semanticMatch = true;
  }
  if (!semanticMatch) return score;
  score += dimensionSimilarity(target, candidate);
  return Math.min(1, Math.round(score * 100) / 100);
}

async function targetRevision(database, artworkId, revisionId) {
  const row = await database.prepare(`SELECT r.id,r.artwork_id,r.category,r.base_price_cents,r.width_eighths,r.height_eighths,
    r.offered_for_sale,r.created_at,h.working_revision_id,h.published_revision_id,h.archived_at,d.object_kind
    FROM catalog_artwork_revisions r
    JOIN catalog_artwork_heads h ON h.artwork_id=r.artwork_id
    LEFT JOIN catalog_revision_disclosures d ON d.revision_id=r.id
    WHERE r.artwork_id=? AND r.id=?`).bind(artworkId, revisionId).first();
  if (!row) throw new HttpError(404, 'Saved listing revision not found');
  if (row.working_revision_id !== revisionId) throw new HttpError(409, 'Price guidance requires the current saved revision', {code: 'REVISION_CHANGED'});
  if (row.archived_at != null) throw new HttpError(409, 'Restore this artwork before requesting price guidance', {code: 'ARTWORK_ARCHIVED'});
  if (row.offered_for_sale !== 1 && row.offered_for_sale !== true) throw new HttpError(409, 'Price guidance is available only for sale listings', {code: 'SALE_LISTING_REQUIRED'});
  return row;
}

async function verifiedComparables(database, target, nowSeconds) {
  const rows = await all(database.prepare(`SELECT o.id AS order_id,o.created_at AS sold_at,ol.line_number,ol.artwork_id,
    ol.unit_price_cents,json_extract(ol.snapshot_json,'$.base_price_cents') AS snapshot_base_price_cents,
    json_extract(ol.snapshot_json,'$.price_add_on_cents') AS snapshot_price_add_on_cents,
    r.id AS revision_id,r.category,r.width_eighths,r.height_eighths,d.object_kind
    FROM catalog_orders o
    JOIN catalog_order_lines ol ON ol.order_id=o.id
    JOIN catalog_artwork_revisions r ON r.id=json_extract(ol.snapshot_json,'$.revision_id')
    LEFT JOIN catalog_revision_disclosures d ON d.revision_id=r.id
    WHERE o.payment_status='paid' AND o.currency='USD' AND ol.artwork_id<>?
      AND ol.unit_price_cents BETWEEN 1 AND ? AND o.created_at BETWEEN ? AND ?
    ORDER BY o.created_at DESC,o.id,ol.line_number LIMIT ?`).bind(
      target.artwork_id,
      MAX_CENTS,
      nowSeconds - (1095 * DAY_SECONDS),
      nowSeconds,
      MAX_COMPARABLE_ROWS
    ));
  return rows.map((row) => {
    const unitPrice = Number(row.unit_price_cents);
    const savedBase = Number(row.snapshot_base_price_cents);
    const savedAddOn = Number(row.snapshot_price_add_on_cents);
    const basePrice = integer(savedBase, 1, MAX_CENTS)
      ? savedBase
      : unitPrice - (integer(savedAddOn, 0, MAX_CENTS) ? savedAddOn : 0);
    return {
      id: `${row.order_id}:${row.line_number}`,
      source_type: 'verified_sale',
      currency: 'USD',
      price_cents: basePrice,
      sold_at: Number(row.sold_at),
      similarity_score: comparableSimilarity(target, row),
      revision_id: row.revision_id
    };
  }).filter((row) => integer(row.price_cents, 1, MAX_CENTS) && row.similarity_score >= 0.5);
}

async function listingEvidence(database, target, nowSeconds) {
  const publication = await database.prepare(`WITH price_history AS (
    SELECT p.id,p.revision_id,p.created_at,p.rowid AS command_rowid,r.base_price_cents,
      lag(r.base_price_cents) OVER (ORDER BY p.created_at,p.rowid) AS previous_price_cents
    FROM catalog_publish_commands p
    JOIN catalog_artwork_revisions r ON r.id=p.revision_id
    WHERE p.artwork_id=? AND r.offered_for_sale=1 AND r.base_price_cents BETWEEN 1 AND ?
  )
  SELECT min(created_at) AS first_published_at,
    max(CASE WHEN revision_id=? THEN created_at END) AS revision_published_at,
    (SELECT base_price_cents FROM price_history ORDER BY created_at,command_rowid LIMIT 1) AS original_price_cents,
    max(CASE WHEN previous_price_cents IS NULL OR previous_price_cents<>base_price_cents THEN created_at END) AS last_price_changed_at
  FROM price_history`).bind(target.artwork_id, MAX_CENTS, target.id).first();
  const isPublished = target.published_revision_id === target.id;
  const firstPublishedAt = isPublished ? Number(publication?.first_published_at ?? target.created_at) : null;
  const revisionPublishedAt = isPublished ? Number(publication?.revision_published_at ?? target.created_at) : null;
  const recordedPriceChangedAt = Number(publication?.last_price_changed_at);
  const priceChangedAt = isPublished
    ? (integer(recordedPriceChangedAt, 1) ? recordedPriceChangedAt : firstPublishedAt ?? Number(target.created_at))
    : null;
  const publishedOriginalPrice = Number(publication?.original_price_cents);
  const originalPrice = integer(publishedOriginalPrice, 1, MAX_CENTS)
    ? publishedOriginalPrice
    : integer(Number(target.base_price_cents), 1, MAX_CENTS)
      ? Number(target.base_price_cents)
      : null;
  const recentSince = nowSeconds - (30 * DAY_SECONDS);
  const quoteActivity = await database.prepare(`SELECT
    count(DISTINCT CASE WHEN q.created_at>=? THEN q.id END) AS recent_quote_requests
    FROM catalog_quote_lines ql JOIN catalog_quotes q ON q.id=ql.quote_id
    WHERE ql.revision_id=? AND q.status IN ('ready','consumed') AND q.created_at<=?`).bind(recentSince, target.id, nowSeconds).first();
  const checkoutActivity = await database.prepare(`SELECT count(DISTINCT o.id) AS qualified_events,
    count(DISTINCT CASE WHEN pa.created_at>=? THEN o.id END) AS recent_checkout_starts
    FROM catalog_order_lines ol
    JOIN catalog_orders o ON o.id=ol.order_id
    JOIN catalog_payment_attempts pa ON pa.order_id=o.id AND pa.status IN ('ready','complete')
    WHERE json_extract(ol.snapshot_json,'$.revision_id')=? AND pa.created_at<=?`).bind(
      recentSince, target.id, nowSeconds
    ).first();
  return {
    is_published: isPublished,
    first_published_at: firstPublishedAt,
    current_revision_published_at: revisionPublishedAt,
    last_price_revision_at: priceChangedAt,
    original_price_cents: originalPrice,
    listing_age_days: isPublished ? elapsedDays(nowSeconds, firstPublishedAt) : 0,
    days_since_price_change: isPublished ? elapsedDays(nowSeconds, priceChangedAt) : 0,
    qualified_demand_events: Number(checkoutActivity?.qualified_events ?? 0),
    recent_quote_requests: Number(quoteActivity?.recent_quote_requests ?? 0),
    recent_checkout_starts: Number(checkoutActivity?.recent_checkout_starts ?? 0),
    qualified_demand_source: 'provider_created_payment_sessions',
    inquiries_tracked: false
  };
}
function unavailableMarkdown(reason) {
  return {status: 'no_recommendation', reason, automatic_price_change: false};
}

function enforceInitialSellerFloor(initial, sellerFloorCents) {
  if (initial?.status !== 'suggested') return initial;
  const marketRange = {
    low_cents: initial.low_cents,
    midpoint_cents: initial.midpoint_cents,
    high_cents: initial.high_cents
  };
  if (initial.high_cents < sellerFloorCents) {
    return {
      status: 'no_recommendation',
      reason: 'The verified comparable-sale range is below the saved seller floor; set the price manually or revisit the floor inputs.',
      comparable_count: initial.comparable_count,
      confidence: initial.confidence,
      seller_floor_cents: sellerFloorCents,
      market_range: marketRange,
      seller_confirmation_required: true,
      automatic_price_change: false
    };
  }
  return {
    ...initial,
    market_range: marketRange,
    seller_floor_cents: sellerFloorCents,
    floor_applied: initial.low_cents < sellerFloorCents,
    low_cents: Math.max(initial.low_cents, sellerFloorCents),
    midpoint_cents: Math.max(initial.midpoint_cents, sellerFloorCents)
  };
}

function relabelMarkdown(markdown) {
  if (!Array.isArray(markdown.rationale)) return markdown;
  return {
    ...markdown,
    rationale: markdown.rationale.map((line) => line
      .replace('qualified views provide enough demand evidence', 'provider-created payment sessions provide enough demand evidence')
      .replace('Recent buyer engagement', 'Recent ready-quote activity')
      .replace('No recent carts or inquiries', 'No recent ready quote requests'))
  };
}

export async function getListingPriceGuidance(database, input = {}) {
  const artworkId = opaque(input.artwork_id, 'Artwork identifier');
  const revisionId = opaque(input.revision_id, 'Revision identifier');
  const nowSeconds = input.now_seconds == null ? Math.floor(Date.now() / 1000) : input.now_seconds;
  if (!integer(nowSeconds, 1)) throw new HttpError(400, 'Current time is invalid');
  const target = await targetRevision(database, artworkId, revisionId);
  const currentPrice = integer(target.base_price_cents, 1, MAX_CENTS) ? target.base_price_cents : null;
  const pricingPreference = await getPricingPreference(database, artworkId);
  if (!pricingPreference) {
    throw new HttpError(409, 'Save a positive seller price floor before requesting price guidance', {code: 'PRICE_FLOOR_REQUIRED'});
  }
  const floor = pricingPreference.seller_floor_cents;
  if (!integer(floor, 1, currentPrice ?? MAX_CENTS)) {
    throw new HttpError(409, 'The saved seller price floor is no longer valid for the current price', {code: 'PRICE_FLOOR_INVALID'});
  }
  const assessment = await getActiveAssessment(database, revisionId);
  if (!['allow', 'human_approved'].includes(assessment?.effective_decision)) {
    throw new HttpError(409, 'Canonical listing review must allow this exact revision before price guidance is available', {code: 'COMPLIANCE_REQUIRED'});
  }

  const [comparables, demand] = await Promise.all([
    verifiedComparables(database, target, nowSeconds),
    listingEvidence(database, target, nowSeconds)
  ]);
  const initial = enforceInitialSellerFloor(suggestInitialPrice({comparables}, {nowSeconds}), floor);
  let markdown = currentPrice == null
    ? unavailableMarkdown('Save a positive current price before requesting stale-listing guidance.')
    : unavailableMarkdown('Publish this exact revision before requesting stale-listing guidance.');
  if (demand.is_published && currentPrice != null) {
    markdown = relabelMarkdown(suggestMarkdown({
      compliance_decision: assessment.effective_decision,
      original_price_cents: demand.original_price_cents,
      current_price_cents: currentPrice,
      seller_floor_cents: floor,
      listing_age_days: demand.listing_age_days,
      days_since_price_change: demand.days_since_price_change,
      qualified_views: demand.qualified_demand_events,
      recent_carts: demand.recent_quote_requests,
      recent_inquiries: 0,
      recent_checkout_starts: demand.recent_checkout_starts
    }));
  }
  const latestAssessment = await getActiveAssessment(database, revisionId);
  if (
    latestAssessment?.id !== assessment.id ||
    !['allow', 'human_approved'].includes(latestAssessment?.effective_decision)
  ) {
    throw new HttpError(409, 'Canonical listing review changed while price guidance was being prepared', {code: 'COMPLIANCE_CHANGED'});
  }
  return {
    initial,
    markdown,
    pricing_preference: pricingPreference,
    evidence: {
      currency: 'USD',
      comparable_source: 'verified_paid_nyahs_ark_orders',
      comparable_candidates: comparables.length,
      comparable_revision_ids: [...new Set(comparables.map((row) => row.revision_id))].sort(),
      ...demand,
      seller_floor_cents: floor,
      compliance_assessment_id: assessment.id,
      compliance_policy_version: assessment.policy_version,
      seller_confirmation_required: true,
      automatic_price_change: false
    }
  };
}
