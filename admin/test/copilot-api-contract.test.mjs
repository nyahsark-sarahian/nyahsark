import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const entrypoint = readFileSync(new URL('../src/entrypoint.js', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../src/ai-assist.js', import.meta.url), 'utf8');

test('Listing Copilot API binds work to an exact revision and inspects every saved photo for sale review', () => {
  assert.match(entrypoint, /requireCurrentVersion\(body, artwork\)/);
  assert.match(entrypoint, /current\.working_revision_id !== original\.working_revision_id/);
  assert.match(entrypoint, /generateAndSaveAssistance\(env, artwork, actor, \{allPhotos: true\}\)/);
  assert.match(entrypoint, /\[main, \.\.\.photos\.filter/);
  assert.match(entrypoint, /getManagedMedia\(env\.DB, photo\.asset_id, 'display'\)/);
  assert.doesNotMatch(entrypoint, /getManagedMedia\(env\.DB, photo\.asset_id, 'master'\)/);
});

test('legacy photos are re-encoded before AI and AI Gateway payload logging and caching stay off', () => {
  assert.match(entrypoint, /SAFE_LEGACY_PHOTO\.test/);
  assert.match(entrypoint, /redirect: 'error'/);
  assert.match(entrypoint, /sanitizeImage\(env\.IMAGE_TRANSFORM, raw, 'image\/jpeg'/);
  assert.match(entrypoint, /processed\.objects\.find\(\(item\) => item\.role === 'display'/);
  assert.match(adapter, /collectLog: false/);
  assert.match(adapter, /skipCache: true/);
  assert.match(adapter, /AI listing assistance is temporarily unavailable/);
});

test('human review resolves the current revision assessment and requires a meaningful note', () => {
  assert.match(entrypoint, /getActiveAssessment\(env\.DB, artwork\.working_revision_id\)/);
  assert.match(entrypoint, /assertSupportedActivePolicy\(env\.DB\)/);
  assert.match(entrypoint, /note\.length < 8 \|\| note\.length > 2000/);
  assert.match(entrypoint, /assessment_id: current\.id/);
  assert.match(entrypoint, /return json\(\{assessment, message:/);
});

test('price guidance is exact-revision advisory work with no automatic mutation', () => {
  assert.match(entrypoint, /assist\\\/price/);
  assert.match(entrypoint, /getListingPriceGuidance\(env\.DB, \{/);
  assert.match(entrypoint, /seller_floor_cents: body\.seller_floor_cents/);
  assert.match(entrypoint, /await assertUnchangedArtwork\(env, artwork\)/);
  assert.match(entrypoint, /No price was changed or published/);
});
