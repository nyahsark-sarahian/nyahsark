import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {
  CANONICAL_CITATIONS,
  POLICY_VERSION,
  disclosureInsertStatement,
  evaluatePolicy,
  getActiveAssessment,
  getAssessment,
  getLatestAssetObservation,
  getLatestAiSuggestion,
  normalizeDisclosures,
  runDeterministicAssessment,
  saveAiSuggestion,
  saveAssessment,
  saveAssetObservation,
  saveHumanReview,
  validateDisclosures
} from '../src/compliance.js';

const migrationNames = [
  '0001_legacy_inventory.sql',
  '0002_private_image_objects.sql',
  '0003_revisioned_catalog.sql',
  '0004_settings_commands.sql',
  '0005_listing_compliance.sql'
];

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrationNames) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const wrap = (sql, values = []) => ({
    bind(...next) { return wrap(sql, next); },
    run() { const result = sqlite.prepare(sql).run(...values); return {meta: {changes: Number(result.changes)}}; },
    first() { return sqlite.prepare(sql).get(...values) ?? null; },
    all() { return {results: sqlite.prepare(sql).all(...values)}; }
  });
  const DB = {
    prepare(sql) { return wrap(sql); },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const output = [];
        for (const statement of statements) output.push(await statement.run());
        sqlite.exec('COMMIT');
        return output;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return {sqlite, DB};
}

const clearDisclosures = Object.freeze({
  object_kind: 'ordinary_devotional',
  blessed_or_dedicated: 'no',
  purported_relic: 'no',
  relic_class_claim: null,
  contains_human_material: 'no',
  provenance_known: 'yes',
  ecclesiastical_owner: 'no',
  authenticity_document: 'no',
  spiritual_benefit_priced: 'no',
  seller_attested: true
});

