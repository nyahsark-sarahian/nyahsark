import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  parseEighths, formatEighths, stepEighths,
  parsePriceCents, formatPriceInput, parseWhole, uploadMimeType,
} from './common.js';

test('measurements preserve exact eighth-inch values', () => {
  assert.equal(parseEighths('12 3/8'), 99);
  assert.equal(parseEighths('12.375'), 99);
  assert.equal(parseEighths('1/8'), 1);
  assert.equal(parseEighths('12 1/2 in'), 100);
  assert.equal(formatEighths(99), '12 3/8 in');
  assert.equal(formatEighths(100), '12 1/2 in');
  assert.equal(stepEighths(99, 1), 100);
  assert.equal(stepEighths(null, 1), 1);
  assert.equal(stepEighths(null, -1), null);
  assert.equal(stepEighths(1, -1), 1);
  assert.equal(parseEighths(''), null);
  assert.throws(() => parseEighths('12.3'), /one-eighth-inch/);
  assert.throws(() => parseEighths('0'), /positive/);
});

test('money is integer cents and blank stays null', () => {
  assert.equal(parsePriceCents('12.34'), 1234);
  assert.equal(parsePriceCents('0'), 0);
  assert.equal(parsePriceCents(''), null);
  assert.equal(formatPriceInput(1234), '12.34');
  assert.throws(() => parsePriceCents('12.345'), /two decimal/);
  assert.throws(() => parsePriceCents('-1'), /two decimal/);
});

test('intentional zero quantity remains distinct from blank', () => {
  assert.equal(parseWhole('0'), 0);
  assert.equal(parseWhole(''), null);
  assert.throws(() => parseWhole('-1'), /whole number/);
});

test('upload MIME normalization supports iPhone HEIC and HEIF filenames without trusting unrelated extensions', () => {
  assert.equal(uploadMimeType({name: 'portrait.HEIC', type: ''}), 'image/heic');
  assert.equal(uploadMimeType({name: 'portrait.heif', type: 'application/octet-stream'}), 'image/heif');
  assert.equal(uploadMimeType({name: 'portrait.heic', type: 'image/HEIC'}), 'image/heic');
  assert.equal(uploadMimeType({name: 'portrait.jpg', type: 'image/jpeg'}), 'image/jpeg');
  assert.equal(uploadMimeType({name: 'portrait.jpg', type: ''}), '');
  assert.equal(uploadMimeType({name: 'portrait.heic.exe', type: ''}), '');
});

test('admin shell exposes required workspace controls without inline code', () => {
  const html = readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  for (const text of ['Artwork', 'Add Artwork', 'Save All Draft Changes', 'Save Store Order', 'Settings', 'Orders', 'Forgot password']) assert.match(html, new RegExp(text));
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /Publish All/i);
});

test('admin upload controls advertise backend HEIC conversion', () => {
  const javascript = readFileSync(new URL('./admin.js', import.meta.url), 'utf8');
  assert.match(javascript, /\.heic,\.heif,image\/heic,image\/heif/);
  assert.match(javascript, /backend converts every accepted upload to private WebP derivatives/i);
  assert.doesNotMatch(javascript, /HEIC\/HEIF is not supported/i);
});

