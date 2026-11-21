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

Drafts may be incomplete. A saved revision with photos must have one to four unique photo assets, contiguous positions, and exactly one main photo. Display publication requires a trimmed title and a valid main photo. Sale publication additionally requires a positive base price, positive eighth-inch dimensions, positive available inventory, and an enabled configuration linked to a valid packing profile.

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

The storefront Worker exposes only this public surface through its service binding. It strips caller credentials and never forwards admin paths.

## Money, measurements, inventory, and order

- USD is integer cents; unset is `null`.
- Dimensions are positive integer eighths; blank is `null`.
- Inventory stores nullable physical stock and active reserved stock. Available is physical minus reserved.
- A draft quantity is only a proposal. Publication applies it as `physical = intended available + active reserved` after a version check. Publication with no quantity edit never writes stock.
- Store order is global and versioned. Filters/search never redefine positions. Stable artwork ID is the tie-breaker.

## Media limits

- Supported input: JPEG, PNG, WebP.
- Maximum input: 5 MiB, 16 megapixels, 8192 px on either side.
- At most four photos per revision.
- Reencoded private master and display derivatives are stored; raw metadata-bearing uploads are not made public.
- Failed replacement leaves the prior working revision and image attached.

