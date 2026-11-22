# Nyah's Ark revisioned catalog contract

This branch preserves the verified `art-001` through `art-009` public baseline while replacing the catalog source with a revisioned D1 model. Existing `products`, `variants`, `images`, and `private_image_objects` tables remain rollback-compatible and are never destructively rebuilt.

## Revision snapshot

Every immutable revision stores a validated JSON snapshot with this shape:

```json
{
  "title": "",
  "description": "",
  "category": null,
  "base_price_cents": null,
  "width_eighths": null,
  "height_eighths": null,
  "offered_for_sale": false,
  "requested_store_position": null,
  "inventory": {
    "quantity_changed": false,
    "intended_available_quantity": null,
    "captured_version": 0
  },
  "compliance": {
    "object_kind": "unknown",
    "blessed_or_dedicated": "unknown",
    "purported_relic": "unknown",
    "relic_class_claim": null,
    "contains_human_material": "unknown",
    "provenance_known": "unknown",
    "ecclesiastical_owner": "unknown",
    "authenticity_document": "unknown",
    "spiritual_benefit_priced": "unknown",
    "seller_attested": false
  },
  "photos": [
    {"asset_id": "uuid", "alt": "", "position": 0, "is_main": true}
  ],
  "configurations": [
    {
      "id": "uuid",
      "label": "Unframed",
      "enabled": true,
      "price_add_on_cents": 0,
      "packing_profile_id": "uuid"
    }
  ]
}
```

Drafts may be incomplete. A saved revision with photos must have one to four unique photo assets, contiguous positions, and exactly one main photo. Compliance answers are immutable revision data, not mutable profile data. Display publication requires a trimmed title and a valid main photo. Sale publication additionally requires a positive base price, positive eighth-inch dimensions, positive available inventory, an enabled configuration linked to a valid packing profile, and an effective `allow` or `human_approved` assessment under the active canonical-listing policy. A hard policy block cannot be human-approved.

## State

- `archived`: archived timestamp present.
- `draft`: active, no published revision.
- `published`: working and published revision IDs match.
- `published_changes`: working and published revision IDs differ.

Archive clears public visibility while retaining heads, revisions, assets, inventory history, and order history. Restore returns to private draft; only Publish returns it to the store.

## Admin API

- `GET /api/admin/artworks?page=N&q=&status=` uses fixed page size 10 and returns server counts/pagination.
- `POST /api/admin/artwork-drafts:batch` accepts at most ten cards. Each item has `id` or `client_id`, `expected_version`, and `draft`; each result is independent and includes field errors.
- `POST /api/admin/artworks/:id/preview` validates a supplied draft and returns private no-store preview data.
- `POST /api/admin/artworks/:id/publish` atomically switches the public revision, applies an intentional inventory adjustment with a captured inventory version, and inserts new public art into global order.
- `POST /api/admin/artworks/:id/archive` and `/restore` are recoverable.
- `POST /api/admin/artworks/:id/assist/draft-copy` returns editable copy and alt-text suggestions for the current saved revision. It does not save or publish them.
- `POST /api/admin/artworks/:id/assist/price` saves a required positive seller floor and returns advisory initial-price and listing-age guidance for the exact saved revision. Initial guidance uses verified paid store orders. Later reductions use the approved 45/90/135-day schedule from the original price, report provider-created payment sessions and ready quotes without covert visitor tracking, pause for a recent checkout, never compound, never cross the floor, and never write a price.
- `POST /api/admin/artworks/:id/compliance/assess` records a versioned policy assessment. AI may supply bounded visual observations; deterministic policy code alone decides `allow`, `review`, or `block`.
- `POST /api/admin/artworks/:id/compliance/review` appends a human review decision and note. Reviews are auditable, and only a `review` assessment can be approved.
- `POST /api/admin/artworks/:id/compliance/escalate` appends a Sarah, local-priest, or diocesan consultation record for an ambiguous `review`. Human approval requires the latest local-priest or diocesan record to be cleared; the enforced sequence cannot approve or override a deterministic hard block.
- `POST /api/admin/store-order` accepts staged moves plus the expected global order version.
- `POST /api/admin/uploads` allocates a private expiring upload. `PUT /api/admin/uploads/:id` fully decodes/reencodes supported input and atomically attaches the successful replacement through a new working revision.
- `GET /api/admin/media/:assetId/:role` serves authenticated private media with no-store.
- `GET` and `PUT /api/admin/settings` manage nonsecret store configuration.
- `GET /api/admin/orders` and `/api/admin/orders/:id` expose protected order snapshots.

