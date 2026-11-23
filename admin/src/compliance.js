import {HttpError, assertText} from './http.js';
import {listReviewEscalations} from './listing-governance.js';

export const POLICY_VERSION = 'canonical-listing-v1';

export const DISCLOSURE_DEFAULTS = Object.freeze({
  object_kind: 'unknown',
  blessed_or_dedicated: 'unknown',
  purported_relic: 'unknown',
  relic_class_claim: null,
  contains_human_material: 'unknown',
  provenance_known: 'unknown',
  ecclesiastical_owner: 'unknown',
  authenticity_document: 'unknown',
  spiritual_benefit_priced: 'unknown',
  seller_attested: false
});

const OBJECT_KINDS = new Set(['unknown', 'ordinary_devotional', 'sacramental', 'sacred_object', 'relic', 'other']);
const TRI_STATES = new Set(['unknown', 'yes', 'no']);
const DISCLOSURE_KEYS = new Set(Object.keys(DISCLOSURE_DEFAULTS));
const ASSESSMENT_DECISIONS = new Set(['pending', 'allow', 'review', 'block', 'error']);
const ASSESSMENT_SOURCES = new Set(['deterministic', 'ai_assisted', 'manual']);
const REVIEW_DECISIONS = new Set(['approve', 'block', 'request_information']);
const AI_REVIEW_FLAG_ALIASES = new Map([
  ['possible_reliquary', 'possible_reliquary'],
  ['visible_reliquary_features', 'possible_reliquary'],
  ['possible_human_material', 'possible_human_material'],
  ['relic_language', 'relic_language'],
  ['relic_terms_visible', 'relic_language'],
  ['possible_authenticity_document', 'possible_authenticity_document'],
  ['authenticity_document_visible', 'possible_authenticity_document']
]);

export const CANONICAL_CITATIONS = Object.freeze({
  canon_1171: Object.freeze({
    code: 'canon_1171',
    label: 'Code of Canon Law, Canon 1171',
    url: 'https://www.vatican.va/archive/cod-iuris-canonici/eng/documents/cic_lib4-cann1166-1190_en.html'
  }),
  canon_1190_1: Object.freeze({
    code: 'canon_1190_1',
    label: 'Code of Canon Law, Canon 1190 §1',
    url: 'https://www.vatican.va/archive/cod-iuris-canonici/eng/documents/cic_lib4-cann1166-1190_en.html'
  }),
  relics_instruction_25: Object.freeze({
    code: 'relics_instruction_25',
    label: 'Relics in the Church: Authenticity and Conservation, Article 25',
    url: 'https://www.vatican.va/roman_curia/congregations/csaints/documents/rc_con_csaints_doc_20171208_istruzione-reliquie_en.html'
  }),
  ccc_2121: Object.freeze({
    code: 'ccc_2121',
    label: 'Catechism of the Catholic Church, 2121',
    url: 'https://www.vatican.va/content/catechism/en/part_three/section_two/chapter_one/article_1/iii_you_shall_have_no_other_gods_before_me.html'
  })
});

const parseJson = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

const addFieldError = (fields, name, message) => {
  if (!fields[name]) fields[name] = [];
  fields[name].push(message);
};

export function normalizeDisclosures(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const normalized = {...DISCLOSURE_DEFAULTS};
  if (OBJECT_KINDS.has(source.object_kind)) normalized.object_kind = source.object_kind;
  for (const key of ['blessed_or_dedicated', 'purported_relic', 'contains_human_material', 'provenance_known', 'ecclesiastical_owner', 'authenticity_document', 'spiritual_benefit_priced']) {
    if (TRI_STATES.has(source[key])) normalized[key] = source[key];
  }
  if (source.relic_class_claim === null || source.relic_class_claim === undefined || source.relic_class_claim === '') normalized.relic_class_claim = null;
  else if (typeof source.relic_class_claim === 'string') normalized.relic_class_claim = source.relic_class_claim.normalize('NFKC').trim().slice(0, 160) || null;
  if (typeof source.seller_attested === 'boolean') normalized.seller_attested = source.seller_attested;
  return normalized;
}

