# Nyah's Ark Listing Copilot policy

Status: staging pilot. Listing Copilot is feature-disabled by default. Production remains disabled until ten representative, consented calibration listings have passed review and the release owner deliberately sets `AI_ASSIST_ENABLED=yes`.

## Purpose and limits

Listing Copilot helps a seller draft reverent and honest descriptions, visible-condition notes, and accessible image alt text; suggests an initial price and later price reductions; highlights facts that may need review; and enforces a narrow marketplace policy before a listing can be offered for sale. It is not an authenticator, appraiser, canon lawyer, civil-law adviser, or substitute for human judgment.

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

Deterministic relic and spiritual-benefit hard blocks are non-overridable. For an ambiguous item, Sarah first requests clarification from the seller, then records consultation with a local priest. If the priest is uncertain, the item remains held while the question is escalated to the diocesan chancery, judicial vicar, or another diocesan canon-law resource. A human approval is unavailable unless the latest local-priest or diocesan consultation is recorded as cleared, and that clearance still cannot override either deterministic hard block.

## AI safety and privacy

- The feature is disabled unless `AI_ASSIST_ENABLED=yes`, a Workers AI binding exists, and a valid model is configured.
- The approved pilot provider is Cloudflare Workers AI using `@cf/meta/llama-4-scout-17b-16e-instruct` with structured JSON output, low-temperature generation, and a fixed 1,200-token output ceiling.
- The model receives only a sanitized display-size WebP, never the raw HEIC, JPEG, embedded metadata, or private master.
- Seller fields are length-bounded, and image/listing text is treated as untrusted data rather than instructions.
- Made-to-order status and production method are structured seller-controlled facts. The model may describe an item as made to order, heat-pressed, or sublimated only when the corresponding saved fact supports that wording. A made-to-order product photo is treated as a representative sample, never proof of stocked or ready-to-ship inventory.
- Output must match a strict local schema and is rejected if it contains prompt-injection content, HTML, links, canonical/legal/status claims, unqualified material/age/origin/maker claims, or copy-channel classification of a relic, reliquary, or possible human material. Sensitive observations and all uncertainty prose are replaced with reviewed server-owned wording. Common visible subjects remain usable, while additional proper subject/inscription words must already occur in the seller's bounded saved draft.
- When AI Gateway is used, `collectLog` is `false` and `skipCache` is `true`. Platform billing metadata may still be recorded.
- Provider failure fails closed. The application does not convert an unavailable or malformed AI result into an approval.
- AI observations alone can only add a review hold; they cannot create the two explicit-disclosure hard blocks.
- The pilot is capped at 100 image inferences and 500 cents of estimated AI spend per UTC month, with no more than four images in one action. Capacity is reserved before model calls, recorded for audit, and denied closed if the limit cannot be verified or reserved.

## Seller control

Description, category, visible-condition, and alt-text results are suggestions written in a reverent, honest, plain, and restrained tone. Applying them changes only the unsaved form. The seller must review and deliberately save the changes; Copilot never saves or publishes a listing.

For products produced after purchase, the seller must explicitly mark the listing as made to order and choose the actual production method. Suggested copy should clearly identify the pictured item as a representative sample and may note that placement or color can vary, without inventing materials, manufacturer claims, durability, or available stock.

Price guidance is also advisory. A seller may override an initial range or a later reduction suggestion. Initial ranges require at least three verified, comparable paid sales. Each item must have a positive seller floor that accounts for costs, packing, seller-paid fees, and desired profit. The system never changes a price automatically, never recommends less than the floor, and must not suggest a reduction while compliance is unresolved or a recent checkout is active.

Later reductions follow a non-compounding schedule calculated from the original listing price: 5% at 45 days, 10% at 90 days, and 15% at 135 days. There is a 30-day cooldown after a saved price change. A skipped or overridden recommendation does not cause later percentages to compound, and the 15% schedule cap is not exceeded. The result identifies limitations in marketplace evidence and returns no recommendation when required facts are missing.

## Enablement checklist

Before enabling Listing Copilot:

1. Confirm the two non-overridable hard-block rules, the seller questions, the notices, and the priest/diocesan escalation procedure with Sarah and the designated local priest.
2. Configure the Workers AI model and optional private AI Gateway; confirm request logging and caching remain disabled.
3. Run a review-only calibration pilot on ten representative, consented listings and measure false positives, false negatives, copy quality, price usefulness, and seller comprehension.
4. Verify the monthly inference and spend reservations, four-image action limit, fixed output ceiling, fail-closed behavior, and audit records.
5. Confirm appeal ownership, response targets, audit access, retention, and incident procedures.
6. Deliberately set `AI_ASSIST_ENABLED=yes` only after the ten calibration cases pass. A deployment or configuration merge by itself must not activate production AI.
7. Separately resolve the store's shipping origin, packing profiles, shipping services, supported destinations, fulfillment methods, handling rules, tax registration, and payment connection before enabling checkout. Listing Copilot does not supply those business facts or provider accounts.

## Release operations

Calibration runs in a separate Worker and D1 database with `CALIBRATION_MODE=yes` and the tracked publication-blocking database triggers in `admin/calibration/publication-guards.sql`. Startup verifies both triggers, skips legacy baseline publication, and fails closed if the guard installation is incomplete; the publish route is also disabled in application code. Its AI ledger enforces the same 100-image and 500-cent limits as production, but those limits are per database rather than account-global. After calibration signoff, disable or remove the calibration Worker before enabling production so the stated pilot limit represents the only active Copilot environment. An account-level Cloudflare budget alert is an additional control, not a replacement for the application ledger.

The live database predates the Wrangler migration journal and is bootstrapped idempotently by the Worker at runtime. Do not run `wrangler d1 migrations apply` against production until the existing schema and journal have been reconciled; early migrations contain non-idempotent `CREATE` statements. For this release, deploy code and let the authenticated Worker bootstrap the additive governance schema. Rollback is a code or `AI_ASSIST_ENABLED=no` deployment; the additive governance tables and fail-closed triggers remain in place.
