const MICROUSD_PER_CENT = 10_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const ESTIMATED_COST_CENTS_PER_IMAGE = 5;
const STALE_RESERVATION_SECONDS = 30 * 60;

export const AI_BUDGET_DEFAULTS = Object.freeze({
  monthlyImageCap: 100,
  monthlyBudgetCents: 500,
  maxImagesPerAction: 4
});

export class AiBudgetError extends Error {
  constructor(message, code = 'ai_budget_error', status = 503) {
    super(message);
    this.name = 'AiBudgetError';
    this.code = code;
    this.status = status;
  }
}

function boundedInteger(value, fallback, label, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new AiBudgetError(`${label} is invalid`, 'ai_budget_configuration', 503);
  }
  return normalized;
}

function requiredInteger(value, label, minimum, maximum, code = 'ai_budget_input', status = 400) {
  if (value === undefined || value === null || value === '') {
    throw new AiBudgetError(`${label} is required`, code, status);
  }
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new AiBudgetError(`${label} is invalid`, code, status);
  }
  return normalized;
}

function normalizedPolicy(value = {}) {
  const config = ['ai_budget_configuration', 503];
  const monthlyImageCap = requiredInteger(value.monthlyImageCap, 'AI monthly request cap', 1, 1_000_000, ...config);
  const monthlyBudgetCents = requiredInteger(value.monthlyBudgetCents, 'AI monthly budget', 1, 100_000_000, ...config);
  const maxImagesPerAction = requiredInteger(value.maxImagesPerAction, 'AI image limit', 1, 100, ...config);
  const estimatedCostCentsPerImage = ESTIMATED_COST_CENTS_PER_IMAGE;
  return {monthlyImageCap, monthlyBudgetCents, maxImagesPerAction, estimatedCostCentsPerImage};
}

export function aiBudgetPolicy(env = {}) {
  const monthlyImageCap = boundedInteger(
    env.AI_MONTHLY_REQUEST_CAP,
    AI_BUDGET_DEFAULTS.monthlyImageCap,
    'AI monthly request cap',
    1,
    1_000_000
  );
  const monthlyBudgetCents = boundedInteger(
    env.AI_MONTHLY_BUDGET_CENTS,
    AI_BUDGET_DEFAULTS.monthlyBudgetCents,
    'AI monthly budget',
    1,
    100_000_000
  );
  const maxImagesPerAction = boundedInteger(
    env.AI_MAX_IMAGES_PER_ACTION,
    AI_BUDGET_DEFAULTS.maxImagesPerAction,
    'AI image limit',
    1,
    100
  );
  const estimatedCostCentsPerImage = ESTIMATED_COST_CENTS_PER_IMAGE;
  return normalizedPolicy({monthlyImageCap, monthlyBudgetCents, maxImagesPerAction, estimatedCostCentsPerImage});
}

function safeIdentifier(value, label, maximum = 160) {
  if (typeof value !== 'string') throw new AiBudgetError(`${label} is required`, 'ai_budget_input', 400);
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > maximum || !ID_PATTERN.test(normalized)) {
    throw new AiBudgetError(`${label} is invalid`, 'ai_budget_input', 400);
  }
  return normalized;
}

function safeText(value, label, maximum) {
  if (typeof value !== 'string') throw new AiBudgetError(`${label} is required`, 'ai_budget_input', 400);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new AiBudgetError(`${label} is invalid`, 'ai_budget_input', 400);
  return normalized;
}

function nowValue(value) {
  const seconds = value === undefined ? Math.floor(Date.now() / 1000) : value;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new AiBudgetError('AI budget time is invalid', 'ai_budget_input', 400);
  return seconds;
}

export function utcBudgetMonth(nowSeconds = Math.floor(Date.now() / 1000)) {
  const seconds = nowValue(nowSeconds);
  const iso = new Date(seconds * 1000).toISOString();
  if (!/^\d{4}-\d{2}/.test(iso)) throw new AiBudgetError('AI budget time is invalid', 'ai_budget_input', 400);
  return iso.slice(0, 7);
}