export function validateDisclosures(input) {
  const fields = {};
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    addFieldError(fields, 'compliance', 'Compliance disclosures must be an object.');
  }
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const key of Object.keys(source)) {
    if (!DISCLOSURE_KEYS.has(key)) addFieldError(fields, `compliance.${key}`, 'This disclosure field is not supported.');
  }
  if (source.object_kind !== undefined && !OBJECT_KINDS.has(source.object_kind)) {
    addFieldError(fields, 'compliance.object_kind', 'Choose a supported object type.');
  }
  for (const key of ['blessed_or_dedicated', 'purported_relic', 'contains_human_material', 'provenance_known', 'ecclesiastical_owner', 'authenticity_document', 'spiritual_benefit_priced']) {
    if (source[key] !== undefined && !TRI_STATES.has(source[key])) addFieldError(fields, `compliance.${key}`, 'Choose yes, no, or unknown.');
  }
  if (source.relic_class_claim !== undefined && source.relic_class_claim !== null && typeof source.relic_class_claim !== 'string') {
    addFieldError(fields, 'compliance.relic_class_claim', 'Enter text or leave this field blank.');
  } else if (typeof source.relic_class_claim === 'string') {
    try { assertText(source.relic_class_claim, 160, 'Relic class claim', {allowBlank: true}); }
    catch { addFieldError(fields, 'compliance.relic_class_claim', 'Use valid visible text of 160 characters or fewer.'); }
  }
  if (source.seller_attested !== undefined && typeof source.seller_attested !== 'boolean') {
    addFieldError(fields, 'compliance.seller_attested', 'Confirm or leave the attestation unchecked.');
  }
  if (Object.keys(fields).length) throw new HttpError(400, 'Compliance disclosures have validation errors', {fields});
  return normalizeDisclosures(source);
}

function observedReviewFlags(observations) {
  const flags = new Set();
  const addFlag = (candidate) => {
    const normalized = typeof candidate === 'string' ? AI_REVIEW_FLAG_ALIASES.get(candidate) : null;
    if (normalized) flags.add(normalized);
  };
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) continue;
    addFlag(observation.code);
    for (const [flag] of AI_REVIEW_FLAG_ALIASES) if (observation[flag] === true) addFlag(flag);
    if (Array.isArray(observation.risk_flags)) {
      for (const flag of observation.risk_flags) addFlag(flag);
    }
  }
  return [...flags];
}