function seedSale(sqlite, suffix, disclosures = clearDisclosures, listing = {}) {
  const artwork = `artwork-${suffix}`;
  const revision = `revision-${suffix}`;
  const asset = `asset-${suffix}`;
  const packing = `packing-${suffix}`;
  const configuration = `configuration-${suffix}`;
  const snapshot = {
    title: listing.title || 'Sale artwork', description: listing.description || 'Description', category: listing.category || 'Devotional art', base_price_cents: 1000,
    width_eighths: 80, height_eighths: 80, offered_for_sale: true, requested_store_position: null,
    inventory: {quantity_changed: false, intended_available_quantity: null, captured_version: null},
    photos: [{asset_id: asset, alt: 'Main', position: 0, is_main: true}],
    configurations: [{id: configuration, label: 'Artwork', enabled: true, price_add_on_cents: 0, packing_profile_id: packing, position: 0}],
    compliance: disclosures
  };
  sqlite.prepare('INSERT INTO catalog_artworks(id,stable_id) VALUES(?,?)').run(artwork, `stable-${suffix}`);
  sqlite.prepare(`INSERT INTO catalog_artwork_revisions(
    id,artwork_id,revision_number,title,description,category,base_price_cents,width_eighths,height_eighths,
    offered_for_sale,snapshot_json,content_hash,actor
  ) VALUES(?,?,1,?,?,?,?,?,?,1,?,?,?)`).run(
    revision, artwork, snapshot.title, snapshot.description, snapshot.category, snapshot.base_price_cents,
    snapshot.width_eighths, snapshot.height_eighths, JSON.stringify(snapshot), `0123456789abcdef${suffix}`, 'test'
  );
  sqlite.prepare("INSERT INTO catalog_media_assets(id,artwork_id,source_kind,legacy_path,mime_type,state) VALUES(?,?,'legacy_public',?,'image/jpeg','ready')")
    .run(asset, artwork, `/${asset}.jpg`);
  sqlite.prepare('INSERT INTO catalog_revision_photos(revision_id,asset_id,position,is_main,alt_text) VALUES(?,?,0,1,?)').run(revision, asset, 'Main');
  sqlite.prepare("INSERT INTO catalog_packing_profiles(id,label,length_value,width_value,height_value,dimension_unit,weight_value,weight_unit) VALUES(?, 'Box',12,10,3,'in',2,'lb')").run(packing);
  sqlite.prepare('INSERT INTO catalog_configurations(id,artwork_id) VALUES(?,?)').run(configuration, artwork);
  sqlite.prepare(`INSERT INTO catalog_revision_configurations(
    revision_id,configuration_id,label,enabled,price_add_on_cents,packing_profile_id,position
  ) VALUES(?,?,'Artwork',1,0,?,0)`).run(revision, configuration, packing);
  sqlite.prepare(`INSERT INTO catalog_revision_disclosures(
    revision_id,object_kind,blessed_or_dedicated,purported_relic,relic_class_claim,contains_human_material,
    provenance_known,ecclesiastical_owner,authenticity_document,spiritual_benefit_priced,seller_attested,actor
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    revision, disclosures.object_kind, disclosures.blessed_or_dedicated, disclosures.purported_relic,
    disclosures.relic_class_claim, disclosures.contains_human_material, disclosures.provenance_known,
    disclosures.ecclesiastical_owner, disclosures.authenticity_document, disclosures.spiritual_benefit_priced,
    disclosures.seller_attested ? 1 : 0, 'test'
  );
  sqlite.prepare('INSERT INTO catalog_inventory(artwork_id,physical_stock) VALUES(?,1)').run(artwork);
  sqlite.prepare('INSERT INTO catalog_artwork_heads(artwork_id,working_revision_id,working_version) VALUES(?,?,1)').run(artwork, revision);
  return {artwork, revision, asset};
}

function publish(sqlite, item, id) {
  return sqlite.prepare(`INSERT INTO catalog_publish_commands(
    id,artwork_id,revision_id,expected_head_version,quantity_changed,actor
  ) VALUES(?,?,?,1,0,'test')`).run(id, item.artwork, item.revision);
}

test('disclosure normalization is backward compatible while validation is strict', () => {
  assert.deepEqual(normalizeDisclosures(), {
    object_kind: 'unknown', blessed_or_dedicated: 'unknown', purported_relic: 'unknown', relic_class_claim: null,
    contains_human_material: 'unknown', provenance_known: 'unknown', ecclesiastical_owner: 'unknown',
    authenticity_document: 'unknown', spiritual_benefit_priced: 'unknown', seller_attested: false
  });
  assert.deepEqual(validateDisclosures(clearDisclosures), clearDisclosures);
  assert.throws(() => validateDisclosures({...clearDisclosures, purported_relic: 'maybe'}), /validation errors/i);
  assert.throws(() => validateDisclosures({...clearDisclosures, unsupported: true}), /validation errors/i);
});

test('deterministic policy hard-blocks explicit relic commerce and priced spiritual benefits', () => {
  const relic = evaluatePolicy({offeredForSale: true, disclosures: {...clearDisclosures, object_kind: 'relic', purported_relic: 'yes', relic_class_claim: 'first-class'}});
  assert.equal(relic.decision, 'block');
  assert.deepEqual(relic.reason_codes, ['sacred_relic_sale']);
  assert(relic.citations.some((citation) => citation.code === 'canon_1190_1'));
  const spiritual = evaluatePolicy({offeredForSale: true, disclosures: {...clearDisclosures, spiritual_benefit_priced: 'yes'}});
  assert.equal(spiritual.decision, 'block');
  assert(spiritual.citations.some((citation) => citation.code === 'ccc_2121'));
  assert.equal(CANONICAL_CITATIONS.canon_1190_1.url.startsWith('https://www.vatican.va/'), true);
  const contradictoryCopy = evaluatePolicy({
    offeredForSale: true,
    disclosures: clearDisclosures,
    listingCopy: {title: 'First-class relic of St. Example', description: 'Offered with its case.', category: 'Devotional art'}
  });
  assert.equal(contradictoryCopy.decision, 'block');
  assert(contradictoryCopy.reason_codes.includes('sacred_relic_sale'));
  const pricedCopy = evaluatePolicy({
    offeredForSale: true,
    disclosures: clearDisclosures,
    listingCopy: {title: 'Prayer card', description: 'Price includes a blessing.', category: 'Devotional art'}
  });
  assert.equal(pricedCopy.decision, 'block');
  assert(pricedCopy.reason_codes.includes('spiritual_benefit_sale'));

  const hiddenRelic = evaluatePolicy({
    offeredForSale: true,
    disclosures: clearDisclosures,
    listingCopy: {title: 'Holy re\u200blic', description: '', category: 'Devotional art'}
  });
  assert.equal(hiddenRelic.decision, 'block');
  assert(hiddenRelic.reason_codes.includes('sacred_relic_sale'));
  const hiddenBlessing = evaluatePolicy({
    offeredForSale: true,
    disclosures: clearDisclosures,
    listingCopy: {title: 'Prayer card', description: 'Price includes a bl\u200bessing.', category: 'Devotional art'}
  });
  assert.equal(hiddenBlessing.decision, 'block');
  assert(hiddenBlessing.reason_codes.includes('spiritual_benefit_sale'));

  for (const description of [
    'Blessing 500 dollars',
    'Blessing €500',
    'Includes grace valued at 500 dollars',
    'EUR 500 for the spiritual benefit',
    'Spiritual effect worth £50'
  ]) {
    const result = evaluatePolicy({
      offeredForSale: true,
      disclosures: clearDisclosures,
      listingCopy: {title: 'Prayer card', description, category: 'Devotional art'}
    });
    assert.equal(result.decision, 'block', description);
    assert(result.reason_codes.includes('spiritual_benefit_sale'), description);
  }
});

test('saved listing copy cannot contradict clear disclosures and receive an allowance', async () => {
  const {sqlite, DB} = database();
  const item = seedSale(sqlite, 'copy-block-001', clearDisclosures, {title: 'First-class relic of St. Example'});
  const assessment = await runDeterministicAssessment(DB, {
    artwork_id: item.artwork, revision_id: item.revision, offered_for_sale: true, disclosures: clearDisclosures
  }, 'test');
  assert.equal(assessment.decision, 'block');
  assert(assessment.reason_codes.includes('sacred_relic_sale'));
});

test('saved relic-class and saint-remains formulations cannot bypass contradictory disclosures', () => {
  for (const title of [
    'First-class fragment of Saint John',
    'Mortal remains of Saint Agnes',
    'Ex corpore St. Peter',
    'Ex indumentis St. Therese',
    'Ex vestimentis Saint John',
    'Ex brandea St. Peter',
    'Ex linteo Saint Agnes',
    'Particle of St. Therese',
    'Saint John bone fragment',
    'Body of Saint John',
    'Skull of St. Agnes',
    'Ashes of Saint Peter',
    'Finger of Saint Jude',
    'Clothing worn by Saint Therese'
  ]) {
    const result = evaluatePolicy({offeredForSale:true,disclosures:clearDisclosures,listingCopy:{title,description:'',category:'Devotional art'}});
    assert.equal(result.decision,'block',title);
    assert(result.reason_codes.includes('sacred_relic_sale'),title);
  }
});

test('explicit word and ordinal relic-class claims cannot auto-allow', () => {
  for (const title of [
    'First-class bone',
    'Second-class rosary',
    'Third-class medal',
    '1st-class bone',
    '2nd class rosary',
    '3rd class medal',
    'Rosary, second class'
  ]) {
    const result = evaluatePolicy({offeredForSale:true,disclosures:clearDisclosures,listingCopy:{title,description:'',category:'Devotional art'}});
    assert.equal(result.decision,'block',title);
    assert(result.reason_codes.includes('sacred_relic_sale'),title);
  }
});

test('saved named Passion-relic sale claims cannot bypass contradictory disclosures', () => {
  for (const title of [
    'Piece of the True Cross',
    'Wood from the True Cross',
    'Fragment of the Crown of Thorns',
    'Particle from a Holy Nail',
    'Authentic Holy Nail',
    'Holy Nail from the Crucifixion'
  ]) {
    const result = evaluatePolicy({offeredForSale:true,disclosures:clearDisclosures,listingCopy:{title,description:'',category:'Devotional art'}});
    assert.equal(result.decision,'block',title);
    assert(result.reason_codes.includes('sacred_relic_sale'),title);
  }
});

test('saved ambiguous sacred-object and human-material copy requires human review', () => {
  const blessed = evaluatePolicy({
    offeredForSale: true,
    disclosures: clearDisclosures,
    listingCopy: {title: 'Blessed rosary', description: '', category: 'Devotional art'}
  });
  assert.equal(blessed.decision, 'review');
  assert(blessed.reason_codes.includes('copy_blessed_or_dedicated'));
  const humanMaterial = evaluatePolicy({
    offeredForSale: true,
    disclosures: clearDisclosures,
    listingCopy: {title: 'Medal in case', description: 'Small bone fragment is visible.', category: 'Devotional art'}
  });
  assert.equal(humanMaterial.decision, 'review');
  assert(humanMaterial.reason_codes.includes('copy_possible_human_material'));

  const provenance = evaluatePolicy({
    offeredForSale: true,
    disclosures: clearDisclosures,
    listingCopy: {title: 'Book belonging to Saint John', description: '', category: 'Devotional art'}
  });
  assert.equal(provenance.decision, 'review');
  assert(provenance.reason_codes.includes('copy_saint_provenance'));

  const replicaLikeNamedRelic = evaluatePolicy({
    offeredForSale: true,
    disclosures: clearDisclosures,
    listingCopy: {title: 'Holy Nail pendant', description: 'Decorative devotional pendant.', category: 'Devotional art'}
  });
  assert.equal(replicaLikeNamedRelic.decision, 'review');
  assert(replicaLikeNamedRelic.reason_codes.includes('copy_named_relic_language'));
});

test('photos can request review but cannot create a photo-only hard block', () => {
  const assessment = evaluatePolicy({
    offeredForSale: true,
    disclosures: clearDisclosures,
    observations: [{code: 'possible_reliquary', summary: 'Round sealed cavity', evidence: 'center', confidence: 0.91}]
  });
  assert.equal(assessment.decision, 'review');
  assert(assessment.reason_codes.includes('possible_reliquary'));
  const displayOnly = evaluatePolicy({offeredForSale: false, disclosures: {...clearDisclosures, object_kind: 'relic', purported_relic: 'yes'}});
  assert.equal(displayOnly.decision, 'allow');
  assert.deepEqual(displayOnly.reason_codes, ['display_only']);

  const adapterAliases = evaluatePolicy({
    offeredForSale: true,
    disclosures: clearDisclosures,
    observations: [
      {code: 'visible_reliquary_features', summary: 'Sealed cavity is visible', evidence: 'front', confidence: 0.91},
      {code: 'possible_human_material', summary: 'Material is uncertain', evidence: 'detail', confidence: 0.51},
      {code: 'relic_terms_visible', summary: 'Relic terminology is visible', evidence: 'label', confidence: 0.88},
      {code: 'authenticity_document_visible', summary: 'Document is visible', evidence: 'second photo', confidence: 0.82}
    ]
  });
  assert.equal(adapterAliases.decision, 'review');
  assert.deepEqual(adapterAliases.reason_codes, [
    'possible_reliquary', 'possible_human_material', 'relic_language', 'possible_authenticity_document'
  ]);
});

test('complete ordinary devotional disclosures allow sale while unknown critical facts require review', () => {
  assert.equal(evaluatePolicy({offeredForSale: true, disclosures: clearDisclosures}).decision, 'allow');
  const unknown = evaluatePolicy({offeredForSale: true, disclosures: normalizeDisclosures()});
  assert.equal(unknown.decision, 'review');
  assert(unknown.reason_codes.includes('seller_attestation_required'));
  assert(unknown.reason_codes.includes('unknown_purported_relic'));
});

test('sale publish guard requires the latest effective allow or human approval', async () => {
  const {sqlite, DB} = database();
  const allowed = seedSale(sqlite, 'allow-001');
  assert.throws(() => publish(sqlite, allowed, 'publish-no-assessment'), /COMPLIANCE_REQUIRED/);
  const assessment = await runDeterministicAssessment(DB, {
    artwork_id: allowed.artwork, revision_id: allowed.revision, offered_for_sale: true, disclosures: clearDisclosures
  }, 'test');
  assert.equal(assessment.effective_decision, 'allow');
  publish(sqlite, allowed, 'publish-allowed');

  const reviewItem = seedSale(sqlite, 'review-001', {...clearDisclosures, blessed_or_dedicated: 'yes'});
  const review = await runDeterministicAssessment(DB, {
    artwork_id: reviewItem.artwork, revision_id: reviewItem.revision, offered_for_sale: true,
    disclosures: {...clearDisclosures, blessed_or_dedicated: 'yes'}
  }, 'test');
  assert.equal(review.decision, 'review');
  assert.throws(() => publish(sqlite, reviewItem, 'publish-before-review'), /COMPLIANCE_REQUIRED/);
  const approved = await saveHumanReview(DB, {assessment_id: review.id, decision: 'approve', note: 'Documentation reviewed.'}, 'reviewer:test');
  assert.equal(approved.effective_decision, 'human_approved');
  publish(sqlite, reviewItem, 'publish-after-review');
});

test('hard blocks are immutable and cannot be overridden by a human approval', async () => {
  const {sqlite, DB} = database();
  const disclosures = {...clearDisclosures, object_kind: 'relic', purported_relic: 'yes'};
  const item = seedSale(sqlite, 'block-001', disclosures);
  const blocked = await runDeterministicAssessment(DB, {
    artwork_id: item.artwork, revision_id: item.revision, offered_for_sale: true, disclosures
  }, 'test');
  assert.equal(blocked.decision, 'block');
  await assert.rejects(() => saveHumanReview(DB, {assessment_id: blocked.id, decision: 'block', note: ''}, 'reviewer:test'), /meaningful review note/i);
  assert.throws(() => sqlite.prepare(`INSERT INTO catalog_review_decisions(id,assessment_id,decision,note,actor)
    VALUES('review-empty',?,'block','   ','reviewer:test')`).run(blocked.id), /CHECK constraint failed/);
  await assert.rejects(() => saveHumanReview(DB, {assessment_id: blocked.id, decision: 'approve', note: 'Override'}, 'reviewer:test'), /cannot be human-approved/i);
  const confirmed = await saveHumanReview(DB, {assessment_id: blocked.id, decision: 'block', note: 'Confirmed explicit relic sale.'}, 'reviewer:test');
  assert.equal(confirmed.effective_decision, 'block');
  const information = await saveHumanReview(DB, {assessment_id: blocked.id, decision: 'request_information', note: 'Additional information requested.'}, 'reviewer:test');
  assert.equal(information.effective_decision, 'block');
  assert.throws(() => publish(sqlite, item, 'publish-blocked'), /COMPLIANCE_REQUIRED/);
  assert.throws(() => sqlite.prepare("UPDATE catalog_compliance_assessments SET decision='allow' WHERE id=?").run(blocked.id), /ASSESSMENT_IMMUTABLE/);
});

test('newer pending assessment invalidates an earlier allowance', async () => {
  const {sqlite, DB} = database();
  const item = seedSale(sqlite, 'pending-001');
  await runDeterministicAssessment(DB, {
    artwork_id: item.artwork, revision_id: item.revision, offered_for_sale: true, disclosures: clearDisclosures
  }, 'test');
  await saveAssessment(DB, {
    artwork_id: item.artwork, revision_id: item.revision, policy_version: POLICY_VERSION,
    decision: 'pending', source: 'ai_assisted', reason_codes: ['analysis_pending'], messages: ['Pending'], citations: []
  }, 'test');
  const current = await getAssessment(DB, item.revision);
  assert.equal(current.effective_decision, 'pending');
  assert.throws(() => publish(sqlite, item, 'publish-stale-allow'), /COMPLIANCE_REQUIRED/);
});

test('human review cannot attach to a superseded assessment', async () => {
  const {sqlite, DB} = database();
  const item = seedSale(sqlite, 'stale-review-001');
  const older = await runDeterministicAssessment(DB, {
    artwork_id: item.artwork, revision_id: item.revision, offered_for_sale: true, disclosures: clearDisclosures
  }, 'test');
  const newer = await saveAssessment(DB, {
    artwork_id: item.artwork,
    revision_id: item.revision,
    policy_version: POLICY_VERSION,
    decision: 'review',
    source: 'deterministic',
    reason_codes: ['new_information'],
    messages: ['New information requires review.'],
    citations: []
  }, 'test');

  await assert.rejects(
    () => saveHumanReview(DB, {
      assessment_id: older.id,
      decision: 'block',
      note: 'Attempted review of the older assessment.'
    }, 'reviewer:test'),
    (error) => error?.status === 409 && error?.details?.code === 'ASSESSMENT_SUPERSEDED'
  );
  const latest = await getAssessment(DB, item.revision);
  assert.equal(latest.id, newer.id);
  assert.equal(latest.effective_decision, 'review');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM catalog_review_decisions').get().n, 0);
});

test('the newest active policy invalidates and supersedes an older policy allowance', async () => {
  const {sqlite, DB} = database();
  const item = seedSale(sqlite, 'policy-change-001');
  const original = await runDeterministicAssessment(DB, {
    artwork_id: item.artwork, revision_id: item.revision, offered_for_sale: true, disclosures: clearDisclosures
  }, 'test');
  assert.equal((await getActiveAssessment(DB, item.revision)).id, original.id);

  sqlite.prepare(`INSERT INTO catalog_policy_versions(
    id,status,rules_json,citations_json,actor,activated_at
  ) VALUES('canonical-listing-v2','active','{}','[]','test',unixepoch()+1)`).run();
  assert.equal(await getActiveAssessment(DB, item.revision), null);
  assert.throws(() => publish(sqlite, item, 'publish-old-policy-allow'), /COMPLIANCE_REQUIRED/);

  const replacement = await saveAssessment(DB, {
    artwork_id: item.artwork,
    revision_id: item.revision,
    policy_version: 'canonical-listing-v2',
    decision: 'allow',
    source: 'deterministic',
    reason_codes: ['seller_disclosures_clear'],
    messages: ['Allowed under policy v2.'],
    citations: []
  }, 'test');
  const active = await getActiveAssessment(DB, item.revision);
  assert.equal(active.id, replacement.id);
  assert.equal(active.policy_version, 'canonical-listing-v2');
  assert.equal(active.effective_decision, 'allow');
  publish(sqlite, item, 'publish-new-policy-allow');
});

test('assessment reads use one database snapshot and policy changes reject stale writes', async () => {
  const {sqlite,DB}=database();
  const item=seedSale(sqlite,'atomic-policy-001',{...clearDisclosures,blessed_or_dedicated:'yes'});
  const review=await runDeterministicAssessment(DB,{
    artwork_id:item.artwork,revision_id:item.revision,offered_for_sale:true,
    disclosures:{...clearDisclosures,blessed_or_dedicated:'yes'}
  },'test');
  let prepares=0;
  const counted={prepare(sql){prepares+=1;return DB.prepare(sql);}};
  assert.equal((await getAssessment(counted,item.revision)).id,review.id);
  assert.equal(prepares,1);
  prepares=0;
  assert.equal((await getActiveAssessment(counted,item.revision)).id,review.id);
  assert.equal(prepares,1);
  sqlite.prepare("UPDATE catalog_policy_versions SET status='retired' WHERE status='active'").run();
  await assert.rejects(() => saveAssessment(DB,{
    artwork_id:item.artwork,revision_id:item.revision,policy_version:POLICY_VERSION,
    decision:'allow',source:'deterministic',reason_codes:[],messages:[],citations:[]
  },'test'),(error)=>error.status===409&&error.details?.code==='POLICY_CHANGED');
  await assert.rejects(() => saveHumanReview(DB,{
    assessment_id:review.id,decision:'approve',note:'No active policy must fail closed.'
  },'reviewer:test'),(error)=>error.status===409&&error.details?.code==='POLICY_CHANGED');
  sqlite.prepare(`INSERT INTO catalog_policy_versions(
    id,status,rules_json,citations_json,actor,activated_at
  ) VALUES('canonical-listing-v2-atomic','active','{}','[]','test',unixepoch()+2)`).run();
  await assert.rejects(() => saveAssessment(DB,{
    artwork_id:item.artwork,revision_id:item.revision,policy_version:POLICY_VERSION,
    decision:'allow',source:'deterministic',reason_codes:[],messages:[],citations:[]
  },'test'),(error)=>error.status===409&&error.details?.code==='POLICY_CHANGED');
  await assert.rejects(() => saveHumanReview(DB,{
    assessment_id:review.id,decision:'approve',note:'Reviewed before the policy switch.'
  },'reviewer:test'),(error)=>error.status===409&&error.details?.code==='POLICY_CHANGED');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM catalog_review_decisions WHERE assessment_id=?').get(review.id).n,0);
});

test('a human block overrides an automatic allowance', async () => {
  const {sqlite, DB} = database();
  const item = seedSale(sqlite, 'human-block-001');
  const allowed = await runDeterministicAssessment(DB, {
    artwork_id: item.artwork, revision_id: item.revision, offered_for_sale: true, disclosures: clearDisclosures
  }, 'test');
  assert.equal(allowed.effective_decision, 'allow');
  const blocked = await saveHumanReview(DB, {assessment_id: allowed.id, decision: 'block', note: 'Ownership documentation is unresolved.'}, 'reviewer:test');
  assert.equal(blocked.effective_decision, 'human_blocked');
  assert.throws(() => publish(sqlite, item, 'publish-human-blocked'), /COMPLIANCE_REQUIRED/);
  const information = await saveHumanReview(DB, {assessment_id: allowed.id, decision: 'request_information', note: 'Please provide ownership documentation.'}, 'reviewer:test');
  assert.equal(information.effective_decision, 'request_information');
  assert.throws(() => publish(sqlite, item, 'publish-information-requested'), /COMPLIANCE_REQUIRED/);
});

test('AI copy suggestions are immutable and tied to the exact revision hash', async () => {
  const {sqlite, DB} = database();
  const item = seedSale(sqlite, 'suggest-001');
  const suggestion = await saveAiSuggestion(DB, {
    artworkId: item.artwork,
    revisionId: item.revision,
    assetId: item.asset,
    promptVersion: 'listing-copy-v1',
    model: 'test-vision-model',
    suggestions: {title: 'Suggested title', description: 'Visible condition is clean.'},
    observations: [{code: 'visible_condition', summary: 'No obvious damage', evidence: 'front photo', confidence: 0.8}],
    uncertainties: ['Back is not visible.']
  }, 'test');
  assert.equal(suggestion.suggestions.title, 'Suggested title');
  assert.deepEqual(suggestion.evidence.asset_ids, [item.asset]);
  assert.deepEqual((await getLatestAiSuggestion(DB, item.revision)).uncertainties, ['Back is not visible.']);
  assert.throws(() => sqlite.prepare("UPDATE catalog_ai_suggestions SET model_id='changed' WHERE id=?").run(suggestion.id), /SUGGESTION_IMMUTABLE/);
});

test('asset observations are append-only and accept a content hash for legacy photos', async () => {
  const {sqlite, DB} = database();
  const item = seedSale(sqlite, 'observe-001');
  const saved = await saveAssetObservation(DB, {
    assetId: item.asset,
    assetChecksum: 'abcdef0123456789',
    state: 'completed',
    model: 'test-vision-model',
    promptVersion: 'listing-observation-v1',
    observation: {observations: [{code: 'possible_reliquary', confidence: 0.72}]}
  }, 'test');
  assert.equal(saved.observation.observations[0].code, 'possible_reliquary');
  assert.equal((await getLatestAssetObservation(DB, item.asset)).id, saved.id);
  assert.throws(() => sqlite.prepare("UPDATE catalog_asset_observations SET state='error' WHERE id=?").run(saved.id), /OBSERVATION_IMMUTABLE/);
});

test('disclosure child rows must be inserted before a revision becomes a head', async () => {
  const {sqlite, DB} = database();
  const item = seedSale(sqlite, 'immutable-001');
  assert.throws(() => disclosureInsertStatement(DB, item.revision, clearDisclosures, 'test').run(), /REVISION_IMMUTABLE|UNIQUE/);
});
