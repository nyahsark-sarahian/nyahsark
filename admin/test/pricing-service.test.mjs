import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {getListingPriceGuidance} from '../src/pricing-service.js';

const DAY = 86_400;
const NOW = 1_800_000_000;
const migrations = [
  '0001_legacy_inventory.sql','0002_private_image_objects.sql','0003_revisioned_catalog.sql',
  '0004_settings_commands.sql','0005_listing_compliance.sql','0006_ai_governance.sql'
].map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const sql of migrations) sqlite.exec(sql);
  const wrap = (sql, values = []) => ({
    bind(...next) { return wrap(sql, next); },
    run() { const meta = sqlite.prepare(sql).run(...values); return {meta: {changes: Number(meta.changes)}}; },
    first() { return sqlite.prepare(sql).get(...values) ?? null; },
    all() { return {results: sqlite.prepare(sql).all(...values)}; }
  });
  const DB = {prepare(sql) { return wrap(sql); }};
  return {sqlite, DB};
}

function seedArtwork(sqlite, {
  suffix,
  price = 10_000,
  category = 'Devotional art',
  objectKind = 'ordinary_devotional',
  width = 80,
  height = 64,
  published = true,
  allowed = true,
  sellerFloor = price == null ? 5_000 : Math.max(1, Math.floor(price * 0.75)),
  createdAt = NOW - (120 * DAY)
}) {
  const artwork = `artwork-${suffix}`;
  const revision = `revision-${suffix}`;
  const stable = `art-${suffix}`;
  const snapshot = {title: `Artwork ${suffix}`,category,base_price_cents:price,width_eighths:width,height_eighths:height,offered_for_sale:true};
  sqlite.prepare('INSERT INTO catalog_artworks(id,stable_id) VALUES(?,?)').run(artwork,stable);
  sqlite.prepare(`INSERT INTO catalog_artwork_revisions(
    id,artwork_id,revision_number,title,category,base_price_cents,width_eighths,height_eighths,
    offered_for_sale,snapshot_json,content_hash,actor,created_at
  ) VALUES(?,?,1,?,?,?,?,?,1,?,'1234567890abcdef','test',?)`).run(
    revision,artwork,snapshot.title,category,price,width,height,JSON.stringify(snapshot),createdAt
  );
  sqlite.prepare(`INSERT INTO catalog_revision_disclosures(
    revision_id,object_kind,blessed_or_dedicated,purported_relic,contains_human_material,provenance_known,
    ecclesiastical_owner,authenticity_document,spiritual_benefit_priced,seller_attested,actor
  ) VALUES(?,?,'no','no','no','yes','no','no','no',1,'test')`).run(revision,objectKind);
  sqlite.prepare(`INSERT INTO catalog_artwork_heads(
    artwork_id,working_revision_id,published_revision_id,last_published_revision_id,working_version
  ) VALUES(?,?,?,?,1)`).run(artwork,revision,published ? revision : null,published ? revision : null);
  sqlite.prepare('INSERT INTO catalog_inventory(artwork_id,physical_stock) VALUES(?,1)').run(artwork);
  if (allowed) sqlite.prepare(`INSERT INTO catalog_compliance_assessments(
    id,artwork_id,revision_id,policy_version,decision,source,reason_codes_json,messages_json,citations_json,actor,created_at
  ) VALUES(?,?,?,'canonical-listing-v1','allow','deterministic','[]','[]','[]','test',?)`).run(
    `assessment-${suffix}`,artwork,revision,createdAt
  );
  sqlite.prepare(`INSERT INTO catalog_listing_price_floors(id,artwork_id,seller_floor_cents,actor,created_at)
    VALUES(?,?,?,'test',?)`).run(`floor-${suffix}`,artwork,sellerFloor,createdAt);
  return {artwork,revision};
}