function savedCopyFlags(listingCopy) {
  const source = listingCopy && typeof listingCopy === 'object' && !Array.isArray(listingCopy) ? listingCopy : {};
  const sourceText = ['title', 'description', 'category']
    .map((key) => typeof source[key] === 'string' ? source[key].slice(0, key === 'description' ? 10_000 : 200) : '')
    .filter(Boolean)
    .join('\n');
  if (!sourceText) return {hardBlocks: [], review: []};
  const hardBlocks = [];
  const review = [];
  const unsafeTextCharacters = /[\p{Cf}\p{Cs}]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
  const hasUnsafeText = unsafeTextCharacters.test(sourceText);
  unsafeTextCharacters.lastIndex = 0;
  const text = sourceText.normalize('NFKC').replace(unsafeTextCharacters, '');
  if (hasUnsafeText) review.push('copy_unsafe_unicode');
  const saintPerson = String.raw`(?:st\.?|saint|blessed)\s+[a-z][a-z.' -]{0,50}`;
  const relicMatter = String.raw`(?:body|skull|ashes|fingers?|skin|organs?|bones?|blood|teeth|tooth|tissue|hair|nails?|clothing|garments?|cloth|veil|fragments?|particles?|remains?)`;
  const currencyAmount = String.raw`(?:[$€£¥₹]\s*\d[\d,.]*|\d[\d,.]*\s*(?:usd|cad|aud|eur|gbp|jpy|cny|dollars?|euros?|pounds?|yen|rupees?)\b|(?:usd|cad|aud|eur|gbp|jpy|cny)\s*\d[\d,.]*)`;
  const valueLanguage = String.raw`(?:\b(?:prices?|priced|costs?|fees?|payment|purchase|buy|sale|sold|included)\b|\bfor\s+sale\b|\b(?:valued|worth)\s+(?:at\s+)?${currencyAmount}|${currencyAmount})`;
  // Pairing any of these non-transferable spiritual effects or ministries with
  // price/value language is a deterministic hard block. Keep physical goods
  // such as a "prayer card" out of this vocabulary so ordinary merchandise is
  // not swept in merely because its name contains a devotional word.
  const spiritualBenefit = String.raw`(?:blessing|grace|indulgence|spiritual\s+(?:benefit|effect|healing|protection)|healing(?:\s+(?:benefit|effect|power))?|miracles?(?:\s+prayer)?|divine\s+protection|protection\s+(?:from|against)\b[^.\n]{0,30}|answered\s+prayers?|prayer\s+(?:service|intention)|mass\s+intention)`;
  const relicClassOrdinal = String.raw`(?:first|second|third|1st|2nd|3rd)[ \t\-‐‑‒–—]+class`;
  const classClaimObject = String.raw`(?:relics?|rosar(?:y|ies)|medals?|cross(?:es)?|crucifix(?:es)?|pendants?|scapulars?|cloth|clothing|garments?|bones?|blood|hair|teeth|tooth|tissue|fragments?|particles?|remains?|sacramentals?|devotional\s+objects?|items?)`;
  const explicitRelicClass = new RegExp(String.raw`(?:\b${relicClassOrdinal}\b[ \t,:-]{0,12}\b${classClaimObject}\b|\b${classClaimObject}\b[^.\n]{0,20}\b${relicClassOrdinal}\b)`, 'i');
  const explicitPersonRelic = new RegExp(
    String.raw`(?:\b${relicMatter}\b\s+(?:of|from|belonging\s+to|worn\s+by|used\s+by|touched\s+by|owned\s+by)\s+\b${saintPerson}\b|\b${saintPerson}\b(?:'s)?\s+\b${relicMatter}\b|\b${relicMatter}\b\s+(?:worn|used|touched|owned)\s+by\s+\b${saintPerson}\b)`,
    'i'
  );
  // Named Passion relic claims often omit both "relic" and a saint's name.
  // Require matter/provenance wording before treating the saved copy as an
  // explicit sale claim so ordinary replica artwork is not swept in.
  const explicitNamedRelic = /\b(?:piece|wood|fragment|splinter|particle|portion)\s+(?:of|from)\s+(?:the\s+)?(?:true\s+cross|crown\s+of\s+thorns)\b|\b(?:piece|fragment|splinter|particle|portion)\s+(?:of|from)\s+(?:an?\s+)?holy\s+nail\b|\b(?:authentic|genuine|actual|original)\s+holy\s+nail\b|\bholy\s+nail\s+from\s+(?:the\s+)?(?:crucifixion|passion)\b/i;
  // A tightly scoped denial such as "No relic status is claimed" is not an
  // affirmative relic-sale claim. Remove only complete denial formulations;
  // any additional affirmative mention remains and is still blocked.
  const relicClaimText = text.replace(
    /\b(?:no\s+(?:sacred\s+)?relic(?:s|\s+status)?\s+(?:is|are)\s+(?:claimed|asserted|represented)|not\s+(?:a|an)\s+(?:sacred\s+)?relic|without\s+(?:a|an|any)\s+(?:sacred\s+)?relics?)\b/gi,
    ''
  );
  if (
    /\brelics?\b|\bex\s+(?:ossibus|capillis|sanguine|carne|corpore|praecordiis|pulveribus|indumentis|vestimentis|brandea|linteo)\b/i.test(relicClaimText) ||
    /\b(?:first|second|third)[ -]class\b[^.\n]{0,60}\b(?:fragment|particle|remains?)\b/i.test(text) ||
    /\b(?:mortal\s+remains?|fragments?|particles?|bones?|hair|blood|teeth|tooth|tissue)\b[^.\n]{0,40}\b(?:of|from)\s+(?:st\.?|saint|blessed)\b/i.test(text) ||
    /\b(?:st\.?|saint|blessed)\s+[a-z][a-z.' -]{0,50}\b(?:fragments?|particles?|remains?|bones?|hair|blood|teeth|tooth|tissue)\b/i.test(text) ||
    explicitPersonRelic.test(text) ||
    explicitRelicClass.test(text) ||
    explicitNamedRelic.test(text)
  ) hardBlocks.push('sacred_relic_sale');
  if (
    new RegExp(String.raw`${valueLanguage}[^.\n]{0,80}\b${spiritualBenefit}\b`, 'i').test(text) ||
    new RegExp(String.raw`\b${spiritualBenefit}\b[^.\n]{0,80}${valueLanguage}`, 'i').test(text)
  ) hardBlocks.push('spiritual_benefit_sale');
  if (/\b(?:blessed|consecrated|dedicated)\b/i.test(text)) review.push('copy_blessed_or_dedicated');
  if (/\breliquar(?:y|ies)\b/i.test(text)) review.push('copy_reliquary_language');
  if (/\b(?:human\s+(?:material|remains?)|bones?|bone\s+fragments?|saint(?:'s)?\s+(?:bone|hair|blood|tooth|tissue|fragment))\b/i.test(text)) {
    review.push('copy_possible_human_material');
  }
  if (/\b(?:certificate|document)\s+of\s+authenticity\b/i.test(text)) review.push('copy_authenticity_document');
  if (/\b(?:true\s+cross|crown\s+of\s+thorns|holy\s+nails?)\b/i.test(text)) review.push('copy_named_relic_language');
  if (/\bex\s+[a-z]{3,24}\b[^.\n]{0,50}\b(?:st\.?|saint|blessed)\b/i.test(text)) review.push('copy_possible_latin_relic_formula');
  if (new RegExp(String.raw`\b(?:worn|used|touched|owned|held|belonged|belonging)\b[^.\n]{0,60}\b(?:by|to)\s+\b${saintPerson}\b`, 'i').test(text)) {
    review.push('copy_saint_provenance');
  }
  return {hardBlocks: [...new Set(hardBlocks)], review: [...new Set(review)]};
}

function citationList(codes) {
  return [...new Set(codes)].map((code) => CANONICAL_CITATIONS[code]).filter(Boolean);
}

export function evaluatePolicy({offeredForSale = false, transactionKind = 'sale', disclosures, observations = [], listingCopy = {}} = {}) {
  const normalized = validateDisclosures(disclosures);
  const saleOrBarter = offeredForSale === true || transactionKind === 'barter';
  if (!saleOrBarter) {
    return {
      policy_version: POLICY_VERSION,
      decision: 'allow',
      reason_codes: ['display_only'],
      messages: ['This assessment does not authorize a sale or barter. The item is currently display only.'],
      citations: [],
      disclosures: normalized
    };
  }

  const copyFlags = savedCopyFlags(listingCopy);
  const hardBlocks = [...copyFlags.hardBlocks];
  if (normalized.object_kind === 'relic' || normalized.purported_relic === 'yes' || normalized.relic_class_claim) hardBlocks.push('sacred_relic_sale');
  if (normalized.spiritual_benefit_priced === 'yes') hardBlocks.push('spiritual_benefit_sale');
  if (hardBlocks.length) {
    const messages = [];
    const citationCodes = [];
    if (hardBlocks.includes('sacred_relic_sale')) {
      messages.push('This item cannot be offered for sale or barter because it is described as a sacred relic. If it has been misidentified, request review and provide provenance through the controlled review process.');
      citationCodes.push('canon_1190_1', 'relics_instruction_25');
    }
    if (hardBlocks.includes('spiritual_benefit_sale')) {
      messages.push('A blessing, grace, spiritual effect, or other spiritual benefit cannot be priced or sold as part of this listing.');
      citationCodes.push('ccc_2121');
    }
    return {policy_version: POLICY_VERSION, decision: 'block', reason_codes: hardBlocks, messages, citations: citationList(citationCodes), disclosures: normalized};
  }

  const review = [];
  if (!normalized.seller_attested) review.push('seller_attestation_required');
  if (normalized.object_kind === 'unknown' || normalized.object_kind === 'other') review.push('object_kind_unclear');
  if (normalized.object_kind === 'sacred_object' || normalized.blessed_or_dedicated === 'yes') review.push('blessed_or_dedicated');
  if (normalized.contains_human_material === 'yes') review.push('possible_human_material');
  if (normalized.ecclesiastical_owner === 'yes') review.push('ecclesiastical_ownership');
  if (normalized.authenticity_document === 'yes') review.push('authenticity_document_review');
  for (const key of ['purported_relic', 'contains_human_material', 'spiritual_benefit_priced', 'ecclesiastical_owner', 'blessed_or_dedicated', 'provenance_known']) {
    if (normalized[key] === 'unknown') review.push(`unknown_${key}`);
  }
  review.push(...copyFlags.review);
  review.push(...observedReviewFlags(observations));
  const reasonCodes = [...new Set(review)];
  if (reasonCodes.length) {
    const citationCodes = [];
    if (reasonCodes.some((code) => ['blessed_or_dedicated', 'ecclesiastical_ownership', 'copy_blessed_or_dedicated'].includes(code))) citationCodes.push('canon_1171');
    if (reasonCodes.some((code) => ['possible_human_material', 'possible_reliquary', 'relic_language', 'possible_authenticity_document', 'authenticity_document_review', 'copy_possible_human_material', 'copy_reliquary_language', 'copy_authenticity_document', 'copy_saint_provenance'].includes(code))) citationCodes.push('canon_1190_1', 'relics_instruction_25');
    return {
      policy_version: POLICY_VERSION,
      decision: 'review',
      reason_codes: reasonCodes,
      messages: ['This listing needs human review or additional seller information before it can be offered for sale. A photograph alone cannot establish blessing, authenticity, provenance, ownership, or canonical permission.'],
      citations: citationList(citationCodes),
      disclosures: normalized
    };
  }

  return {
    policy_version: POLICY_VERSION,
    decision: 'allow',
    reason_codes: ['seller_disclosures_clear'],
    messages: ['The supplied disclosures do not trigger a canonical-policy hold. This is not an authentication or a determination of civil legality.'],
    citations: [],
    disclosures: normalized
  };
}

function actorValue(actor) {
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 160) throw new HttpError(400, 'Actor is invalid');
  return actor.trim();
}

function opaqueId(value = crypto.randomUUID()) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 120) throw new HttpError(400, 'Identifier is invalid');
  return value;
}

