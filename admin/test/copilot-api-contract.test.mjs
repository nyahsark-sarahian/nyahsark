import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const entrypoint = readFileSync(new URL('../src/entrypoint.js', import.meta.url), 'utf8');
const adapter = readFileSync(new URL('../src/ai-assist.js', import.meta.url), 'utf8');

test('Listing Copilot API binds work to an exact revision and inspects every saved photo for sale review', () => {
  assert.match(entrypoint, /requireCurrentVersion\(body, artwork\)/);
  assert.match(entrypoint, /current\.working_revision_id !== original\.working_revision_id/);
  assert.match(entrypoint, /generateAndSaveAssistance\(env, artwork, actor, \{[\s\S]*?allPhotos: true/);
  assert.match(entrypoint, /\[main, \.\.\.photos\.filter/);
  assert.match(entrypoint, /getManagedMedia\(env\.DB, photo\.asset_id, 'display'\)/);
  assert.doesNotMatch(entrypoint, /getManagedMedia\(env\.DB, photo\.asset_id, 'master'\)/);
});

test('AI dispatch reserves the monthly budget first and reconciles every provider outcome', () => {
  const reserve = entrypoint.indexOf('reserveAiInferenceBudget(env.DB');
  const dispatch = entrypoint.indexOf('Promise.all(images.map((image) => generateListingAssistance');
  assert.ok(reserve >= 0 && dispatch > reserve);
  assert.match(entrypoint, /if \(reservation\.reused\)/);
  assert.match(entrypoint, /failAiInferenceBudget\(env\.DB/);
  assert.match(entrypoint, /reconcileAiInferenceBudget\(env\.DB/);
  assert.match(entrypoint, /actualCostMicrousd: reservation\.estimated_cost_microusd/);
  assert.match(entrypoint, /aiActionIdentifier\(body, 'draft-copy'\)/);
  assert.match(entrypoint, /aiActionIdentifier\(body, 'compliance'\)/);
});

test('compliance idempotency is claimed before a pending assessment can supersede a completed result', () => {
  const assessmentRoute = entrypoint.slice(entrypoint.indexOf("const assessCompliance ="), entrypoint.indexOf("const reviewCompliance ="));
  const prepare = assessmentRoute.indexOf('prepareComplianceAssistance');
  const dispatch = assessmentRoute.indexOf('generateAndSaveAssistance');
  assert.ok(prepare >= 0 && dispatch > prepare);
  assert.match(entrypoint, /reserveComplianceAssistance\(env, artwork, actor/);
  assert.match(assessmentRoute, /aiAttemptStarted && error\?\.details\?\.code !== 'HEAD_CONFLICT'/);
});

test('deterministic hard blocks bypass AI for both copy drafting and canonical assessment', () => {
  const draftRoute = entrypoint.slice(entrypoint.indexOf("const assistDraft ="), entrypoint.indexOf("const assistPrice ="));
  const assessmentRoute = entrypoint.slice(entrypoint.indexOf("const assessCompliance ="), entrypoint.indexOf("const reviewCompliance ="));
  const draftGate = draftRoute.indexOf('dispatchDraftCopyIfAllowed');
  const draftDispatch = draftRoute.indexOf('generateAndSaveAssistance');
  const assessmentGate = assessmentRoute.indexOf('deterministicPolicyPreflight');
  const assessmentDispatch = assessmentRoute.indexOf('aiAssistCapabilities');
  assert.ok(draftGate >= 0 && draftDispatch > draftGate);
  assert.ok(assessmentGate >= 0 && assessmentDispatch > assessmentGate);
  assert.match(assessmentRoute, /preflight\.decision === 'block'[\s\S]*?runDeterministicAssessment[\s\S]*?ai_observations_used: 0/);
  assert.match(assessmentRoute, /Workers AI was not invoked/);
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
  assert.match(entrypoint, /savePricingPreference\(env\.DB/);
  assert.match(entrypoint, /await assertUnchangedArtwork\(env, artwork\)/);
  assert.match(entrypoint, /No price was changed or published/);
});

test('ambiguous canonical reviews have a recorded priest escalation route without a hard-block override', () => {
  assert.match(entrypoint, /compliance\\\/escalate/);
  assert.match(entrypoint, /saveReviewEscalation\(env\.DB/);
  assert.match(entrypoint, /assessment_id: current\.id/);
  assert.match(entrypoint, /Human consultation recorded in the immutable compliance history/);
});
