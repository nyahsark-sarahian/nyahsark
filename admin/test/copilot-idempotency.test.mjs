import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {getAssessment, POLICY_VERSION, saveAssessment} from '../src/compliance.js';
import {reserveComplianceAssistance} from '../src/ai-compliance-workflow.js';

const migrationNames = [
  '0001_legacy_inventory.sql',
  '0002_private_image_objects.sql',
  '0003_revisioned_catalog.sql',
  '0004_settings_commands.sql',
  '0005_listing_compliance.sql',
  '0006_ai_governance.sql'
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
        const output = statements.map((statement) => statement._run());
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

function seed(sqlite) {
  const artworkId = 'artwork-idempotency';
  const revisionId = 'revision-idempotency';
  const snapshot = {
    title: 'Calibration item',
    description: 'Synthetic calibration listing',
    category: 'Calibration',
    offered_for_sale: true,
    photos: []
  };
  sqlite.prepare('INSERT INTO catalog_artworks(id,stable_id) VALUES(?,?)').run(artworkId, 'idempotency-calibration');
  sqlite.prepare(`INSERT INTO catalog_artwork_revisions(
    id,artwork_id,revision_number,title,description,category,offered_for_sale,snapshot_json,content_hash,actor
  ) VALUES(?,?,1,?,?,?,?,?,?,?)`).run(
    revisionId, artworkId, snapshot.title, snapshot.description, snapshot.category, 1,
    JSON.stringify(snapshot), '0123456789abcdef0123456789abcdef', 'test:idempotency'
  );
  return {
    id: artworkId,
    working_revision_id: revisionId,
    version: 1,
    draft: snapshot
  };
}

test('replaying a compliance request identifier preserves the prior effective assessment', async () => {
  const {sqlite, DB} = database();
  const artwork = seed(sqlite);
  const env = {DB, AI_ASSIST_MODEL: '@cf/meta/llama-4-scout-17b-16e-instruct'};
  const options = {imageCount: 1, actionId: 'compliance-replay-0001'};

  await reserveComplianceAssistance(env, artwork, 'admin:test', options);
  const completed = await saveAssessment(DB, {
    artwork_id: artwork.id,
    revision_id: artwork.working_revision_id,
    policy_version: POLICY_VERSION,
    decision: 'allow',
    source: 'ai_assisted',
    reason_codes: [],
    messages: ['Synthetic calibration listing passed review.'],
    citations: []
  }, 'admin:test');
  const beforeCount = sqlite.prepare('SELECT count(*) AS n FROM catalog_compliance_assessments').get().n;

  await assert.rejects(
    () => reserveComplianceAssistance(env, artwork, 'admin:test', options),
    (error) => error?.status === 409 && error?.details?.code === 'AI_ACTION_REPLAY'
  );

  const latest = await getAssessment(DB, artwork.working_revision_id, POLICY_VERSION);
  assert.equal(latest.id, completed.id);
  assert.equal(latest.decision, 'allow');
  assert.equal(latest.effective_decision, 'allow');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM catalog_compliance_assessments').get().n, beforeCount);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM catalog_ai_inference_ledger').get().n, 1);
});
