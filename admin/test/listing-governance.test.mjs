import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {
  getPricingPreference,
  listReviewEscalations,
  savePricingPreference,
  saveReviewEscalation
} from '../src/listing-governance.js';

const migrationNames = [
  '0001_legacy_inventory.sql','0002_private_image_objects.sql','0003_revisioned_catalog.sql',
  '0004_settings_commands.sql','0005_listing_compliance.sql','0006_ai_governance.sql'
];

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of migrationNames) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const wrap = (sql, values = []) => ({
    bind(...next) { return wrap(sql, next); },
    _run() {
      const result = sqlite.prepare(sql).run(...values);
      return {meta: {changes: Number(result.changes)}};
    },
    run() { return this._run(); },
    first() { return sqlite.prepare(sql).get(...values) ?? null; },
    all() { return {results: sqlite.prepare(sql).all(...values)}; }
  });
  const DB = {
    prepare(sql) { return wrap(sql); },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement._run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return {sqlite, DB};
}

function seed(sqlite, decision = 'review') {
  sqlite.prepare("INSERT INTO catalog_artworks(id,stable_id) VALUES('artwork-0001','artwork-one')").run();
  sqlite.prepare(`INSERT INTO catalog_artwork_revisions(
    id,artwork_id,revision_number,title,description,base_price_cents,offered_for_sale,
    snapshot_json,content_hash,actor
  ) VALUES('revision-0001','artwork-0001',1,'Rosary','Visible item',10000,1,'{}','0123456789abcdef','test')`).run();
  sqlite.prepare("INSERT INTO catalog_artwork_heads(artwork_id,working_revision_id,working_version) VALUES('artwork-0001','revision-0001',1)").run();
  sqlite.prepare(`INSERT INTO catalog_compliance_assessments(
    id,artwork_id,revision_id,policy_version,decision,source,reason_codes_json,messages_json,citations_json,actor
  ) VALUES('assessment-0001','artwork-0001','revision-0001','canonical-listing-v1',?,'deterministic','[]','[]','[]','test')`).run(decision);
}

test('seller floor is positive, bounded by the saved price, persisted, and audited', async () => {
  const {sqlite, DB} = database();
  seed(sqlite);
  await assert.rejects(
    () => savePricingPreference(DB, {artwork_id: 'artwork-0001', seller_floor_cents: 0}, 'admin:test'),
    /positive amount/i
  );
  await assert.rejects(
    () => savePricingPreference(DB, {artwork_id: 'artwork-0001', seller_floor_cents: 10_001}, 'admin:test'),
    /cannot exceed/i
  );
  const first = await savePricingPreference(DB, {
    artwork_id: 'artwork-0001', seller_floor_cents: 7_500
  }, 'admin:test');
  assert.equal(first.seller_floor_cents, 7_500);
  assert.deepEqual(await getPricingPreference(DB, 'artwork-0001'), first);
  const repeated = await savePricingPreference(DB, {
    artwork_id: 'artwork-0001', seller_floor_cents: 7_500
  }, 'admin:test');
  assert.equal(repeated.id, first.id);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM catalog_listing_price_floors').get().n, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM catalog_audit_events WHERE action='seller_price_floor_saved'").get().n, 1);
  assert.throws(() => sqlite.prepare("UPDATE catalog_listing_price_floors SET seller_floor_cents=1").run(), /PRICE_FLOOR_IMMUTABLE/);
});

