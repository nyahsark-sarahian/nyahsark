import test from 'node:test';
import assert from 'node:assert/strict';
import {deterministicPolicyPreflight, dispatchDraftCopyIfAllowed} from '../src/ai-policy-gate.js';

const disclosures = (overrides = {}) => ({
  object_kind: 'ordinary_devotional',
  blessed_or_dedicated: 'no',
  purported_relic: 'no',
  relic_class_claim: null,
  contains_human_material: 'no',
  provenance_known: 'yes',
  ecclesiastical_owner: 'no',
  authenticity_document: 'no',
  spiritual_benefit_priced: 'no',
  seller_attested: true,
  ...overrides
});

const draft = (overrides = {}) => ({
  title: 'Synthetic calibration object',
  description: 'A staging-only product record.',
  category: 'Calibration',
  offered_for_sale: true,
  compliance: disclosures(),
  ...overrides
});

test('explicit relic-sale facts block draft-copy before a failing AI binding can run', async () => {
  let calls = 0;
  const blocked = draft({compliance: disclosures({object_kind: 'relic', purported_relic: 'yes', relic_class_claim: 'first-class'})});
  await assert.rejects(
    () => dispatchDraftCopyIfAllowed(blocked, async () => {
      calls += 1;
      throw new Error('Workers AI binding should not have been called');
    }),
    (error) => error?.status === 409 && error?.details?.code === 'COMPLIANCE_BLOCKED'
  );
  assert.equal(calls, 0);
  assert.equal(deterministicPolicyPreflight(blocked).decision, 'block');
});

test('priced spiritual-benefit facts block draft-copy before dispatch while allowed products may dispatch', async () => {
  let calls = 0;
  const blocked = draft({compliance: disclosures({spiritual_benefit_priced: 'yes'})});
  await assert.rejects(
    () => dispatchDraftCopyIfAllowed(blocked, async () => {
      calls += 1;
      throw new Error('Workers AI binding should not have been called');
    }),
    (error) => error?.details?.code === 'COMPLIANCE_BLOCKED'
  );
  assert.equal(calls, 0);

  const result = await dispatchDraftCopyIfAllowed(draft(), async () => {
    calls += 1;
    return {ok: true};
  });
  assert.deepEqual(result, {ok: true});
  assert.equal(calls, 1);
});
