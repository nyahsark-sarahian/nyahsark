# Nyah's Ark Listing Copilot policy

Status: implementation draft. Listing Copilot is feature-disabled by default and must not be enabled for sellers until the policy and seller wording have been reviewed by a qualified canon lawyer or the appropriate diocesan authority.

## Purpose and limits

Listing Copilot helps a seller draft clearer descriptions and image alt text, highlights facts that may need review, and enforces a narrow marketplace policy before a listing can be offered for sale. It is not an authenticator, appraiser, canon lawyer, civil-law adviser, or substitute for human judgment.

The system must never present its result as a determination that an item is “canonically legal” or “illegal.” Its result is a **Nyah's Ark canonical-listing policy decision informed by the cited Catholic sources**. Civil law, title, export controls, human-remains rules, consumer protection, and payment-provider rules are separate checks outside this policy.

## Source basis

The first policy version, `canonical-listing-v1`, is based on these official sources:

- [Code of Canon Law, Canon 1190 §1](https://www.vatican.va/archive/cod-iuris-canonici/eng/documents/cic_lib4-cann1166-1190_en.html): sacred relics may not be sold.
- [Relics in the Church: Authenticity and Conservation, Article 25](https://www.vatican.va/roman_curia/congregations/csaints/documents/rc_con_csaints_doc_20171208_istruzione-reliquie_en.html): commerce in and barter of relics are prohibited.
- [Code of Canon Law, Canon 1171](https://www.vatican.va/archive/cod-iuris-canonici/eng/documents/cic_lib4-cann1166-1190_en.html): sacred objects designated for divine worship by dedication or blessing must be treated reverently and not used for profane or inappropriate purposes.
- [Catechism of the Catholic Church, paragraph 2121](https://www.vatican.va/content/catechism/en/part_three/section_two/chapter_one/article_1/iii_you_shall_have_no_other_gods_before_me.html): simony is the buying or selling of spiritual things.

Canon 1171 is not implemented as a blanket ban on every sacramental or devotional object. A seller disclosure that an item is blessed, dedicated, sacred, ecclesiastically owned, or accompanied by an authenticity document requires human review under this marketplace policy.

## Decision boundary

The model only records bounded visual observations and drafts editable copy. Deterministic application code evaluates the exact saved title, description, category, seller disclosures, and any accepted observations. Saved copy cannot contradict the structured disclosures and still receive an allowance.

| Evidence | Policy result | Explanation |
| --- | --- | --- |
| The seller's saved copy or disclosures explicitly identify the offered item as a relic, say it is purported to be a relic, or supply a relic-class claim | `block` | A relic may not be sold or bartered under Canon 1190 §1 and Article 25. |
| The seller's saved copy or disclosures explicitly price a blessing, grace, spiritual effect, or other spiritual benefit | `block` | A spiritual thing or benefit may not be sold. |
| A photograph merely appears to show a reliquary, possible human material, relic wording, or an authenticity document | `review` | An image cannot establish relic status, human material, authenticity, provenance, ownership, or permission. |
| Answers are unknown, the seller has not attested to them, or a sacred/ownership concern is disclosed | `review` | A human requests clarification or records a decision. |
| Required disclosures are attested and no policy condition is triggered | `allow` | This only means the supplied facts do not trigger this policy; it is not authentication or legal approval. |
| The listing is display-only | `allow` for display | The assessment does not authorize sale or barter. |

A `block` is not approvable through the human-review interface. A seller who believes an item was misidentified may correct the facts in a new immutable revision and request a fresh assessment. A `review` may be approved, blocked, or returned for information with a required note. Every assessment and review is revision-bound and append-only.

## AI safety and privacy

- The feature is disabled unless `AI_ASSIST_ENABLED=yes`, a Workers AI binding exists, and a valid model is configured.
- The model receives only a sanitized display-size WebP, never the raw HEIC, JPEG, embedded metadata, or private master.
- Seller fields are length-bounded, and image/listing text is treated as untrusted data rather than instructions.
- Output must match a strict local schema and is rejected if it contains prompt-injection content, HTML, links, canonical/legal/status claims, unqualified material/age/origin/maker claims, or copy-channel classification of a relic, reliquary, or possible human material. Sensitive observations and all uncertainty prose are replaced with reviewed server-owned wording. Common visible subjects remain usable, while additional proper subject/inscription words must already occur in the seller's bounded saved draft.
- When AI Gateway is used, `collectLog` is `false` and `skipCache` is `true`. Platform billing metadata may still be recorded.
- Provider failure fails closed. The application does not convert an unavailable or malformed AI result into an approval.
- AI observations alone can only add a review hold; they cannot create the two explicit-disclosure hard blocks.

## Seller control

Description, category, visible-condition, and alt-text results are suggestions. Applying them changes only the unsaved form. The seller must review and deliberately save the changes; Copilot never saves or publishes a listing.

Price guidance is also advisory. A seller may override an initial range or a later markdown suggestion. The system never changes a price automatically and must not suggest a markdown while compliance is unresolved. Initial ranges use only recent, verified paid Nyah's Ark order lines that are semantically comparable. Listing-age guidance counts only distinct checkouts that successfully created a provider payment session as qualified demand; ready quote requests remain a weaker, separately reported activity signal. It identifies that inquiries are not tracked, respects a seller-supplied floor, and returns no recommendation when evidence is insufficient.

## Enablement checklist

Before enabling Listing Copilot:

1. Obtain qualified canonical-policy review of this document, the seller questions, the notices, and the two hard-block rules.
2. Configure the model and optional private AI Gateway; confirm request logging and caching remain disabled.
3. Run a review-only pilot on representative, consented fixtures and measure false positives, false negatives, and seller comprehension.
4. Confirm appeal ownership, response targets, audit access, retention, and incident procedures.
5. Separately resolve the store's shipping origin, packing profiles, shipping services, supported destinations, fulfillment methods, handling rules, tax registration, and payment connection before enabling checkout. Listing Copilot does not supply those business facts or provider accounts.
