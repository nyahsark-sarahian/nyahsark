import {evaluatePolicy} from './compliance.js';
import {HttpError} from './http.js';

function savedListingCopy(draft) {
  const value = draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
  return {
    title: typeof value.title === 'string' ? value.title : '',
    description: typeof value.description === 'string' ? value.description : '',
    category: typeof value.category === 'string' ? value.category : ''
  };
}

export function deterministicPolicyPreflight(draft) {
  const value = draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
  return evaluatePolicy({
    offeredForSale: value.offered_for_sale === true,
    disclosures: value.compliance,
    observations: [],
    listingCopy: savedListingCopy(value)
  });
}

function blockedCopyError(policy) {
  const explanation = Array.isArray(policy?.messages)
    ? policy.messages.find((message) => typeof message === 'string' && message.trim())
    : null;
  return new HttpError(
    409,
    (explanation || 'This listing is blocked by the canonical marketplace policy.').slice(0, 600),
    {
      code: 'COMPLIANCE_BLOCKED',
      policy_version: policy?.policy_version,
      reason_codes: Array.isArray(policy?.reason_codes) ? policy.reason_codes.slice(0, 12) : []
    }
  );
}

export async function dispatchDraftCopyIfAllowed(draft, dispatch) {
  const policy = deterministicPolicyPreflight(draft);
  if (policy.decision === 'block') throw blockedCopyError(policy);
  if (typeof dispatch !== 'function') throw new TypeError('AI dispatch is required');
  return dispatch();
}