function stringArray(value, name, {maximum = 30, itemLength = 1000} = {}) {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== 'string' || !item || item.length > itemLength)) {
    throw new HttpError(400, `${name} is invalid`);
  }
  return [...new Set(value)];
}

function citations(value) {
  if (!Array.isArray(value) || value.length > 20) throw new HttpError(400, 'Citations are invalid');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, 'Citations are invalid');
    const code = typeof item.code === 'string' ? item.code : '';
    const label = typeof item.label === 'string' ? item.label : '';
    const url = typeof item.url === 'string' ? item.url : '';
    if (!code || code.length > 80 || !label || label.length > 240 || !url.startsWith('https://www.vatican.va/') || url.length > 500) throw new HttpError(400, 'Citations are invalid');
    return {code, label, url};
  });
}

async function sha256(value) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function disclosureInsertStatement(database, revisionId, disclosures, actor) {
  if (typeof revisionId !== 'string' || !revisionId) throw new HttpError(400, 'Revision is required');
  const value = validateDisclosures(disclosures);
  return database.prepare(`INSERT INTO catalog_revision_disclosures(
    revision_id,object_kind,blessed_or_dedicated,purported_relic,relic_class_claim,contains_human_material,
    provenance_known,ecclesiastical_owner,authenticity_document,spiritual_benefit_priced,seller_attested,actor
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    revisionId, value.object_kind, value.blessed_or_dedicated, value.purported_relic, value.relic_class_claim,
    value.contains_human_material, value.provenance_known, value.ecclesiastical_owner,
    value.authenticity_document, value.spiritual_benefit_priced, value.seller_attested ? 1 : 0, actorValue(actor)
  );
}

export async function getRevisionDisclosures(database, revisionId) {
  const row = await database.prepare('SELECT * FROM catalog_revision_disclosures WHERE revision_id=?').bind(revisionId).first();
  if (!row) return {exists: false, revision_id: revisionId, ...DISCLOSURE_DEFAULTS};
  return {
    exists: true,
    revision_id: row.revision_id,
    object_kind: row.object_kind,
    blessed_or_dedicated: row.blessed_or_dedicated,
    purported_relic: row.purported_relic,
    relic_class_claim: row.relic_class_claim,
    contains_human_material: row.contains_human_material,
    provenance_known: row.provenance_known,
    ecclesiastical_owner: row.ecclesiastical_owner,
    authenticity_document: row.authenticity_document,
    spiritual_benefit_priced: row.spiritual_benefit_priced,
    seller_attested: row.seller_attested === true || row.seller_attested === 1,
    created_at: row.created_at
  };
}

function assessmentShape(row, review = null) {
  if (!row) return null;
  return {
    id: row.id,
    artwork_id: row.artwork_id,
    revision_id: row.revision_id,
    policy_version: row.policy_version,
    decision: row.decision,
    effective_decision: row.effective_decision,
    source: row.source,
    disclosure_hash: row.disclosure_hash,
    observation_set_hash: row.observation_set_hash,
    reason_codes: parseJson(row.reason_codes_json, []),
    messages: parseJson(row.messages_json, []),
    citations: parseJson(row.citations_json, []),
    model_id: row.model_id,
    prompt_version: row.prompt_version,
    created_at: row.created_at,
    review
  };
}

function reviewFromAssessmentRow(row) {
  return row?.review_id ? {
    id: row.review_id,
    decision: row.review_decision,
    note: row.review_note,
    actor: row.review_actor,
    created_at: row.review_created_at
  } : null;
}

const assessmentSelect = (activePolicy = false) => `SELECT e.*,
  (SELECT d.id FROM catalog_review_decisions d WHERE d.assessment_id=e.id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1) AS review_id,
  (SELECT d.decision FROM catalog_review_decisions d WHERE d.assessment_id=e.id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1) AS review_decision,
  (SELECT d.note FROM catalog_review_decisions d WHERE d.assessment_id=e.id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1) AS review_note,
  (SELECT d.actor FROM catalog_review_decisions d WHERE d.assessment_id=e.id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1) AS review_actor,
  (SELECT d.created_at FROM catalog_review_decisions d WHERE d.assessment_id=e.id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1) AS review_created_at
  FROM catalog_compliance_effective e
  JOIN catalog_compliance_assessments a ON a.id=e.id
  WHERE e.revision_id=? AND e.policy_version=${activePolicy ? `(SELECT id FROM catalog_policy_versions WHERE status='active' ORDER BY activated_at DESC,id DESC LIMIT 1)` : '?'}
  ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1`;

function observationShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    asset_id: row.asset_id,
    asset_checksum: row.asset_checksum,
    state: row.state,
    model_id: row.model_id,
    prompt_version: row.prompt_version,
    observation: parseJson(row.observation_json, {}),
    error_code: row.error_code,
    created_at: row.created_at
  };
}

export async function getLatestAssetObservation(database, assetId) {
  const row = await database.prepare(`SELECT * FROM catalog_asset_observations
    WHERE asset_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).bind(assetId).first();
  return observationShape(row);
}

