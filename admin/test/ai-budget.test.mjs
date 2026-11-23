import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {
  AI_BUDGET_DEFAULTS,
  AiBudgetError,
  aiBudgetPolicy,
  failAiInferenceBudget,
  getAiBudgetStatus,
  reconcileStaleAiReservations,
  reconcileAiInferenceBudget,
  reserveAiInferenceBudget,
  utcBudgetMonth
} from '../src/ai-budget.js';

const JANUARY = Date.UTC(2027, 0, 15, 12) / 1000;
const FEBRUARY = Date.UTC(2027, 1, 15, 12) / 1000;
const migrations = [
  '0001_legacy_inventory.sql',
  '0002_private_image_objects.sql',
  '0003_revisioned_catalog.sql',
  '0004_settings_commands.sql',
  '0005_listing_compliance.sql',
  '0006_ai_governance.sql'
].map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const sql of migrations) sqlite.exec(sql);
  const wrap = (sql, values = []) => ({
    bind(...next) { return wrap(sql, next); },
    _run() {
      const meta = sqlite.prepare(sql).run(...values);
      return {meta: {changes: Number(meta.changes)}};
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

function request(suffix, overrides = {}) {
  return {
    actionId: `action-${suffix}`,
    imageCount: 1,
    modelId: '@cf/meta/llama-3.2-11b-vision-instruct',
    actor: 'test:ai-budget',
    ...overrides
  };
}

test('policy defaults implement the approved pilot and invalid configuration fails closed', () => {
  assert.deepEqual(AI_BUDGET_DEFAULTS, {
    monthlyImageCap: 100,
    monthlyBudgetCents: 500,
    maxImagesPerAction: 4
  });
  assert.deepEqual(aiBudgetPolicy({}), {
    monthlyImageCap: 100,
    monthlyBudgetCents: 500,
    maxImagesPerAction: 4,
    estimatedCostCentsPerImage: 5
  });
  assert.equal(aiBudgetPolicy({AI_ESTIMATED_COST_CENTS_PER_IMAGE: '1'}).estimatedCostCentsPerImage, 5);
  assert.equal(utcBudgetMonth(JANUARY), '2027-01');
  assert.throws(
    () => aiBudgetPolicy({AI_MONTHLY_BUDGET_CENTS: 'not-a-number'}),
    (error) => error instanceof AiBudgetError && error.code === 'ai_budget_configuration' && error.status === 503
  );
});

test('reservation requires atomic storage, a positive image count, and at most four images', async () => {
  const {DB} = database();
  await assert.rejects(
    () => reserveAiInferenceBudget({prepare: DB.prepare.bind(DB)}, request('no-batch'), {nowSeconds: JANUARY}),
    (error) => error.code === 'ai_budget_unavailable' && error.status === 503
  );
  await assert.rejects(
    () => reserveAiInferenceBudget(DB, request('missing-images', {imageCount: undefined}), {nowSeconds: JANUARY}),
    (error) => error.code === 'ai_budget_input' && error.status === 400
  );
  await assert.rejects(
    () => reserveAiInferenceBudget(DB, request('too-many', {imageCount: 5}), {nowSeconds: JANUARY}),
    (error) => error.code === 'ai_budget_input' && error.status === 400
  );
  assert.equal(DB.prepare('SELECT count(*) AS count FROM catalog_ai_inference_ledger').first().count, 0);
});

test('concurrent reservations cannot exceed 100 image inferences in a UTC month', async () => {
  const {DB} = database();
  const outcomes = await Promise.allSettled(Array.from({length: 26}, (_, index) =>
    reserveAiInferenceBudget(DB, request(`monthly-${String(index).padStart(2, '0')}`, {imageCount: 4}), {
      nowSeconds: JANUARY
    })
  ));
  assert.equal(outcomes.filter(({status}) => status === 'fulfilled').length, 25);
  const rejected = outcomes.filter(({status}) => status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.ok(['ai_monthly_image_cap', 'ai_monthly_budget_cap'].includes(rejected[0].reason.code));
  const status = await getAiBudgetStatus(DB, {}, {nowSeconds: JANUARY});
  assert.deepEqual(status, {
    month_utc: '2027-01',
    monthly_image_cap: 100,
    monthly_budget_cents: 500,
    max_images_per_action: 4,
    attempted_images: 100,
    remaining_images: 0,
    reserved_cost_cents: 500,
    actual_cost_cents: 0,
    remaining_budget_cents: 0,
    exhausted: true
  });
});

test('the spending cap is enforced independently from the image cap', async () => {
  const {DB} = database();
  const env = {
    AI_MONTHLY_REQUEST_CAP: 1_000,
    AI_MONTHLY_BUDGET_CENTS: 10,
    AI_MAX_IMAGES_PER_ACTION: 4
  };
  await reserveAiInferenceBudget(DB, request('budget-full', {imageCount: 2}), {env, nowSeconds: JANUARY});
  await assert.rejects(
    () => reserveAiInferenceBudget(DB, request('budget-over'), {env, nowSeconds: JANUARY}),
    (error) => error.code === 'ai_monthly_budget_cap' && error.status === 429
  );
  const status = await getAiBudgetStatus(DB, env, {nowSeconds: JANUARY});
  assert.equal(status.attempted_images, 2);
  assert.equal(status.remaining_images, 998);
  assert.equal(status.reserved_cost_cents, 10);
  assert.equal(status.remaining_budget_cents, 0);
  assert.equal(status.exhausted, true);
});

test('an action identifier makes reservation retries idempotent without double counting', async () => {
  const {DB} = database();
  const first = await reserveAiInferenceBudget(DB, request('idempotent'), {nowSeconds: JANUARY});
  const retried = await reserveAiInferenceBudget(DB, request('idempotent'), {nowSeconds: JANUARY});
  assert.equal(retried.reservation_id, first.reservation_id);
  assert.equal(retried.reused, true);
  assert.equal((await getAiBudgetStatus(DB, {}, {nowSeconds: JANUARY})).attempted_images, 1);
  await assert.rejects(
    () => reserveAiInferenceBudget(DB, request('idempotent', {imageCount: 2}), {nowSeconds: JANUARY}),
    (error) => error.code === 'ai_budget_conflict' && error.status === 409
  );
});

test('completed calls reconcile the conservative reservation to actual provider cost', async () => {
  const {sqlite, DB} = database();
  const reservation = await reserveAiInferenceBudget(DB, request('complete', {imageCount: 2}), {nowSeconds: JANUARY});
  const completed = await reconcileAiInferenceBudget(DB, {
    reservationId: reservation.reservation_id,
    state: 'completed',
    actualCostCents: 3,
    usage: {input_tokens: 120, output_tokens: 40}
  }, {nowSeconds: JANUARY + 5});
  assert.equal(completed.state, 'completed');
  assert.equal(completed.actual_cost_microusd, 30_000);
  const status = await getAiBudgetStatus(DB, {}, {nowSeconds: JANUARY});
  assert.equal(status.reserved_cost_cents, 0);
  assert.equal(status.actual_cost_cents, 3);
  assert.equal(status.remaining_budget_cents, 497);
  const stored = sqlite.prepare('SELECT state,usage_json,error_code FROM catalog_ai_inference_ledger WHERE id=?')
    .get(reservation.reservation_id);
  assert.equal(stored.state, 'completed');
  assert.deepEqual(JSON.parse(stored.usage_json), {input_tokens: 120, output_tokens: 40});
  assert.equal(stored.error_code, null);
  const retried = await reconcileAiInferenceBudget(DB, {
    reservationId: reservation.reservation_id,
    state: 'completed',
    actualCostCents: 3
  }, {nowSeconds: JANUARY + 6});
  assert.equal(retried.reused, true);
  await assert.rejects(
    () => failAiInferenceBudget(DB, {reservationId: reservation.reservation_id}, {nowSeconds: JANUARY + 7}),
    (error) => error.code === 'ai_budget_conflict'
  );
});

test('provider failures are recorded and retain the estimate unless a known cost is supplied', async () => {
  const {sqlite, DB} = database();
  const unknownCost = await reserveAiInferenceBudget(DB, request('provider-failed'), {nowSeconds: JANUARY});
  const failed = await failAiInferenceBudget(DB, {
    reservationId: unknownCost.reservation_id,
    errorCode: 'workers_ai_timeout',
    usage: {provider_request_id: 'request-123'}
  }, {nowSeconds: JANUARY + 5});
  assert.equal(failed.state, 'failed');
  assert.equal(failed.actual_cost_microusd, 50_000);
  const knownFree = await reserveAiInferenceBudget(DB, request('provider-free'), {nowSeconds: JANUARY + 10});
  await failAiInferenceBudget(DB, {
    reservationId: knownFree.reservation_id,
    errorCode: 'rejected_before_dispatch',
    actualCostCents: 0
  }, {nowSeconds: JANUARY + 11});
  const rows = sqlite.prepare(`SELECT state,error_code,actual_cost_microusd,usage_json
    FROM catalog_ai_inference_ledger ORDER BY created_at,id`).all();
  assert.equal(rows[0].state, 'failed');
  assert.equal(rows[0].error_code, 'workers_ai_timeout');
  assert.equal(rows[0].actual_cost_microusd, 50_000);
  assert.deepEqual(JSON.parse(rows[0].usage_json), {provider_request_id: 'request-123'});
  assert.equal(rows[1].actual_cost_microusd, 0);
  const status = await getAiBudgetStatus(DB, {}, {nowSeconds: JANUARY});
  assert.equal(status.attempted_images, 2);
  assert.equal(status.reserved_cost_cents, 0);
  assert.equal(status.actual_cost_cents, 5);
});

test('completed usage without an actual cost fails closed and leaves its reservation intact', async () => {
  const {sqlite, DB} = database();
  const reservation = await reserveAiInferenceBudget(DB, request('missing-cost'), {nowSeconds: JANUARY});
  await assert.rejects(
    () => reconcileAiInferenceBudget(DB, {
      reservationId: reservation.reservation_id,
      state: 'completed'
    }, {nowSeconds: JANUARY + 5}),
    (error) => error.code === 'ai_budget_input' && error.status === 400
  );
  const row = sqlite.prepare('SELECT state,actual_cost_microusd FROM catalog_ai_inference_ledger WHERE id=?')
    .get(reservation.reservation_id);
  assert.equal(row.state, 'reserved');
  assert.equal(row.actual_cost_microusd, null);
  assert.equal((await getAiBudgetStatus(DB, {}, {nowSeconds: JANUARY})).reserved_cost_cents, 5);
});

test('interrupted reservations become conservative uncertain ledger entries after 30 minutes', async () => {
  const {sqlite, DB} = database();
  const reservation = await reserveAiInferenceBudget(DB, request('interrupted'), {nowSeconds: JANUARY});
  assert.equal(await reconcileStaleAiReservations(DB, {nowSeconds: JANUARY + (29 * 60)}), 0);
  assert.equal(await reconcileStaleAiReservations(DB, {nowSeconds: JANUARY + (30 * 60)}), 1);
  const row = sqlite.prepare('SELECT state,actual_cost_microusd,error_code,usage_json FROM catalog_ai_inference_ledger WHERE id=?')
    .get(reservation.reservation_id);
  assert.equal(row.state, 'uncertain');
  assert.equal(row.actual_cost_microusd, reservation.estimated_cost_microusd);
  assert.equal(row.error_code, 'worker_interrupted');
  assert.deepEqual(JSON.parse(row.usage_json), {reconciliation: 'stale_timeout'});
  const status = await getAiBudgetStatus(DB, {}, {nowSeconds: JANUARY + (31 * 60)});
  assert.equal(status.reserved_cost_cents, 0);
  assert.equal(status.actual_cost_cents, 5);
});

test('budgets roll over by UTC month while retaining an immutable audit ledger', async () => {
  const {sqlite, DB} = database();
  await reserveAiInferenceBudget(DB, request('january', {imageCount: 4}), {nowSeconds: JANUARY});
  await reserveAiInferenceBudget(DB, request('february', {imageCount: 1}), {nowSeconds: FEBRUARY});
  const january = await getAiBudgetStatus(DB, {}, {nowSeconds: JANUARY});
  const february = await getAiBudgetStatus(DB, {}, {nowSeconds: FEBRUARY});
  assert.equal(january.attempted_images, 4);
  assert.equal(february.attempted_images, 1);
  assert.deepEqual(
    sqlite.prepare('SELECT month_utc,attempted_images FROM catalog_ai_budget_months ORDER BY month_utc').all()
      .map((row) => ({...row})),
    [
      {month_utc: '2027-01', attempted_images: 4},
      {month_utc: '2027-02', attempted_images: 1}
    ]
  );
  assert.throws(
    () => sqlite.prepare('DELETE FROM catalog_ai_inference_ledger').run(),
    /AI_LEDGER_IMMUTABLE/
  );
});

test('an active UTC month cannot silently change its governing limits', async () => {
  const {DB} = database();
  await reserveAiInferenceBudget(DB, request('fixed-policy'), {nowSeconds: JANUARY});
  await assert.rejects(
    () => reserveAiInferenceBudget(DB, request('changed-policy'), {
      env: {AI_MONTHLY_REQUEST_CAP: 101},
      nowSeconds: JANUARY
    }),
    (error) => error.code === 'ai_budget_configuration' && error.status === 503
  );
});

test('the governance migration includes an immutable local-priest escalation ledger', () => {
  const {sqlite} = database();
  const table = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='catalog_review_escalations'").get();
  assert.match(table.sql, /local_priest/);
  const triggers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'catalog_review_escalation_%' ORDER BY name").all();
  assert.deepEqual(triggers.map(({name}) => name), [
    'catalog_review_escalation_active_policy_guard',
    'catalog_review_escalation_immutable_delete',
    'catalog_review_escalation_immutable_update',
    'catalog_review_escalation_latest_guard',
    'catalog_review_escalation_owner',
    'catalog_review_escalation_seller_clearance_guard',
    'catalog_review_escalation_sequence_guard',
    'catalog_review_escalation_terminal_guard',
    'catalog_review_escalation_unresolved_guard'
  ]);
});
