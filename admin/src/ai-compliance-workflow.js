import {AiBudgetError, failAiInferenceBudget, reserveAiInferenceBudget} from './ai-budget.js';
import {createPendingAssessment, POLICY_VERSION} from './compliance.js';
import {HttpError} from './http.js';

function budgetHttpError(error) {
  return error instanceof AiBudgetError
    ? new HttpError(error.status, error.message, {code: error.code})
    : error;
}

export async function reserveComplianceAssistance(env, artwork, actor, {imageCount, actionId} = {}) {
  let reservation;
  try {
    reservation = await reserveAiInferenceBudget(env.DB, {
      actionId,
      imageCount,
      modelId: env.AI_ASSIST_MODEL,
      actor
    }, {env});
  } catch (error) {
    throw budgetHttpError(error);
  }
  // Claim the request identifier before inserting a pending assessment. A
  // retry must never supersede a completed result with a new pending/error row.
  if (reservation.reused) {
    throw new HttpError(409, 'This Listing Copilot action was already submitted; start a new action to try again', {code: 'AI_ACTION_REPLAY'});
  }
  try {
    await createPendingAssessment(env.DB, {
      artwork_id: artwork.id,
      revision_id: artwork.working_revision_id,
      policy_version: POLICY_VERSION,
      source: 'ai_assisted'
    }, actor);
  } catch (error) {
    try {
      await failAiInferenceBudget(env.DB, {
        reservationId: reservation.reservation_id,
        errorCode: 'pending_assessment_failed'
      });
    } catch (reconciliationError) {
      throw budgetHttpError(reconciliationError);
    }
    throw error;
  }
  return reservation;
}
