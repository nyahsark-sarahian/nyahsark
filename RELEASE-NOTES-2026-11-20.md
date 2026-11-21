# Nyah's Ark release — 2026-11-20

## Components

- Added the revisioned D1 catalog with separate private working and public published heads, optimistic concurrency, inventory reservations, global store order, and audit events.
- Reconciled the verified `art-001` through `art-009` public baseline (nine artworks and twelve legacy public photos) without publishing the imported private drafts.
- Replaced the static public catalog path with a narrow Worker service binding to published data and added dynamic gallery, artwork, cart, quote, and checkout-status interfaces.
- Added the protected, single-page administrator workspace for paginated artwork editing, independent draft saves, authenticated preview, explicit publication, archive/restore, store order, settings, and orders.
- Added private JPEG/PNG/WebP processing with content and dimension checks, metadata-stripping WebP derivatives, a four-photo limit, private draft delivery, and publication-gated public delivery. HEIC/HEIF is intentionally unsupported.
- Added provider-neutral shipping, tax, quote, reservation, order, webhook, and hosted-checkout interfaces. Payment initiation remains disabled until an owner-authorized provider and required business configuration are supplied and sandbox-verified.

## Additive migrations

- `0001_legacy_inventory.sql`
- `0002_private_image_objects.sql`
- `0003_revisioned_catalog.sql`
- `0004_settings_commands.sql`

The runtime bootstrap is idempotent and verifies/repairs required schema objects. Existing legacy records and public assets are retained.

## Test and production evidence

- Local/integration: `npm test` — 48/48 passing.
- Static checks: administrator syntax check, public Wrangler dry-run, administrator Wrangler dry-run, and `git diff --check` passed (one harmless line-ending notice only).
- Isolated coverage includes 21-item pagination (10/10/1), independent batch saves and retry idempotency, revision isolation, exact money/eighth-inch handling, four-photo failure behavior, global position 21-to-1 ordering, shared-stock reservation concurrency, quote invalidation, and webhook lifecycle handling.
- Production administrator: password/subject verification passed; the protected catalog returned the nine reconciled baseline artworks; Cloudflare Images qualification produced master/display/thumbnail WebP outputs; uploads are enabled.
- Production private smoke: created and saved a private draft, uploaded a real JPEG, confirmed the saved photo after a fresh sign-in, then recoverably archived the draft without ever publishing it.
- Provider sandbox: not run because no owner-authorized payment, tax, or shipping provider configuration is present.
- Public deployment verification: pending the production build from this release commit.

## Deployment and rollback

- Administrator Worker: `nyahsark-admin-staging`, active version `439cfae6-b838-47fc-a378-6f32edb7069d`.
- Administrator rollback version: `ad155d13-be0e-4211-a5df-d7d8443a7636`.
- Public Worker: `nyahsark`; pre-release rollback version `1d152705-8b1c-4a27-b93b-ab8cc84ab036`, source commit `12c036692092bbcbcd2bf927c9e4624d9048f1ff`.
- Public release version/source/build: pending post-build verification.

Administrator rollback is a 100% traffic deployment of the recorded prior version. Public rollback is either a 100% deployment of the recorded prior Worker version or a revert of `main` to the recorded source commit. Additive D1 tables and later data must be retained; rollback must not run destructive migrations.

## Remaining blockers

Catalog editing, photo uploads, display-only publication, browsing, and reference-only cart operation do not require a commerce provider. Live quoting/payment remains disabled until Sarah or Mark supplies verified shipping origin/destinations/services, packing profiles and strategy, handling policy, sales-tax registration/provider configuration, and an authorized hosted-payment provider with sandbox credentials.
