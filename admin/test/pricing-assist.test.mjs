import assert from 'node:assert/strict';
import {test} from 'node:test';
import {suggestInitialPrice, suggestMarkdown} from '../src/pricing-assist.js';

const NOW = 2_000_000_000;
const sold = (id, price, similarity = 0.8, days = 30) => ({
  id,
  source_type: 'verified_sale',
  currency: 'USD',
  price_cents: price,
  similarity_score: similarity,
  sold_at: NOW - days * 86_400
});

test('initial price advice requires verified recent sold comparables and never changes the price', () => {
  const weak = suggestInitialPrice({comparables: [
    sold('one', 10_000),
    {...sold('asking', 50_000), source_type: 'asking_price'},
    {...sold('old', 12_000), sold_at: NOW - 1_200 * 86_400}
  ]}, {nowSeconds: NOW});
  assert.equal(weak.status, 'insufficient_evidence');
  assert.equal(weak.comparable_count, 1);

  const result = suggestInitialPrice({comparables: [
    sold('one', 10_000), sold('two', 12_000, 0.9), sold('three', 14_000, 0.75), sold('four', 50_000, 0.49)
  ]}, {nowSeconds: NOW});
  assert.equal(result.status, 'suggested');
  assert.equal(result.comparable_count, 3);
  assert.equal(result.midpoint_cents, 12_000);
  assert.equal(result.automatic_price_change, false);
  assert.equal(result.seller_confirmation_required, true);
});

test('markdown advice uses the approved age schedule, original price, cooldown, and seller floor', () => {
  const base = {
    compliance_decision: 'allow', original_price_cents: 20_000, current_price_cents: 20_000, seller_floor_cents: 15_000,
    listing_age_days: 95, days_since_price_change: 30, qualified_views: 100,
    recent_carts: 0, recent_inquiries: 0, recent_checkout_starts: 0
  };
  assert.equal(suggestMarkdown({...base, compliance_decision: 'review'}).status, 'no_recommendation');
  assert.equal(suggestMarkdown({...base, qualified_views: 0}).status, 'suggested');
  assert.equal(suggestMarkdown({...base, recent_checkout_starts: 1}).status, 'no_recommendation');
  assert.equal(suggestMarkdown({...base, listing_age_days: 44}).status, 'no_recommendation');
  assert.equal(suggestMarkdown({...base, days_since_price_change: 29}).status, 'no_recommendation');
  assert.equal(suggestMarkdown({...base, seller_floor_cents: 0}).status, 'no_recommendation');

  const result = suggestMarkdown(base);
  assert.equal(result.status, 'suggested');
  assert.equal(result.target_markdown_percent, 10);
  assert.equal(result.suggested_markdown_percent, 10);
  assert.equal(result.proposed_price_cents, 18_000);
  assert.equal(result.automatic_price_change, false);

  const day45 = suggestMarkdown({...base, listing_age_days: 45});
  assert.equal(day45.target_markdown_percent, 5);
  assert.equal(day45.proposed_price_cents, 19_000);
  const day90 = suggestMarkdown({...base, listing_age_days: 90});
  assert.equal(day90.target_markdown_percent, 10);
  const day135 = suggestMarkdown({...base, listing_age_days: 135});
  assert.equal(day135.target_markdown_percent, 15);
  assert.equal(day135.proposed_price_cents, 17_000);

  const floored = suggestMarkdown({...base, seller_floor_cents: 19_500});
  assert.equal(floored.target_markdown_percent, 10);
  assert.equal(floored.suggested_markdown_percent, 2);
  assert.equal(floored.proposed_price_cents, 19_600);
});

test('markdown schedule never compounds past the original-price target', () => {
  const base = {
    compliance_decision: 'allow', original_price_cents: 20_000, current_price_cents: 19_000, seller_floor_cents: 12_000,
    listing_age_days: 90, days_since_price_change: 30, qualified_views: 100,
    recent_carts: 0, recent_inquiries: 0, recent_checkout_starts: 0
  };
  const result = suggestMarkdown(base);
  assert.equal(result.status, 'suggested');
  assert.equal(result.proposed_price_cents, 18_000);
  assert.equal(result.target_markdown_percent, 10);
  assert.equal(suggestMarkdown({...base, current_price_cents: 18_000}).status, 'no_recommendation');
});

test('pricing inputs fail closed when money or metrics are malformed', () => {
  assert.throws(() => suggestMarkdown({}), /compliance/i);
  assert.throws(() => suggestInitialPrice({comparables: []}, {nowSeconds: 0}), /time/i);
});