export async function saveAssetObservation(database, input, actor) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const assetId = value.assetId || value.asset_id;
  const checksum = value.assetChecksum || value.asset_checksum;
  const modelId = value.model || value.model_id;
  const promptVersion = value.promptVersion || value.prompt_version;
  const state = value.state || 'completed';
  if (typeof assetId !== 'string' || !assetId) throw new HttpError(400, 'Asset is required');
  if (typeof checksum !== 'string' || checksum.length < 16 || checksum.length > 128) throw new HttpError(400, 'Asset checksum is invalid');
  if (typeof modelId !== 'string' || !modelId || modelId.length > 200) throw new HttpError(400, 'Model identifier is invalid');
  if (typeof promptVersion !== 'string' || !promptVersion || promptVersion.length > 80) throw new HttpError(400, 'Prompt version is invalid');
  if (!['pending', 'completed', 'error'].includes(state)) throw new HttpError(400, 'Observation state is invalid');
  const observation = value.observation && typeof value.observation === 'object' && !Array.isArray(value.observation) ? value.observation : {};
  const encoded = JSON.stringify(observation);
  if (encoded.length > 40_000) throw new HttpError(400, 'Observation is too large');
  const errorCode = value.errorCode || value.error_code || null;
  if (errorCode !== null && (typeof errorCode !== 'string' || errorCode.length > 120)) throw new HttpError(400, 'Observation error code is invalid');
  const id = opaqueId(value.id);
  await database.prepare(`INSERT INTO catalog_asset_observations(
    id,asset_id,asset_checksum,state,model_id,prompt_version,observation_json,error_code,actor
  ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
    id, assetId, checksum, state, modelId, promptVersion, encoded, errorCode, actorValue(actor)
  ).run();
  return getLatestAssetObservation(database, assetId);
}

export async function getAssessment(database, revisionId, policyVersion = POLICY_VERSION) {
  const row = await database.prepare(assessmentSelect(false)).bind(revisionId, policyVersion).first();
  return row ? assessmentShape(row, reviewFromAssessmentRow(row)) : null;
}

export async function getActiveAssessment(database, revisionId) {
  const row = await database.prepare(assessmentSelect(true)).bind(revisionId).first();
  return row ? assessmentShape(row, reviewFromAssessmentRow(row)) : null;
}

export async function saveAssessment(database, input, actor) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const id = opaqueId(value.id);
  if (typeof value.artwork_id !== 'string' || !value.artwork_id || typeof value.revision_id !== 'string' || !value.revision_id) throw new HttpError(400, 'Artwork and revision are required');
  const policyVersion = value.policy_version || POLICY_VERSION;
  if (typeof policyVersion !== 'string' || policyVersion.length > 80) throw new HttpError(400, 'Policy version is invalid');
  if (!ASSESSMENT_DECISIONS.has(value.decision)) throw new HttpError(400, 'Assessment decision is invalid');
  const source = value.source || 'deterministic';
  if (!ASSESSMENT_SOURCES.has(source)) throw new HttpError(400, 'Assessment source is invalid');
  const reasonCodes = stringArray(value.reason_codes || [], 'Reason codes', {itemLength: 120});
  const messages = stringArray(value.messages || [], 'Messages');
  const citationValues = citations(value.citations || []);
  const optionalHash = (candidate, name) => {
    if (candidate === null || candidate === undefined) return null;
    if (typeof candidate !== 'string' || candidate.length < 16 || candidate.length > 128) throw new HttpError(400, `${name} is invalid`);
    return candidate;
  };
  const modelId = value.model_id == null ? null : String(value.model_id);
  const promptVersion = value.prompt_version == null ? null : String(value.prompt_version);
  if (modelId && modelId.length > 200) throw new HttpError(400, 'Model identifier is invalid');
  if (promptVersion && promptVersion.length > 80) throw new HttpError(400, 'Prompt version is invalid');
  try {
    await database.prepare(`INSERT INTO catalog_compliance_assessments(
      id,artwork_id,revision_id,policy_version,decision,source,disclosure_hash,observation_set_hash,
      reason_codes_json,messages_json,citations_json,model_id,prompt_version,actor
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, value.artwork_id, value.revision_id, policyVersion, value.decision, source,
      optionalHash(value.disclosure_hash, 'Disclosure hash'), optionalHash(value.observation_set_hash, 'Observation-set hash'),
      JSON.stringify(reasonCodes), JSON.stringify(messages), JSON.stringify(citationValues), modelId, promptVersion, actorValue(actor)
    ).run();
  } catch (error) {
    if (String(error?.message || error).includes('POLICY_CHANGED')) {
      throw new HttpError(409, 'The active listing policy changed; run a new assessment', {code: 'POLICY_CHANGED'});
    }
    throw error;
  }
  return getAssessment(database, value.revision_id, policyVersion);
}