function objectJson(value, label) {
  if (value === undefined || value === null) return '{}';
  if (typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AiBudgetError(`${label} is invalid`, 'ai_budget_input', 400);
  }
  const json = JSON.stringify(value);
  if (json.length > 20_000) throw new AiBudgetError(`${label} is too large`, 'ai_budget_input', 400);
  return json;
}

async function first(statement) {
  return (await statement.first()) || null;
}

function changes(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function databaseError(error) {
  const message = String(error?.message || error || '');
  if (message.includes('AI_ACTION_IMAGE_CAP')) return new AiBudgetError('Too many images were requested at once', 'ai_action_image_cap', 429);
  if (message.includes('AI_MONTHLY_IMAGE_CAP')) return new AiBudgetError('The monthly AI image limit has been reached', 'ai_monthly_image_cap', 429);
  if (message.includes('AI_MONTHLY_BUDGET_CAP')) return new AiBudgetError('The monthly AI spending limit has been reached', 'ai_monthly_budget_cap', 429);
  if (message.includes('AI_BUDGET_MONTH')) return new AiBudgetError('The AI budget month is unavailable', 'ai_budget_state', 503);
  if (message.includes('AI_RECONCILIATION_STATE')) return new AiBudgetError('The AI reservation could not be reconciled', 'ai_budget_conflict', 409);
  return error instanceof AiBudgetError ? error : new AiBudgetError('AI usage could not be reserved', 'ai_budget_unavailable', 503);
}

function sameReservation(row, expected) {
  return row
    && row.action_id === expected.actionId
    && row.month_utc === expected.monthUtc
    && Number(row.image_count) === expected.imageCount
    && row.model_id === expected.modelId
    && Number(row.estimated_cost_microusd) === expected.estimatedCostMicrousd;
}

function reservationResult(row, reused = false) {
  return {
    reservation_id: row.id,
    action_id: row.action_id,
    month_utc: row.month_utc,
    image_count: Number(row.image_count),
    state: row.state,
    estimated_cost_microusd: Number(row.estimated_cost_microusd),
    actual_cost_microusd: row.actual_cost_microusd === null || row.actual_cost_microusd === undefined
      ? null
      : Number(row.actual_cost_microusd),
    reused
  };
}

async function existingForAction(database, actionId) {
  return first(database.prepare('SELECT * FROM catalog_ai_inference_ledger WHERE action_id=?').bind(actionId));
}

async function requireCompatibleMonth(database, monthUtc, policy) {
  const row = await first(database.prepare('SELECT * FROM catalog_ai_budget_months WHERE month_utc=?').bind(monthUtc));
  if (!row) return;
  const expectedBudget = policy.monthlyBudgetCents * MICROUSD_PER_CENT;
  if (Number(row.image_cap) !== policy.monthlyImageCap
    || Number(row.budget_microusd) !== expectedBudget
    || Number(row.max_images_per_action) !== policy.maxImagesPerAction) {
    throw new AiBudgetError('The AI budget policy cannot change during an active UTC month', 'ai_budget_configuration', 503);
  }
}

export async function reserveAiInferenceBudget(database, input = {}, options = {}) {
  if (!database?.prepare || typeof database.batch !== 'function') {
    throw new AiBudgetError('Atomic AI budget storage is unavailable', 'ai_budget_unavailable', 503);
  }
  const policy = options.policy ? normalizedPolicy(options.policy) : aiBudgetPolicy(options.env || {});
  const imageCount = requiredInteger(input.imageCount, 'AI image count', 1, policy.maxImagesPerAction);
  const actionId = safeIdentifier(input.actionId, 'AI action identifier');
  const modelId = safeText(input.modelId, 'AI model identifier', 200);
  const actor = safeText(input.actor, 'AI actor', 160);
  const nowSeconds = nowValue(options.nowSeconds);
  await reconcileStaleAiReservations(database, {nowSeconds});
  const monthUtc = utcBudgetMonth(nowSeconds);
  const reservationId = input.reservationId === undefined
    ? `ai-${crypto.randomUUID()}`
    : safeIdentifier(input.reservationId, 'AI reservation identifier', 120);
  const estimatedCostMicrousd = input.estimatedCostMicrousd === undefined
    ? imageCount * policy.estimatedCostCentsPerImage * MICROUSD_PER_CENT
    : requiredInteger(input.estimatedCostMicrousd, 'AI estimated cost', 0, 1_000_000_000_000);
  const expected = {actionId, monthUtc, imageCount, modelId, estimatedCostMicrousd};

  const prior = await existingForAction(database, actionId);
  if (prior) {
    if (!sameReservation(prior, expected)) throw new AiBudgetError('AI action identifier was reused with different inputs', 'ai_budget_conflict', 409);
    return reservationResult(prior, true);
  }
  await requireCompatibleMonth(database, monthUtc, policy);

  const monthInsert = database.prepare(`INSERT OR IGNORE INTO catalog_ai_budget_months(
    month_utc,image_cap,budget_microusd,max_images_per_action,created_at,updated_at
  ) VALUES(?,?,?,?,?,?)`).bind(
    monthUtc,
    policy.monthlyImageCap,
    policy.monthlyBudgetCents * MICROUSD_PER_CENT,
    policy.maxImagesPerAction,
    nowSeconds,
    nowSeconds
  );
  const ledgerInsert = database.prepare(`INSERT INTO catalog_ai_inference_ledger(
    id,action_id,month_utc,image_count,model_id,state,estimated_cost_microusd,usage_json,actor,created_at
  ) VALUES(?,?,?,?,?,'reserved',?,'{}',?,?)`).bind(
    reservationId, actionId, monthUtc, imageCount, modelId, estimatedCostMicrousd, actor, nowSeconds
  );
  try {
    await database.batch([monthInsert, ledgerInsert]);
  } catch (error) {
    const raced = await existingForAction(database, actionId);
    if (raced && sameReservation(raced, expected)) return reservationResult(raced, true);
    throw databaseError(error);
  }
  const row = await existingForAction(database, actionId);
  if (!row) throw new AiBudgetError('AI reservation was not recorded', 'ai_budget_unavailable', 503);
  return reservationResult(row, false);
}

function actualCost(input, row, state) {
  if (input.actualCostMicrousd !== undefined) {
    return requiredInteger(input.actualCostMicrousd, 'AI actual cost', 0, 1_000_000_000_000);
  }
  if (input.actualCostCents !== undefined) {
    return requiredInteger(input.actualCostCents, 'AI actual cost', 0, 100_000_000) * MICROUSD_PER_CENT;
  }
  if (state === 'completed') throw new AiBudgetError('Completed AI usage requires an actual cost', 'ai_budget_input', 400);
  // Provider errors can occur after billable work. Unknown failures retain the
  // conservative reservation estimate rather than silently releasing budget.
  return Number(row.estimated_cost_microusd);
}

export async function reconcileAiInferenceBudget(database, input = {}, options = {}) {
  if (!database?.prepare) throw new AiBudgetError('AI budget storage is unavailable', 'ai_budget_unavailable', 503);
  const reservationId = safeIdentifier(input.reservationId, 'AI reservation identifier', 120);
  const state = input.state;
  if (!['completed', 'failed', 'uncertain'].includes(state)) throw new AiBudgetError('AI result state is invalid', 'ai_budget_input', 400);
  const row = await first(database.prepare('SELECT * FROM catalog_ai_inference_ledger WHERE id=?').bind(reservationId));
  if (!row) throw new AiBudgetError('AI reservation was not found', 'ai_budget_not_found', 404);
  if (row.state !== 'reserved') {
    if (row.state !== state) throw new AiBudgetError('AI reservation is already reconciled', 'ai_budget_conflict', 409);
    return reservationResult(row, true);
  }
  const cost = actualCost(input, row, state);
  const usageJson = objectJson(input.usage, 'AI usage');
  const errorCode = state === 'completed'
    ? null
    : safeText(input.errorCode || (state === 'failed' ? 'provider_failure' : 'provider_uncertain'), 'AI error code', 120);
  const reconciledAt = nowValue(options.nowSeconds);
  let result;
  try {
    result = await database.prepare(`UPDATE catalog_ai_inference_ledger
      SET state=?,actual_cost_microusd=?,usage_json=?,error_code=?,reconciled_at=?
      WHERE id=? AND state='reserved'`).bind(
      state, cost, usageJson, errorCode, reconciledAt, reservationId
    ).run();
  } catch (error) {
    throw databaseError(error);
  }
  if (!changes(result)) {
    const current = await first(database.prepare('SELECT * FROM catalog_ai_inference_ledger WHERE id=?').bind(reservationId));
    if (current?.state === state) return reservationResult(current, true);
    throw new AiBudgetError('AI reservation changed concurrently', 'ai_budget_conflict', 409);
  }
  const current = await first(database.prepare('SELECT * FROM catalog_ai_inference_ledger WHERE id=?').bind(reservationId));
  return reservationResult(current, false);
}

export function failAiInferenceBudget(database, input = {}, options = {}) {
  return reconcileAiInferenceBudget(database, {...input, state: input.state || 'failed'}, options);
}

export async function reconcileStaleAiReservations(database, options = {}) {
  if (!database?.prepare) throw new AiBudgetError('AI budget storage is unavailable', 'ai_budget_unavailable', 503);
  const nowSeconds = nowValue(options.nowSeconds);
  const staleBefore = nowSeconds - STALE_RESERVATION_SECONDS;
  const rows = (await database.prepare(`SELECT id,estimated_cost_microusd FROM catalog_ai_inference_ledger
    WHERE state='reserved' AND created_at<=? ORDER BY created_at,id LIMIT 100`).bind(staleBefore).all()).results ?? [];
  for (const row of rows) {
    try {
      await database.prepare(`UPDATE catalog_ai_inference_ledger
        SET state='uncertain',actual_cost_microusd=estimated_cost_microusd,
            usage_json='{"reconciliation":"stale_timeout"}',error_code='worker_interrupted',reconciled_at=?
        WHERE id=? AND state='reserved'`).bind(nowSeconds, row.id).run();
    } catch (error) {
      throw databaseError(error);
    }
  }
  return rows.length;
}

function microsToCeilingCents(value) {
  return Math.ceil(Number(value) / MICROUSD_PER_CENT);
}

export async function getAiBudgetStatus(database, env = {}, options = {}) {
  if (!database?.prepare) throw new AiBudgetError('AI budget storage is unavailable', 'ai_budget_unavailable', 503);
  const policy = options.policy ? normalizedPolicy(options.policy) : aiBudgetPolicy(env);
  const nowSeconds = nowValue(options.nowSeconds);
  await reconcileStaleAiReservations(database, {nowSeconds});
  const monthUtc = utcBudgetMonth(nowSeconds);
  const row = await first(database.prepare('SELECT * FROM catalog_ai_budget_months WHERE month_utc=?').bind(monthUtc));
  const attemptedImages = Number(row?.attempted_images || 0);
  const reservedMicrousd = Number(row?.reserved_microusd || 0);
  const actualMicrousd = Number(row?.actual_microusd || 0);
  const imageCap = Number(row?.image_cap || policy.monthlyImageCap);
  const budgetMicrousd = Number(row?.budget_microusd || policy.monthlyBudgetCents * MICROUSD_PER_CENT);
  const committedMicrousd = reservedMicrousd + actualMicrousd;
  return {
    month_utc: monthUtc,
    monthly_image_cap: imageCap,
    monthly_budget_cents: microsToCeilingCents(budgetMicrousd),
    max_images_per_action: Number(row?.max_images_per_action || policy.maxImagesPerAction),
    attempted_images: attemptedImages,
    remaining_images: Math.max(0, imageCap - attemptedImages),
    reserved_cost_cents: microsToCeilingCents(reservedMicrousd),
    actual_cost_cents: microsToCeilingCents(actualMicrousd),
    remaining_budget_cents: Math.floor(Math.max(0, budgetMicrousd - committedMicrousd) / MICROUSD_PER_CENT),
    exhausted: attemptedImages >= imageCap || committedMicrousd >= budgetMicrousd
  };
}