function seedQuote(sqlite, {suffix, artwork, revision, createdAt = NOW - (40 * DAY), price = 10_000}) {
  const quote = `quote-${suffix}`;
  const configuration = `configuration-${suffix}`;
  sqlite.prepare('INSERT OR IGNORE INTO catalog_configurations(id,artwork_id) VALUES(?,?)').run(configuration,artwork);
  sqlite.prepare(`INSERT INTO catalog_quotes(
    id,status,currency,merchandise_cents,shipping_cents,handling_cents,tax_cents,grand_total_cents,
    address_json,catalog_version,settings_version,expires_at,created_at
  ) VALUES(?,'ready','USD',?,0,0,0,?,'{}','version',0,?,?)`).run(
    quote,price,price,createdAt + DAY,createdAt
  );
  sqlite.prepare(`INSERT INTO catalog_quote_lines(
    quote_id,line_number,artwork_id,revision_id,configuration_id,quantity,unit_price_cents,line_total_cents,snapshot_json
  ) VALUES(?,0,?,?,?,?,?,?,?)`).run(
    quote,artwork,revision,configuration,1,price,price,JSON.stringify({revision_id:revision})
  );
  return {quote,configuration};
}

function seedPaymentSession(sqlite, {suffix, artwork, revision, createdAt = NOW - (40 * DAY), price = 10_000}) {
  const {quote,configuration} = seedQuote(sqlite,{suffix:`intent-${suffix}`,artwork,revision,createdAt,price});
  const order=`order-intent-${suffix}`;
  sqlite.prepare(`INSERT INTO catalog_orders(
    id,order_number,quote_id,idempotency_key,payment_status,fulfillment_status,currency,merchandise_cents,
    shipping_cents,handling_cents,tax_cents,grand_total_cents,delivery_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,'unfulfilled','USD',?,0,0,0,?,'{}',?,?)`).run(
    order,`NYA-INTENT-${suffix}`,quote,`checkout-intent-${suffix}`,'pending',price,price,createdAt,createdAt
  );
  sqlite.prepare(`INSERT INTO catalog_order_lines(
    order_id,line_number,artwork_id,configuration_id,quantity,unit_price_cents,line_total_cents,snapshot_json
  ) VALUES(?,0,?,?,?,?,?,?)`).run(
    order,artwork,configuration,1,price,price,JSON.stringify({revision_id:revision})
  );
  sqlite.prepare(`INSERT INTO catalog_payment_attempts(
    id,order_id,provider,provider_session_id,mode,status,idempotency_key,created_at,updated_at
  ) VALUES(?,?,?,?,'sandbox','ready',?,?,?)`).run(
    `attempt-${suffix}`,order,'test-provider',`session-${suffix}`,`payment-intent-${suffix}`,createdAt,createdAt
  );
  sqlite.prepare("UPDATE catalog_quotes SET status='consumed' WHERE id=?").run(quote);
  return {order,quote};
}

function seedOrder(sqlite, {
  suffix,
  artwork,
  revision,
  price,
  status = 'paid',
  createdAt = NOW - (100 * DAY),
  category = 'Devotional art',
  objectKind = 'ordinary_devotional',
  width = 80,
  height = 64
}) {
  const comparable = seedArtwork(sqlite, {
    suffix:`comparable-${suffix}`,price,category,objectKind,width,height,published:true,allowed:true,createdAt
  });
  const {quote,configuration} = seedQuote(sqlite, {
    suffix:`sale-${suffix}`,artwork:comparable.artwork,revision:comparable.revision,createdAt,price
  });
  const order = `order-${suffix}`;
  sqlite.prepare(`INSERT INTO catalog_orders(
    id,order_number,quote_id,idempotency_key,payment_status,fulfillment_status,currency,merchandise_cents,
    shipping_cents,handling_cents,tax_cents,grand_total_cents,delivery_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,'unfulfilled','USD',?,0,0,0,?,'{}',?,?)`).run(
    order,`NYA-${suffix}`,quote,`checkout-${suffix}`,status,price,price,createdAt,createdAt
  );
  sqlite.prepare(`INSERT INTO catalog_order_lines(
    order_id,line_number,artwork_id,configuration_id,quantity,unit_price_cents,line_total_cents,snapshot_json
  ) VALUES(?,0,?,?,?,?,?,?)`).run(
    order,comparable.artwork,configuration,1,price,price,JSON.stringify({revision_id:comparable.revision})
  );
  return comparable;
}