test('Listing Copilot collects disclosures and keeps AI wording suggestion-only', () => {
  const javascript = readFileSync(new URL('./admin.js', import.meta.url), 'utf8');
  for (const field of [
    'object_kind', 'blessed_or_dedicated', 'purported_relic', 'contains_human_material',
    'provenance_known', 'ecclesiastical_owner', 'authenticity_document',
    'spiritual_benefit_priced', 'seller_attested',
  ]) assert.match(javascript, new RegExp(field));
  for (const endpoint of ['assist/draft-copy', 'assist/price', 'compliance/assess', 'compliance/review', 'compliance/escalate']) assert.match(javascript, new RegExp(endpoint));
  assert.match(javascript, /Applying suggestions changes only this unsaved form/i);
  assert.match(javascript, /A photograph cannot prove a blessing, provenance, or relic authenticity/i);
  assert.match(javascript, /assessment\?\.effective_decision \|\| assessment\?\.decision/);
  assert.match(javascript, /human_blocked: 'Blocked after human review'/);
  assert.match(javascript, /Bounded visual observations \(not authentication\)/);
  assert.match(javascript, /reviewNote\.trim\(\)\.length < 8/);
  assert.match(javascript, /Listing Copilot is temporarily unavailable/);
  const applyFunction = /function applyCopilotSuggestion[\s\S]*?\r?\n}\r?\n\r?\nfunction copilotUnavailableMessage/.exec(javascript)?.[0] || '';
  assert.ok(applyFunction);
  assert.doesNotMatch(applyFunction, /sendJSON|saveCards|publishCard/);
  assert.match(javascript, /Guidance uses verified store sales and server-owned activity only/i);
  assert.match(javascript, /Applying guidance changes only the unsaved price field/i);
  assert.match(javascript, /Seller-floor-adjusted range/);
  assert.match(javascript, /latest recorded local-priest or diocesan consultation is cleared/);
  assert.match(javascript, /assessmentChanged[\s\S]*?priceGuidance = null[\s\S]*?reviewNote = ''[\s\S]*?escalations = \[\]/);
  assert.match(javascript, /escalationOutcome = 'requested'[\s\S]*?escalationReviewerRole = ''[\s\S]*?escalationNote = ''/);
  assert.match(javascript, /permittedStage !== 'seller_clarification' \|\| value !== 'cleared'/);
  assert.match(javascript, /Sarah may override every suggestion/i);
  assert.match(javascript, /made_to_order: 'unknown', production_method: 'unknown'/);
  assert.match(javascript, /Made to order\?/);
  assert.match(javascript, /Production method/);
  assert.match(javascript, /representative sample; Listing Copilot must not describe it as stocked inventory/i);
  assert.match(javascript, /draft\.made_to_order === 'yes' && draft\.production_method === 'unknown'/);
  assert.match(javascript, /requestIds: \{copy: null, compliance: null\}/);
  assert.match(javascript, /nyahsark:copilot-request:\$\{encodeURIComponent\(card\.id\)\}:\$\{card\.version\}:\$\{action\}/);
  assert.match(javascript, /copilotRequestMemory\.set\(key, requestId\)/);
  assert.match(javascript, /sessionStorage\.setItem\(key, requestId\)/);
  assert.match(javascript, /sessionStorage\.getItem\(key\)/);
  assert.match(javascript, /sessionStorage\.removeItem\(key\)/);
  assert.match(javascript, /function pruneStaleCopilotRequestIds[\s\S]*?sessionStorage\.key\(index\)[\s\S]*?!current\.has\(key\)/);
  assert.match(javascript, /const requestId = retainedCopilotRequestId\(card, 'copy'\)[\s\S]*?request_id: requestId/);
  assert.match(javascript, /const requestId = retainedCopilotRequestId\(card, 'compliance'\)[\s\S]*?request_id: requestId/);
  assert.match(javascript, /clearCopilotRequestIds\(card, 'copy'\)/);
  assert.match(javascript, /clearCopilotRequestIds\(card, 'compliance'\)/);
  assert.match(javascript, /function markDirty[\s\S]*?clearCopilotRequestIds\(card\)/);
  assert.match(javascript, /Retry the same wording request/);
  assert.match(javascript, /Retry the same canonical review/);
  assert.match(javascript, /Start a new wording action/);
  assert.match(javascript, /Start a new review action/);
  const applyPriceFunction = /function applyPriceGuidance[\s\S]*?\r?\n}\r?\n\r?\nasync function submitHumanReview/.exec(javascript)?.[0] || '';
  assert.ok(applyPriceFunction);
  assert.match(applyPriceFunction, /card\._raw\.price = formatPriceInput\(cents\)/);
  assert.match(applyPriceFunction, /markDirty\(card\)/);
  assert.doesNotMatch(applyPriceFunction, /sendJSON|saveCards|publishCard/);
});

test('the first catalog load reaches the server instead of caching an empty page', () => {
  const javascript = readFileSync(new URL('./admin.js', import.meta.url), 'utf8');
  const loadFunction = /async function loadArtworks[\s\S]*?const key = viewKey\(\);/.exec(javascript)?.[0] || '';
  assert.ok(loadFunction);
  assert.doesNotMatch(loadFunction, /cacheCurrent\(\)/);
});

