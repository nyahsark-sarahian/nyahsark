# Nyah's Ark release notes — 2026-11-21

Status: local implementation complete; not published.

- Reworked the public and administrator palettes around adult blush, pink, plum, and restrained warm-red tones. Visible Nyah's Ark wordmarks use individually colored letters, and primary controls use the matching gradient with accessible fallbacks.
- Added guarded still-image HEIC/HEIF intake. Accepted uploads are fully decoded, size-checked, stripped of original metadata, and stored only as private WebP derivatives; sequences and unrelated ISO media remain rejected.
- Added the Sarah-only Listing Copilot interface for editable descriptions, visible-condition wording, and photo alt text. It analyzes sanitized display WebPs only, treats model output as untrusted, and never saves or publishes suggestions automatically.
- Added immutable seller disclosures, deterministic canonical-listing policy, official-source citations, append-only assessments/reviews, and a human appeal trail. The assessment reads the exact saved title, description, category, and disclosures so contradictory copy cannot bypass it. Explicit relic sales and priced spiritual benefits are hard-blocked; photo-only concerns require review and cannot create a hard block.
- Added fail-closed enforcement at publication, public sale availability, quote, checkout, reservation, hosted-payment session readiness, and payment transitions. A newer policy hold immediately withdraws sale availability without erasing the display listing. A hold racing with hosted-session creation withholds the URL and requires confirmed provider cancellation or manual review. Database state guards keep payment, reservation, and inventory states consistent under concurrent or out-of-order verified webhooks.
- Added advisory pricing guidance from recent verified paid store sales, provider-created payment sessions, and separately labeled ready-quote activity. Sarah may set a floor, override suggestions, or ignore them; the system never changes a price automatically.
- Kept Listing Copilot feature-disabled by default pending model configuration, representative-fixture calibration, and qualified canonical-policy review.
- Kept checkout disabled until the real shipping, fulfillment, handling, tax, and payment-connection facts are supplied and verified.
