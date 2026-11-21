import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationPrice, formatEighths, idempotencyKeyForQuote, money, normalizeArtwork, sanitizeCart } from '../../public/catalog.js';

test('cart persistence contains references and quantities only', () => {
  const cart = sanitizeCart([
    { artwork_id: 'art-001', configuration_id: 'frame_a', quantity: 2, title: 'must be removed', price: 1 },
    { artwork_id: 'bad id', configuration_id: 'x', quantity: 1 },
    { artwork_id: 'art-001', configuration_id: 'frame_a', quantity: 3 }
  ]);
  assert.deepEqual(cart, [{ artwork_id: 'art-001', configuration_id: 'frame_a', quantity: 2 }]);
});

test('checkout retries reuse one idempotency key for the same quote', () => {
  const state = {quoteId: null, key: null};
  let calls = 0;
  const create = () => `checkout-key-${++calls}`;
  assert.equal(idempotencyKeyForQuote('quote-0001', state, create), 'checkout-key-1');
  assert.equal(idempotencyKeyForQuote('quote-0001', state, create), 'checkout-key-1');
  assert.equal(idempotencyKeyForQuote('quote-0002', state, create), 'checkout-key-2');
});

test('normalizes a revisioned published artwork without inventing values', () => {
  const art = normalizeArtwork({
    stable_id: 'art-001', available_quantity: 1, sale_ready: true,
    published_revision: { snapshot: { title: 'Test', description: 'Description', category: 'Devotional art', base_price_cents: 10000, width_eighths: 99, height_eighths: 80, offered_for_sale: true, photos: [{ asset_id: 'photo_a', alt: 'View', position: 0, is_main: true }], configurations: [{ id: 'frame_a', label: 'Frame', enabled: true, price_add_on_cents: 2500, packing_profile_id: 'pack_a' }] } }
  });
  assert.equal(art.title, 'Test');
  assert.equal(art.photos[0].url, '/catalog-media/photo_a/display');
  assert.equal(configurationPrice(art, art.configurations[0]), 12500);
  assert.equal(formatEighths(art.width_eighths), '12 3/8 in');
});

test('display-only and unknown values stay unknown', () => {
  const art = normalizeArtwork({ id: 'art-009', title: 'Display', offered_for_sale: false, photos: [{ path: '/art-009-1.jpg' }] });
  assert.equal(art.base_price_cents, null);
  assert.equal(art.available_quantity, null);
  assert.equal(art.sale_ready, false);
  assert.equal(money(null), null);
});

test('sale readiness stays false without inventory or packing data', () => {
  const art = normalizeArtwork({ id: 'art-003', title: 'Incomplete', offered_for_sale: true, base_price_cents: 1000, sale_ready: true, configurations: [{ id: 'frame_a', label: 'Frame', enabled: true, price_add_on_cents: 0 }] });
  assert.equal(art.sale_ready, false);
  assert.equal(art.available_quantity, null);
});

test('an explicit main photo is not overridden by sequence order', () => {
  const art = normalizeArtwork({ id: 'art-002', title: 'Views', photos: [{ path: '/one.jpg', is_main: false }, { path: '/two.jpg', is_main: true }] });
  assert.equal(art.photos[0].is_main, false);
  assert.equal(art.photos[1].is_main, true);
});
