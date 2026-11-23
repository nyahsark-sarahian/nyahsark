# Stripe Tax sandbox provider

This Worker implements Nyah's Ark's internal `TAX_PROVIDER` contract for **sandbox checkout testing only**. `POST /quote` sends the exact server-calculated merchandise, shipping, and handling basis to Stripe's Tax Calculations API and returns the validated shape expected by `admin/src/commerce.js`.

It cannot be switched to production by changing one variable. It accepts only `rk_test_` or `sk_test_` credentials, requires `STRIPE_TAX_MODE=sandbox`, rejects every live-mode Stripe response, and has no live deployment configuration.

## What it validates

- The request has only the documented fields, uses USD integer cents, and contains 1–100 line items.
- Line totals exactly equal `merchandise_cents`.
- Merchandise + shipping + handling exactly equals `taxable_basis_cents`.
- The caller's opaque registration reference exactly matches the configured sandbox reference.
- Each tax-significant input is covered by an opaque SHA-256 Stripe idempotency key; the address never appears in that key.
- Merchandise, handling, and shipping each use an explicitly reviewed Stripe tax code. The adapter never guesses a category.
- Stripe returns test mode, the same address and amounts, exclusive tax, all expanded line items, an unexpired calculation, and a reconciled jurisdiction/rate breakdown.
- Component tax, breakdown tax, `tax_amount_exclusive`, and `amount_total` all reconcile exactly.

Stripe documents that `not_collecting` is ambiguous: it can mean no active registration or a non-taxable product code. This adapter rejects both `not_collecting` and `not_supported` instead of silently turning either result into a zero-tax checkout. A legitimate reconciled zero-rate result, such as `zero_rated`, remains valid.

## Required review before configuration

Someone responsible for the store's tax setup must choose these values; do not infer them from this repository:

- `STRIPE_TAX_REGISTRATION_REFERENCE`: an internal, non-secret reference that must exactly match the authenticated store setting. Matching it is only a configuration guardrail. **It is not evidence that Sarah or Nyah's Ark is registered with any tax authority, and the Worker never marks registration verified.**
- `STRIPE_TAX_MERCHANDISE_TAX_CODE`: the reviewed Stripe category for every product currently allowed through this single-code contract.
- `STRIPE_TAX_SHIPPING_TAX_CODE`: the reviewed category for seller shipping.
- `STRIPE_TAX_HANDLING_TAX_CODE`: the reviewed category for seller handling.

Handling is represented as a distinct Calculation line item because the admin contract supplies it separately. Stripe does not allow the Handling Charge code `txcd_92010004` in Calculation `line_items`, so this Worker rejects that configuration. Obtain the appropriate category from the responsible tax adviser or change the contract after review; do not substitute a code merely to make checkout pass.

The current admin contract has no per-listing tax category. Therefore, all merchandise lines use one configured merchandise code. Mixed product tax treatment requires a reviewed schema change that carries an approved category with each catalog snapshot.

## Prepare an ignored local configuration

Copy `wrangler.example.jsonc` to `payment-provider/tax-sandbox/.local/wrangler.jsonc`, then replace every `replace-with-...` value. Keep mode equal to `sandbox` and keep the pinned API version synchronized with the Stripe test account.

Create a least-privilege **restricted test key** (`rk_test_`) with only the permission needed to create Tax Calculations. An ordinary `sk_test_` key is accepted for a temporary test, but is broader than necessary. Never paste the key into source, a Wrangler file, a pull request, or chat.

```powershell
npx wrangler secret put STRIPE_TAX_SECRET_KEY --config payment-provider/tax-sandbox/.local/wrangler.jsonc
```

After a separately approved sandbox deployment, bind the service to the admin Worker:

```jsonc
"services": [
  {"binding": "TAX_PROVIDER", "service": "nyahsark-tax-sandbox"}
]
```

The authenticated store setting `tax_registration_reference` must exactly equal `STRIPE_TAX_REGISTRATION_REFERENCE`. Do not set the store's tax registration status to verified until the actual legal registration and the matching active Stripe Tax registration have been confirmed outside this adapter.

## Verification

```powershell
npm --prefix payment-provider/tax-sandbox run check
npm --prefix payment-provider/tax-sandbox test
npm --prefix payment-provider/tax-sandbox run deploy:dry
```

Tests use synthetic addresses and fake test-key strings. They never contact Stripe.

Before any live checkout design is approved, the system also needs a reviewed way to create a Stripe Tax Transaction for a completed/refunded order. A Calculation is temporary and does not, by itself, record the sale for Stripe Tax reporting.

Official Stripe references:

- [Create a Tax Calculation](https://docs.stripe.com/api/tax/calculations/create)
- [Tax Calculation object](https://docs.stripe.com/api/tax/calculations/object)
- [Standalone Tax APIs](https://docs.stripe.com/tax/standalone-tax-api)
- [Zero tax amounts and `not_collecting`](https://docs.stripe.com/tax/zero-tax)
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