test('ambiguous review follows Sarah to priest to diocesan escalation and remains append-only', async () => {
  const {sqlite, DB} = database();
  seed(sqlite);
  await assert.rejects(
    () => saveReviewEscalation(DB, {
      assessment_id: 'assessment-0001', stage: 'seller_clarification', outcome: 'cleared',
      reviewer_role: 'Sarah', note: 'Attempted to clear the ambiguity without priest consultation.'
    }, 'admin:test'),
    (error) => error?.details?.code === 'SELLER_CLEARANCE_NOT_ALLOWED'
  );
  assert.throws(
    () => sqlite.prepare(`INSERT INTO catalog_review_escalations(
      id,assessment_id,stage,outcome,reviewer_role,note,actor
    ) VALUES('seller-clearance-bypass','assessment-0001','seller_clarification','cleared','Sarah','Direct seller clearance attempt.','test')`).run(),
    /SELLER_CLEARANCE_NOT_ALLOWED/
  );
  await assert.rejects(
    () => saveReviewEscalation(DB, {
      assessment_id: 'assessment-0001', stage: 'local_priest', outcome: 'requested',
      reviewer_role: 'Parish priest', note: 'Asked the priest to review the available facts.'
    }, 'admin:test'),
    /seller clarification/i
  );
  await saveReviewEscalation(DB, {
    assessment_id: 'assessment-0001', stage: 'seller_clarification', outcome: 'escalated',
    reviewer_role: 'Sarah', note: 'The seller could not establish provenance from the available records.'
  }, 'admin:test');
  await saveReviewEscalation(DB, {
    assessment_id: 'assessment-0001', stage: 'local_priest', outcome: 'unable_to_resolve',
    reviewer_role: 'Local parish priest', note: 'The priest advised consulting the diocesan chancery before listing.'
  }, 'admin:test');
  const result = await saveReviewEscalation(DB, {
    assessment_id: 'assessment-0001', stage: 'diocesan_chancery', outcome: 'requested',
    reviewer_role: 'Diocesan chancery', note: 'The unresolved question was referred for diocesan guidance.'
  }, 'admin:test');
  assert.equal(result.escalations.length, 3);
  assert.deepEqual((await listReviewEscalations(DB, 'assessment-0001')).map(({stage}) => stage), [
    'seller_clarification','local_priest','diocesan_chancery'
  ]);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM catalog_audit_events WHERE action='compliance_escalation'").get().n, 3);
  await saveReviewEscalation(DB, {
    assessment_id: 'assessment-0001', stage: 'diocesan_chancery', outcome: 'blocked',
    reviewer_role: 'Diocesan chancery', note: 'The diocesan consultation advised that the item remain blocked.'
  }, 'admin:test');
  await assert.rejects(
    () => saveReviewEscalation(DB, {
      assessment_id: 'assessment-0001', stage: 'local_priest', outcome: 'cleared',
      reviewer_role: 'Another local priest', note: 'Attempted to move backward after the diocesan decision.'
    }, 'admin:test'),
    /latest consultation is final/i
  );
  assert.throws(
    () => sqlite.prepare(`INSERT INTO catalog_review_escalations(
      id,assessment_id,stage,outcome,reviewer_role,note,actor
    ) VALUES('escalation-bypass','assessment-0001','local_priest','cleared','Another priest','Direct downgrade attempt.','test')`).run(),
    /ESCALATION_TERMINAL/
  );
  assert.throws(() => sqlite.prepare("DELETE FROM catalog_review_escalations").run(), /ESCALATION_IMMUTABLE/);
});

test('consultation records cannot turn a deterministic block into an override path', async () => {
  const {sqlite, DB} = database();
  seed(sqlite, 'block');
  await assert.rejects(
    () => saveReviewEscalation(DB, {
      assessment_id: 'assessment-0001', stage: 'seller_clarification', outcome: 'requested',
      reviewer_role: 'Sarah', note: 'Attempted to open consultation for a deterministic block.'
    }, 'admin:test'),
    (error) => error?.details?.code === 'ESCALATION_NOT_ALLOWED'
  );
});

test('database and service reject unconsulted approvals, stale consultations, and resolved assessments', async () => {
  const {sqlite, DB} = database();
  seed(sqlite);
  assert.throws(
    () => sqlite.prepare(`INSERT INTO catalog_review_decisions(id,assessment_id,decision,note,actor)
      VALUES('review-direct','assessment-0001','approve','Attempted direct approval.','test')`).run(),
    /PRIEST_CLEARANCE_REQUIRED/
  );
  sqlite.prepare(`INSERT INTO catalog_compliance_assessments(
    id,artwork_id,revision_id,policy_version,decision,source,reason_codes_json,messages_json,citations_json,actor,created_at
  ) VALUES('assessment-0002','artwork-0001','revision-0001','canonical-listing-v1','review','deterministic','[]','[]','[]','test',unixepoch()+1)`).run();
  await assert.rejects(
    () => saveReviewEscalation(DB, {
      assessment_id: 'assessment-0001', stage: 'seller_clarification', outcome: 'requested',
      reviewer_role: 'Sarah', note: 'Attempted consultation on the older assessment.'
    }, 'admin:test'),
    (error) => error?.details?.code === 'ASSESSMENT_SUPERSEDED'
  );
  sqlite.prepare(`INSERT INTO catalog_review_decisions(id,assessment_id,decision,note,actor)
    VALUES('review-block','assessment-0002','block','The unresolved item remains blocked.','test')`).run();
  await assert.rejects(
    () => saveReviewEscalation(DB, {
      assessment_id: 'assessment-0002', stage: 'seller_clarification', outcome: 'requested',
      reviewer_role: 'Sarah', note: 'Attempted consultation after the decision.'
    }, 'admin:test'),
    (error) => error?.details?.code === 'ASSESSMENT_RESOLVED'
  );
});
