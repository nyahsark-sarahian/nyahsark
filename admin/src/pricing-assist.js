const MAX_CENTS = 100_000_000;
const MIN_COMPARABLES = 3;
const DAY_SECONDS = 86_400;

const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function finite(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function weightedQuantile(rows, quantile) {
  const ordered = [...rows].sort((a, b) => a.price_cents - b.price_cents || a.id.localeCompare(b.id));
  const total = ordered.reduce((sum, row) => sum + row.weight, 0);
  const target = total * quantile;
  let cumulative = 0;
  for (const row of ordered) {
    cumulative += row.weight;
    if (cumulative >= target) return row.price_cents;
  }
  return ordered.at(-1).price_cents;
}

function normalizeComparable(value, nowSeconds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.source_type !== 'verified_sale' || value.currency !== 'USD') return null;
  if (!integer(value.price_cents, 1, MAX_CENTS) || !integer(value.sold_at, 1, nowSeconds)) return null;
  if (!finite(value.similarity_score, 0.5, 1)) return null;
  const id = typeof value.id === 'string' && value.id.length >= 3 && value.id.length <= 160 ? value.id : null;
  if (!id) return null;
  const ageDays = Math.max(0, (nowSeconds - value.sold_at) / DAY_SECONDS);
  if (ageDays > 1095) return null;
  const recencyWeight = Math.max(0.35, 1 - ageDays / 1095);
  return {
    id,
    price_cents: value.price_cents,
    sold_at: value.sold_at,
    similarity_score: value.similarity_score,
    weight: value.similarity_score ** 2 * recencyWeight
  };
}

export function suggestInitialPrice(input, {nowSeconds = Math.floor(Date.now() / 1000)} = {}) {
  if (!integer(nowSeconds, 1)) throw new TypeError('Current time is invalid');
  const comparables = Array.isArray(input?.comparables)
    ? input.comparables.map((item) => normalizeComparable(item, nowSeconds)).filter(Boolean)
    : [];
  const unique = [...new Map(comparables.map((item) => [item.id, item])).values()];
  if (unique.length < MIN_COMPARABLES) {
    return {
      status: 'insufficient_evidence',
      currency: 'USD',
      comparable_count: unique.length,
      minimum_comparables: MIN_COMPARABLES,
      reason: 'At least three recent, verified, genuinely comparable sales are required.'
    };
  }

  const low = weightedQuantile(unique, 0.25);
  const midpoint = weightedQuantile(unique, 0.5);
  const high = weightedQuantile(unique, 0.75);
  const meanSimilarity = unique.reduce((sum, row) => sum + row.similarity_score, 0) / unique.length;
  const confidence = unique.length >= 8 && meanSimilarity >= 0.75
    ? 'high'
    : unique.length >= 5 && meanSimilarity >= 0.65
      ? 'medium'
      : 'low';
  return {
    status: 'suggested',
    currency: 'USD',
    low_cents: low,
    midpoint_cents: midpoint,
    high_cents: high,
    confidence,
    comparable_count: unique.length,
    comparable_ids: unique.map((row) => row.id).sort(),
    seller_confirmation_required: true,
    automatic_price_change: false
  };
}

function noMarkdown(reason, details = {}) {
  return {status: 'no_recommendation', reason, automatic_price_change: false, ...details};
}

export function suggestMarkdown(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Listing metrics are required');
  const decision = input.compliance_decision;
  if (!['pending', 'allow', 'review', 'block', 'error', 'human_approved', 'human_blocked', 'request_information'].includes(decision)) {
    throw new TypeError('Compliance decision is invalid');
  }
  if (!['allow', 'human_approved'].includes(decision)) return noMarkdown('Compliance review must allow the listing before pricing advice is available.');
  if (!integer(input.current_price_cents, 1, MAX_CENTS)) throw new TypeError('Current price is invalid');
  if (!integer(input.original_price_cents, 1, MAX_CENTS)) throw new TypeError('Original listing price is invalid');
  if (!integer(input.seller_floor_cents, 0, input.current_price_cents)) throw new TypeError('Seller price floor is invalid');
  for (const field of ['listing_age_days', 'days_since_price_change', 'qualified_views', 'recent_carts', 'recent_inquiries', 'recent_checkout_starts']) {
    if (!integer(input[field], 0, 1_000_000)) throw new TypeError(`${field} is invalid`);
  }
  const cooldownDays = integer(input.cooldown_days, 1, 365) ? input.cooldown_days : 30;
  const maximumPercent = integer(input.maximum_markdown_percent, 1, 50) ? input.maximum_markdown_percent : 15;
  if (input.listing_age_days < 45) return noMarkdown('The listing is too new for a markdown recommendation.');
  if (input.days_since_price_change < cooldownDays) return noMarkdown('Wait for the price-change cooldown before recommending another markdown.', {cooldown_days: cooldownDays});
  if (input.recent_checkout_starts > 0) return noMarkdown('Recent checkout activity suggests reviewing checkout friction before lowering the price.');
  if (input.seller_floor_cents <= 0) return noMarkdown('Set a positive seller price floor before requesting a markdown recommendation.');
  if (input.seller_floor_cents >= input.original_price_cents) {
    return noMarkdown('The seller-defined price floor leaves no room for a markdown from the original listing price.');
  }

  const targetPercent = Math.min(
    input.listing_age_days >= 135 ? 15 : input.listing_age_days >= 90 ? 10 : 5,
    maximumPercent
  );
  const scheduledPrice = Math.round(input.original_price_cents * (100 - targetPercent) / 100);
  const maximumFloorPercent = Math.floor(
    ((input.original_price_cents - input.seller_floor_cents) * 100) / input.original_price_cents
  );
  const effectivePercent = Math.min(targetPercent, maximumFloorPercent);
  if (!effectivePercent) return noMarkdown('The seller-defined price floor leaves no room for a whole-percent markdown.');
  const proposed = Math.round(input.original_price_cents * (100 - effectivePercent) / 100);
  if (input.current_price_cents <= proposed) {
    return noMarkdown('The current price is already at or below the scheduled target from the original listing price.', {
      target_markdown_percent: targetPercent,
      scheduled_price_cents: scheduledPrice
    });
  }
  return {
    status: 'suggested',
    original_price_cents: input.original_price_cents,
    current_price_cents: input.current_price_cents,
    proposed_price_cents: proposed,
    suggested_markdown_percent: effectivePercent,
    target_markdown_percent: targetPercent,
    scheduled_price_cents: scheduledPrice,
    seller_floor_cents: input.seller_floor_cents,
    rationale: [
      `The listing has been active for ${input.listing_age_days} days.`,
      `The ${targetPercent}% schedule is anchored to the original listing price, not the latest reduced price.`,
      `${input.qualified_views} provider-created checkout session${input.qualified_views === 1 ? '' : 's'} are recorded; this signal does not alter the age schedule.`,
      proposed > scheduledPrice ? 'The seller-defined floor limited the scheduled markdown.' : 'The seller-defined floor permits the scheduled markdown.'
    ],
    seller_confirmation_required: true,
    automatic_price_change: false
  };
}
