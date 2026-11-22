import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {
  assertPublicationAllowed,
  calibrationMode,
  verifyCalibrationPublicationGuards
} from '../src/calibration.js';

const entrypoint = readFileSync(new URL('../src/entrypoint.js', import.meta.url), 'utf8');

const migrations = [
  '0001_legacy_inventory.sql',
  '0002_private_image_objects.sql',
  '0003_revisioned_catalog.sql'
];

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const wrap = (sql, values = []) => ({
    bind(...next) { return wrap(sql, next); },
    first() { return sqlite.prepare(sql).get(...values) ?? null; }
  });
  return {sqlite, DB: {prepare(sql) { return wrap(sql); }}};
}

test('calibration mode is explicit and blocks the application publish route', () => {
  assert.equal(calibrationMode({}), false);
  assert.equal(calibrationMode({CALIBRATION_MODE: 'no'}), false);
  assert.equal(calibrationMode({CALIBRATION_MODE: 'yes'}), true);
  assert.throws(() => calibrationMode({CALIBRATION_MODE: 'true'}), /must be yes or no/);
  assert.doesNotThrow(() => assertPublicationAllowed({CALIBRATION_MODE: 'no'}));
  assert.throws(
    () => assertPublicationAllowed({CALIBRATION_MODE: 'yes'}),
    (error) => error.status === 409 && error.details?.code === 'CALIBRATION_NO_PUBLISH'
  );
  assert.match(entrypoint, /if \(calibrationMode\(env\)\) await verifyCalibrationPublicationGuards\(env\.DB\);\s*else await reconcileBaseline\(env\.DB\);/);
  assert.match(entrypoint, /if \(request\.method === 'POST' && publish\) \{\s*assertPublicationAllowed\(env\);/);
});

test('tracked calibration guards are required and block both publication write paths', async () => {
  const {sqlite, DB} = database();
  await assert.rejects(() => verifyCalibrationPublicationGuards(DB), /guards are unavailable/);
  sqlite.exec(readFileSync(new URL('../calibration/publication-guards.sql', import.meta.url), 'utf8'));
  await verifyCalibrationPublicationGuards(DB);

  sqlite.prepare("INSERT INTO catalog_artworks(id,stable_id) VALUES('artwork-cal','calibration-artwork')").run();
  sqlite.prepare(`INSERT INTO catalog_artwork_revisions(
    id,artwork_id,revision_number,title,description,offered_for_sale,snapshot_json,content_hash,actor
  ) VALUES('revision-cal','artwork-cal',1,'Calibration','Synthetic calibration',0,'{}','0123456789abcdef','test')`).run();
  sqlite.prepare("INSERT INTO catalog_inventory(artwork_id) VALUES('artwork-cal')").run();
  sqlite.prepare("INSERT INTO catalog_artwork_heads(artwork_id,working_revision_id,working_version) VALUES('artwork-cal','revision-cal',1)").run();
  assert.throws(
    () => sqlite.prepare("UPDATE catalog_artwork_heads SET published_revision_id='revision-cal' WHERE artwork_id='artwork-cal'").run(),
    /CALIBRATION_NO_PUBLISH/
  );
  assert.throws(
    () => sqlite.prepare(`INSERT INTO catalog_publish_commands(
      id,artwork_id,revision_id,expected_head_version,quantity_changed,actor
    ) VALUES('publish-cal','artwork-cal','revision-cal',1,0,'test')`).run(),
    /CALIBRATION_NO_PUBLISH/
  );

  sqlite.exec('DROP TRIGGER calibration_never_publish');
  await assert.rejects(() => verifyCalibrationPublicationGuards(DB), /guards are unavailable/);
});