test('initial guidance uses only verified paid, genuinely similar internal sales', async () => {
  const {sqlite,DB} = database();
  const target = seedArtwork(sqlite,{suffix:'target-paid'});
  seedOrder(sqlite,{suffix:'paid-1',artwork:target.artwork,revision:target.revision,price:8_000});
  seedOrder(sqlite,{suffix:'paid-2',artwork:target.artwork,revision:target.revision,price:10_000});
  seedOrder(sqlite,{suffix:'paid-3',artwork:target.artwork,revision:target.revision,price:12_000});
  seedOrder(sqlite,{suffix:'pending',artwork:target.artwork,revision:target.revision,price:90_000,status:'pending'});
  seedOrder(sqlite,{suffix:'unrelated',artwork:target.artwork,revision:target.revision,price:99_000,category:'Furniture',objectKind:'other',width:800,height:640});
  const result = await getListingPriceGuidance(DB,{artwork_id:target.artwork,revision_id:target.revision,now_seconds:NOW});
  assert.equal(result.initial.status,'suggested');
  assert.equal(result.initial.comparable_count,3);
  assert.deepEqual([result.initial.low_cents,result.initial.midpoint_cents,result.initial.high_cents],[8_000,10_000,12_000]);
  assert.equal(result.evidence.comparable_source,'verified_paid_nyahs_ark_orders');
  assert.equal(result.evidence.compliance_assessment_id,'assessment-target-paid');
  assert.equal(result.evidence.compliance_policy_version,'canonical-listing-v1');
  assert.equal(result.evidence.automatic_price_change,false);
});
test('initial range can price a new sale draft before a current price exists', async () => {
  const {sqlite,DB} = database();
  const target = seedArtwork(sqlite,{suffix:'target-unpriced',price:null,published:false});
  seedOrder(sqlite,{suffix:'unpriced-1',artwork:target.artwork,revision:target.revision,price:7_500});
  seedOrder(sqlite,{suffix:'unpriced-2',artwork:target.artwork,revision:target.revision,price:9_000});
  seedOrder(sqlite,{suffix:'unpriced-3',artwork:target.artwork,revision:target.revision,price:11_000});
  const result = await getListingPriceGuidance(DB,{artwork_id:target.artwork,revision_id:target.revision,now_seconds:NOW});
  assert.equal(result.initial.status,'suggested');
  assert.equal(result.initial.midpoint_cents,9_000);
  assert.equal(result.markdown.status,'no_recommendation');
  assert.match(result.markdown.reason,/positive current price/i);
});

test('initial price guidance never recommends below the persisted seller floor', async () => {
  const {sqlite,DB} = database();
  const target = seedArtwork(sqlite,{suffix:'target-floor-above-market',price:null,published:false,sellerFloor:12_000});
  seedOrder(sqlite,{suffix:'floor-market-1',artwork:target.artwork,revision:target.revision,price:7_500});
  seedOrder(sqlite,{suffix:'floor-market-2',artwork:target.artwork,revision:target.revision,price:9_000});
  seedOrder(sqlite,{suffix:'floor-market-3',artwork:target.artwork,revision:target.revision,price:11_000});
  const result = await getListingPriceGuidance(DB,{artwork_id:target.artwork,revision_id:target.revision,now_seconds:NOW});
  assert.equal(result.initial.status,'no_recommendation');
  assert.equal(result.initial.seller_floor_cents,12_000);
  assert.deepEqual(result.initial.market_range,{low_cents:7_500,midpoint_cents:9_000,high_cents:11_000});
  assert.match(result.initial.reason,/below the saved seller floor/i);
});

test('price guidance fails closed without an exact active-policy allowance', async () => {
  const {sqlite,DB} = database();
  const target = seedArtwork(sqlite,{suffix:'target-held',allowed:false});
  await assert.rejects(
    () => getListingPriceGuidance(DB,{artwork_id:target.artwork,revision_id:target.revision,now_seconds:NOW}),
    (error) => error.status===409 && error.details?.code==='COMPLIANCE_REQUIRED'
  );
});