export async function createPendingAssessment(database, input, actor) {
  const existing = await getAssessment(database, input?.revision_id, input?.policy_version || POLICY_VERSION);
  if (existing?.decision === 'pending') return existing;
  return saveAssessment(database, {
    ...input,
    decision: 'pending',
    source: input?.source || 'ai_assisted',
    reason_codes: ['analysis_pending'],
    messages: ['Image and listing analysis is pending. Sale publication remains unavailable until assessment completes.'],
    citations: []
  }, actor);
}

export async function saveHumanReview(database, input, actor) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (typeof value.assessment_id !== 'string' || !value.assessment_id) throw new HttpError(400, 'Assessment is required');
  if (!REVIEW_DECISIONS.has(value.decision)) throw new HttpError(400, 'Review decision is invalid');
  const note = typeof value.note === 'string' ? value.note.trim() : '';
  if (note.length < 8) throw new HttpError(400, 'A meaningful review note is required');
  if (note.length > 4000) throw new HttpError(400, 'Review note is too long');
  const assessment = await database.prepare(`SELECT a.id,a.artwork_id,a.revision_id,a.policy_version,a.decision,
    (SELECT p.id FROM catalog_policy_versions p WHERE p.status='active' ORDER BY p.activated_at DESC,p.id DESC LIMIT 1) AS active_policy_id,
    (SELECT a2.id FROM catalog_compliance_assessments a2 WHERE a2.revision_id=a.revision_id AND a2.policy_version=a.policy_version
      ORDER BY a2.created_at DESC,a2.rowid DESC LIMIT 1) AS latest_assessment_id
    FROM catalog_compliance_assessments a WHERE a.id=?`).bind(value.assessment_id).first();
  if (!assessment) throw new HttpError(404, 'Assessment not found');
  if (assessment.policy_version !== assessment.active_policy_id) {
    throw new HttpError(409, 'The active listing policy changed; review the listing under the new policy', {code: 'POLICY_CHANGED'});
  }
  if (assessment.id !== assessment.latest_assessment_id) {
    throw new HttpError(409, 'Assessment has been superseded; review the latest assessment', {code: 'ASSESSMENT_SUPERSEDED'});
  }
  if (value.decision === 'approve' && assessment.decision !== 'review') throw new HttpError(409, 'A hard block or completed allowance cannot be human-approved');
  if (value.decision === 'approve') {
    const history = await listReviewEscalations(database, assessment.id);
    const latest = history.at(-1);
    if (!latest || !['local_priest', 'diocesan_chancery'].includes(latest.stage) || latest.outcome !== 'cleared') {
      throw new HttpError(409, 'Record a cleared local-priest or diocesan consultation before approval', {code: 'PRIEST_CLEARANCE_REQUIRED'});
    }
  }
  const id = opaqueId(value.id);
  const statements = [
    database.prepare('INSERT INTO catalog_review_decisions(id,assessment_id,decision,note,actor) VALUES(?,?,?,?,?)')
      .bind(id, assessment.id, value.decision, note, actorValue(actor)),
    database.prepare("INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json) VALUES(?,?, 'compliance_review', ?)")
      .bind(assessment.artwork_id, actorValue(actor), JSON.stringify({assessment_id: assessment.id, revision_id: assessment.revision_id, decision: value.decision}))
  ];
  try {
    if (typeof database.batch === 'function') await database.batch(statements);
    else for (const statement of statements) await statement.run();
  } catch (error) {
    if (String(error?.message || error).includes('POLICY_CHANGED')) {
      throw new HttpError(409, 'The active listing policy changed; review the listing under the new policy', {code: 'POLICY_CHANGED'});
    }
    if (String(error?.message || error).includes('ASSESSMENT_SUPERSEDED')) {
      throw new HttpError(409, 'Assessment has been superseded; review the latest assessment', {code: 'ASSESSMENT_SUPERSEDED'});
    }
    if (String(error?.message || error).includes('PRIEST_CLEARANCE_REQUIRED')) {
      throw new HttpError(409, 'Record a cleared local-priest or diocesan consultation before approval', {code: 'PRIEST_CLEARANCE_REQUIRED'});
    }
    throw error;
  }
  return getAssessment(database, assessment.revision_id, assessment.policy_version);
}