All admin routes require the exact configured Supabase subject, a verified password-established session, and origin checks on mutations. Recovery/email-link sessions do not qualify.

## Public API

- `GET /api/catalog` returns published revisions only, with server sort/filter/pagination.
- `GET /api/catalog/:id` returns one current published revision.
- `GET /catalog-media/:assetId/:role` serves only media referenced by a current published revision.
- `POST /api/cart/quote` reloads catalog/configuration/inventory data and returns a server-owned expiring quote. Unresolved shipping or tax is `null`, never zero.
- `POST /api/checkout` remains disabled unless store readiness and an authorized hosted-payment provider binding are both verified.

The hosted-payment binding must create provider sessions through `/sessions`, cancel a just-created session idempotently through `/sessions/cancel`, and return a confirmed `{cancelled:true, session_id, order_id}` response. The application rechecks exact-revision compliance before and after recording the session. A database trigger prevents a session from becoming ready after a newer hold. If compliance changes during provider creation, the hosted URL is never returned; confirmed cancellation expires the order and releases its reservation, while an unconfirmed cancellation becomes `session_uncertain` for manual review. The production provider contract should use authorization-before-capture so a verified webhook can recheck compliance before capture.

Payment-state transitions are database-guarded against reservation state: authorization requires active reservations, paid requires committed reservations, failed/expired requires released reservations, and refunded requires a previously paid order with committed reservations. Conflicting verified webhooks are retained in the event ledger and routed to manual review without downgrading paid/refunded state or making committed stock sellable. A refund observed before paid places the order in manual review and prevents a later paid event from auto-committing inventory.

The storefront Worker exposes only this public surface through its service binding. It strips caller credentials and never forwards admin paths.

## Money, measurements, inventory, and order

- USD is integer cents; unset is `null`.
- Dimensions are positive integer eighths; blank is `null`.
- Inventory stores nullable physical stock and active reserved stock. Available is physical minus reserved.
- A draft quantity is only a proposal. Publication applies it as `physical = intended available + active reserved` after a version check. Publication with no quantity edit never writes stock.
- Store order is global and versioned. Filters/search never redefine positions. Stable artwork ID is the tie-breaker.

## Media limits

- Supported input: JPEG, PNG, WebP, and still-image HEIC/HEIF. HEVC image sequences and unrelated ISO Base Media formats are rejected.
- Maximum input: 5 MiB, 16 megapixels, 8192 px on either side.
- At most four photos per revision.
- The production image-processing binding must identify and fully decode the claimed format before acceptance.
- Reencoded private master, display, and thumbnail WebP derivatives are stored; raw metadata-bearing uploads are not made public.
- Failed replacement leaves the prior working revision and image attached.

## Listing Copilot boundary

Listing Copilot is disabled unless its feature flag, Workers AI binding, and model are all configured. Production keeps the flag off until ten representative calibration listings pass review and the release owner deliberately enables it. Only a sanitized display WebP and bounded saved-revision fields may reach the model. When AI Gateway is configured, request logging and caching are disabled for these calls.

Every AI action reserves capacity atomically before provider dispatch. The pilot permits at most four images per action, 100 image inferences per UTC month, and 500 cents of conservatively estimated monthly spend. Reservations and outcomes are append-only; inability to reserve or reconcile fails closed.

Model output is untrusted, schema-constrained input to the application. It may describe visible features and propose editable listing copy, but it cannot authenticate an object, establish blessing, provenance, ownership, relic status, age, material, authorship, canonical permission, civil legality, or spiritual effect. Photo-only concern can cause human review, never an automatic hard block. Policy assessments, reviews, citations, model observations, and suggestions are append-only and revision-bound.

Made-to-order status and production method are seller-controlled revision facts, not visual inferences. When a product is marked made to order, a known production method is required and Copilot output must identify the pictured item as a representative sample, preserve the saved method, and avoid stocked or ready-to-ship language. This supports draft preparation only. Checkout for made-to-order goods remains a separate sandbox gate until production-capacity, lead-time, and reservation semantics replace physical-stock assumptions; operators must not enter fictitious on-hand inventory.

See [Listing Copilot policy](./LISTING_COPILOT_POLICY.md) for the decision boundary and source basis.

