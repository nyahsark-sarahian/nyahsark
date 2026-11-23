import {HttpError} from './http.js';

const MAX_CENTS = 100_000_000;
const STAGES = new Set(['seller_clarification', 'local_priest', 'diocesan_chancery']);
const OUTCOMES = new Set(['requested', 'cleared', 'blocked', 'escalated', 'unable_to_resolve']);
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function identifier(value, label) {
  if (typeof value !== 'string' || !OPAQUE.test(value)) throw new HttpError(400, `${label} is invalid`);
  return value;
}

function actorValue(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) throw new HttpError(400, 'Actor is invalid');
  return value;
}

function boundedText(value, minimum, maximum, label) {
  const text = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  if (text.length < minimum || text.length > maximum) throw new HttpError(400, `${label} must be ${minimum} to ${maximum} characters`);
  return text;
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

const all = async (statement) => (await statement.all()).results ?? [];

function pricingShape(row) {
  return row ? {
    id: row.id,
    artwork_id: row.artwork_id,
    seller_floor_cents: Number(row.seller_floor_cents),
    actor: row.actor,
    created_at: Number(row.created_at)
  } : null;
}

export async function getPricingPreference(database, artworkId) {
  const artwork = identifier(artworkId, 'Artwork identifier');
  const row = await database.prepare(`SELECT id,artwork_id,seller_floor_cents,actor,created_at
    FROM catalog_listing_price_floors WHERE artwork_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).bind(artwork).first();
  return pricingShape(row);
}

export async function savePricingPreference(database, input, actor) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const artworkId = identifier(value.artwork_id, 'Artwork identifier');
  const floor = value.seller_floor_cents;
  if (!Number.isSafeInteger(floor) || floor < 1 || floor > MAX_CENTS) {
    throw new HttpError(400, 'Seller price floor must be a positive amount');
  }
  const current = await database.prepare(`SELECT r.base_price_cents
    FROM catalog_artwork_heads h JOIN catalog_artwork_revisions r ON r.id=h.working_revision_id
    WHERE h.artwork_id=?`).bind(artworkId).first();
  if (!current) throw new HttpError(404, 'Artwork not found');
  const currentPrice = Number(current.base_price_cents);
  if (Number.isSafeInteger(currentPrice) && currentPrice >= 1 && floor > currentPrice) {
    throw new HttpError(400, 'Seller price floor cannot exceed the current saved price');
  }
  const existing = await getPricingPreference(database, artworkId);
  if (existing?.seller_floor_cents === floor) return existing;

  const id = newId('floor');
  const auditActor = actorValue(actor);
  const statements = [
    database.prepare(`INSERT INTO catalog_listing_price_floors(id,artwork_id,seller_floor_cents,actor)
      VALUES(?,?,?,?)`).bind(id, artworkId, floor, auditActor),
    database.prepare(`INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json)
      VALUES(?,?,'seller_price_floor_saved',?)`).bind(
      artworkId,
      auditActor,
      JSON.stringify({preference_id: id, seller_floor_cents: floor})
    )
  ];
  if (typeof database.batch === 'function') await database.batch(statements);
  else for (const statement of statements) await statement.run();
  return getPricingPreference(database, artworkId);
}

function escalationShape(row) {
  return {
    id: row.id,
    assessment_id: row.assessment_id,
    stage: row.stage,
    outcome: row.outcome,
    reviewer_role: row.reviewer_role,
    note: row.note,
    actor: row.actor,
    created_at: Number(row.created_at)
  };
}

export async function listReviewEscalations(database, assessmentId) {
  const assessment = identifier(assessmentId, 'Assessment identifier');
  const rows = await all(database.prepare(`SELECT id,assessment_id,stage,outcome,reviewer_role,note,actor,created_at
    FROM catalog_review_escalations WHERE assessment_id=? ORDER BY created_at,rowid`).bind(assessment));
  return rows.map(escalationShape);
}

function stageTransition(stage, history) {
  const latest = history.at(-1);
  if (!latest) return stage === 'seller_clarification' ? null : 'Begin with seller clarification before escalating the review.';
  if (['cleared', 'blocked'].includes(latest.outcome)) {
    return 'The latest consultation is final; run a new assessment before recording another consultation.';
  }
  if (latest.stage === 'diocesan_chancery' && ['escalated', 'unable_to_resolve'].includes(latest.outcome)) {
    return 'The diocesan consultation remains unresolved; keep the listing held and run a new assessment only if the facts change.';
  }
  if (latest.outcome === 'requested') {
    return stage === latest.stage ? null : 'Record the outcome of the requested consultation before changing stages.';
  }
  const next = latest.stage === 'seller_clarification' ? 'local_priest' : 'diocesan_chancery';
  return stage === next ? null : 'Continue to the next consultation stage without moving backward.';
}

export async function saveReviewEscalation(database, input, actor) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const assessmentId = identifier(value.assessment_id, 'Assessment identifier');
  if (!STAGES.has(value.stage)) throw new HttpError(400, 'Escalation stage is invalid');
  if (!OUTCOMES.has(value.outcome)) throw new HttpError(400, 'Escalation outcome is invalid');
  if (value.stage === 'seller_clarification' && value.outcome === 'cleared') {
    throw new HttpError(400, 'Seller clarification cannot clear an ambiguous listing; record a local-priest or diocesan clearance', {code: 'SELLER_CLEARANCE_NOT_ALLOWED'});
  }
  const reviewerRole = boundedText(value.reviewer_role, 2, 160, 'Reviewer role');
  const note = boundedText(value.note, 8, 4000, 'Escalation note');
  const assessment = await database.prepare(`SELECT a.id,a.artwork_id,a.revision_id,a.policy_version,a.decision,
    (SELECT p.id FROM catalog_policy_versions p WHERE p.status='active' ORDER BY p.activated_at DESC,p.id DESC LIMIT 1) AS active_policy_id,
    (SELECT a2.id FROM catalog_compliance_assessments a2 WHERE a2.revision_id=a.revision_id AND a2.policy_version=a.policy_version
      ORDER BY a2.created_at DESC,a2.rowid DESC LIMIT 1) AS latest_assessment_id,
    (SELECT d.decision FROM catalog_review_decisions d WHERE d.assessment_id=a.id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1) AS review_decision
    FROM catalog_compliance_assessments a WHERE a.id=?`).bind(assessmentId).first();
  if (!assessment) throw new HttpError(404, 'Assessment not found');
  if (assessment.policy_version !== assessment.active_policy_id) {
    throw new HttpError(409, 'The active listing policy changed; run a new assessment', {code: 'POLICY_CHANGED'});
  }
  if (assessment.id !== assessment.latest_assessment_id) {
    throw new HttpError(409, 'Assessment has been superseded; consult on the latest assessment', {code: 'ASSESSMENT_SUPERSEDED'});
  }
  if (assessment.review_decision) {
    throw new HttpError(409, 'This assessment already has a human decision', {code: 'ASSESSMENT_RESOLVED'});
  }
  if (assessment.decision !== 'review') {
    throw new HttpError(409, 'Only an ambiguous review assessment can enter the consultation process', {code: 'ESCALATION_NOT_ALLOWED'});
  }
  const history = await listReviewEscalations(database, assessmentId);
  const prerequisite = stageTransition(value.stage, history);
  if (prerequisite) throw new HttpError(409, prerequisite, {code: 'ESCALATION_SEQUENCE'});

  const id = newId('escalation');
  const auditActor = actorValue(actor);
  const statements = [
    database.prepare(`INSERT INTO catalog_review_escalations(
      id,assessment_id,stage,outcome,reviewer_role,note,actor
    ) VALUES(?,?,?,?,?,?,?)`).bind(id, assessmentId, value.stage, value.outcome, reviewerRole, note, auditActor),
    database.prepare(`INSERT INTO catalog_audit_events(artwork_id,actor,action,details_json)
      VALUES(?,?,'compliance_escalation',?)`).bind(
      assessment.artwork_id,
      auditActor,
      JSON.stringify({
        escalation_id: id,
        assessment_id: assessmentId,
        revision_id: assessment.revision_id,
        stage: value.stage,
        outcome: value.outcome,
        reviewer_role: reviewerRole
      })
    )
  ];
  try {
    if (typeof database.batch === 'function') await database.batch(statements);
    else for (const statement of statements) await statement.run();
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('POLICY_CHANGED')) throw new HttpError(409, 'The active listing policy changed; run a new assessment', {code: 'POLICY_CHANGED'});
    if (message.includes('ASSESSMENT_SUPERSEDED')) throw new HttpError(409, 'Assessment has been superseded; consult on the latest assessment', {code: 'ASSESSMENT_SUPERSEDED'});
    if (message.includes('ASSESSMENT_RESOLVED')) throw new HttpError(409, 'This assessment already has a human decision', {code: 'ASSESSMENT_RESOLVED'});
    if (message.includes('SELLER_CLEARANCE_NOT_ALLOWED')) throw new HttpError(400, 'Seller clarification cannot clear an ambiguous listing; record a local-priest or diocesan clearance', {code: 'SELLER_CLEARANCE_NOT_ALLOWED'});
    if (message.includes('ESCALATION_TERMINAL')) throw new HttpError(409, 'The latest consultation is final; run a new assessment before continuing', {code: 'ESCALATION_TERMINAL'});
    if (message.includes('ESCALATION_SEQUENCE')) throw new HttpError(409, 'Complete the prior consultation stage before continuing', {code: 'ESCALATION_SEQUENCE'});
    throw error;
  }
  const entries = await listReviewEscalations(database, assessmentId);
  return {escalation: entries.find((entry) => entry.id === id), escalations: entries};
}