export async function runDeterministicAssessment(database, input, actor) {
  const disclosures = validateDisclosures(input?.disclosures);
  const revision = await database.prepare(`SELECT title,description,category,offered_for_sale
    FROM catalog_artwork_revisions WHERE id=? AND artwork_id=?`).bind(input?.revision_id, input?.artwork_id).first();
  if (!revision) throw new HttpError(409, 'Assessment revision does not match the artwork');
  const listingCopy = {title: revision.title, description: revision.description, category: revision.category};
  const result = evaluatePolicy({
    offeredForSale: revision.offered_for_sale === true || revision.offered_for_sale === 1,
    transactionKind: input?.transaction_kind || 'sale',
    disclosures,
    observations: input?.observations || [],
    listingCopy
  });
  return saveAssessment(database, {
    id: input?.id,
    artwork_id: input?.artwork_id,
    revision_id: input?.revision_id,
    policy_version: POLICY_VERSION,
    decision: result.decision,
    source: input?.source || 'deterministic',
    disclosure_hash: await sha256({disclosures, listing_copy: listingCopy}),
    observation_set_hash: input?.observations?.length ? await sha256(input.observations) : null,
    reason_codes: result.reason_codes,
    messages: result.messages,
    citations: result.citations,
    model_id: input?.model_id || null,
    prompt_version: input?.prompt_version || null
  }, actor);
}