test('insufficient comparable sales remains honest while age guidance has no hidden traffic gate', async () => {
  const {sqlite,DB} = database();
  const target = seedArtwork(sqlite,{suffix:'target-insufficient',sellerFloor:9_000});
  const result = await getListingPriceGuidance(DB,{artwork_id:target.artwork,revision_id:target.revision,now_seconds:NOW});
  assert.equal(result.initial.status,'insufficient_evidence');
  assert.equal(result.initial.comparable_count,0);
  assert.equal(result.markdown.status,'suggested');
  assert.equal(result.markdown.proposed_price_cents,9_000);
  assert.equal(result.evidence.qualified_demand_events,0);
  assert.equal(result.evidence.inquiries_tracked,false);
});

test('stale-listing markdown uses saved demand evidence, respects seller floor, and writes nothing', async () => {
  const {sqlite,DB} = database();
  const target = seedArtwork(sqlite,{suffix:'target-stale',price:10_000,sellerFloor:9_500,createdAt:NOW-(120*DAY)});
  for(let index=0;index<20;index++) seedPaymentSession(sqlite,{
    suffix:`demand-${String(index).padStart(2,'0')}`,artwork:target.artwork,revision:target.revision,createdAt:NOW-(40*DAY)-index,price:10_000
  });
  const before = Number(sqlite.prepare('SELECT total_changes() AS n').get().n);
  const result = await getListingPriceGuidance(DB,{artwork_id:target.artwork,revision_id:target.revision,now_seconds:NOW});
  const after = Number(sqlite.prepare('SELECT total_changes() AS n').get().n);
  assert.equal(result.markdown.status,'suggested');
  assert.equal(result.markdown.suggested_markdown_percent,5);
  assert.equal(result.markdown.target_markdown_percent,10);
  assert.equal(result.markdown.proposed_price_cents,9_500);
  assert.equal(result.markdown.automatic_price_change,false);
  assert.equal(result.evidence.qualified_demand_events,20);
  assert.equal(result.evidence.qualified_demand_source,'provider_created_payment_sessions');
  assert.equal(after,before);
});

test('ready quote requests remain reported evidence but do not gate the approved age schedule', async () => {
  const {sqlite,DB} = database();
  const target = seedArtwork(sqlite,{suffix:'target-quotes-only',price:10_000,sellerFloor:9_000,createdAt:NOW-(120*DAY)});
  for(let index=0;index<20;index++) seedQuote(sqlite,{
    suffix:`quote-only-${String(index).padStart(2,'0')}`,artwork:target.artwork,revision:target.revision,createdAt:NOW-(40*DAY)-index,price:10_000
  });
  const result = await getListingPriceGuidance(DB,{artwork_id:target.artwork,revision_id:target.revision,now_seconds:NOW});
  assert.equal(result.markdown.status,'suggested');
  assert.equal(result.markdown.proposed_price_cents,9_000);
  assert.equal(result.evidence.qualified_demand_events,0);
  assert.equal(result.evidence.recent_quote_requests,0);
});

test('republishing unchanged copy or photos does not reset the 30-day price-change cooldown', async () => {
  const {sqlite,DB} = database();
  const target = seedArtwork(sqlite,{suffix:'target-republished',price:10_000,sellerFloor:9_000,createdAt:NOW-(120*DAY)});
  // Historical publish commands are seeded directly here so the test isolates
  // pricing evidence rather than the separate publication-readiness guard.
  sqlite.exec('DROP TRIGGER catalog_publish_guard');
  const insert = sqlite.prepare(`INSERT INTO catalog_publish_commands(
    id,artwork_id,revision_id,expected_head_version,quantity_changed,actor,created_at
  ) VALUES(?,?,?,1,0,'test',?)`);
  insert.run('publish-original',target.artwork,target.revision,NOW-(120*DAY));
  insert.run('publish-copy-only',target.artwork,target.revision,NOW-DAY);
  const result = await getListingPriceGuidance(DB,{artwork_id:target.artwork,revision_id:target.revision,now_seconds:NOW});
  assert.equal(result.evidence.listing_age_days,120);
  assert.equal(result.evidence.days_since_price_change,120);
  assert.equal(result.markdown.status,'suggested');
  assert.equal(result.markdown.proposed_price_cents,9_000);
});