function suggestionShape(row) {
  if (!row) return null;
  const evidence = parseJson(row.evidence_json, {});
  return {
    id: row.id,
    artwork_id: row.artwork_id,
    revision_id: row.revision_id,
    content_hash: row.content_hash,
    state: row.state,
    model_id: row.model_id,
    prompt_version: row.prompt_version,
    suggestions: parseJson(row.suggestion_json, {}),
    evidence,
    asset_ids: Array.isArray(evidence.asset_ids) ? evidence.asset_ids : [],
    observations: Array.isArray(evidence.observations) ? evidence.observations : [],
    uncertainties: Array.isArray(evidence.uncertainties) ? evidence.uncertainties : [],
    error_code: row.error_code,
    created_at: row.created_at
  };
}

export async function getLatestAiSuggestion(database, revisionId) {
  const row = await database.prepare(`SELECT * FROM catalog_ai_suggestions
    WHERE revision_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).bind(revisionId).first();
  return suggestionShape(row);
}

export async function saveAiSuggestion(database, input, actor) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const artworkId = value.artworkId || value.artwork_id;
  const revisionId = value.revisionId || value.revision_id;
  const promptVersion = value.promptVersion || value.prompt_version;
  const modelId = value.model || value.model_id;
  if (typeof artworkId !== 'string' || !artworkId || typeof revisionId !== 'string' || !revisionId) throw new HttpError(400, 'Artwork and revision are required');
  if (typeof promptVersion !== 'string' || !promptVersion || promptVersion.length > 80) throw new HttpError(400, 'Prompt version is invalid');
  if (typeof modelId !== 'string' || !modelId || modelId.length > 200) throw new HttpError(400, 'Model identifier is invalid');
  if (!value.suggestions || typeof value.suggestions !== 'object' || Array.isArray(value.suggestions)) throw new HttpError(400, 'Suggestions are invalid');
  const encodedSuggestions = JSON.stringify(value.suggestions);
  if (encodedSuggestions.length > 40_000) throw new HttpError(400, 'Suggestions are too large');
  const observations = Array.isArray(value.observations) ? value.observations : [];
  const uncertainties = Array.isArray(value.uncertainties) ? value.uncertainties : [];
  if (observations.length > 50 || uncertainties.length > 50) throw new HttpError(400, 'Suggestion evidence is too large');
  const assetIds = value.assetId ? [value.assetId] : Array.isArray(value.assetIds) ? value.assetIds : [];
  if (assetIds.length > 4 || assetIds.some((id) => typeof id !== 'string' || id.length < 8 || id.length > 160)) throw new HttpError(400, 'Suggestion asset identifiers are invalid');
  const encodedEvidence = JSON.stringify({
    asset_ids: assetIds,
    observations,
    uncertainties
  });
  if (encodedEvidence.length > 40_000) throw new HttpError(400, 'Suggestion evidence is too large');
  const revision = await database.prepare('SELECT artwork_id,content_hash FROM catalog_artwork_revisions WHERE id=?').bind(revisionId).first();
  if (!revision || revision.artwork_id !== artworkId) throw new HttpError(409, 'Suggestion revision does not match the artwork');
  const id = opaqueId(value.id);
  await database.prepare(`INSERT INTO catalog_ai_suggestions(
    id,artwork_id,revision_id,content_hash,state,model_id,prompt_version,suggestion_json,evidence_json,actor
  ) VALUES(?,?,?,?, 'completed',?,?,?,?,?)`).bind(
    id, artworkId, revisionId, revision.content_hash, modelId, promptVersion,
    encodedSuggestions, encodedEvidence, actorValue(actor)
  ).run();
  return getLatestAiSuggestion(database, revisionId);
}
