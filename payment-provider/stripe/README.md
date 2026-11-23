# Stripe sandbox payment provider

This Worker implements Nyah's Ark's internal `PAYMENT_PROVIDER` service contract for a **Stripe test-mode pilot only**:

- `POST /sessions` creates one Stripe-hosted Checkout Session for the exact server-calculated order total.
- `POST /sessions/cancel` retrieves the Session, verifies its order metadata, and expires it idempotently when it is still open.
- `POST /webhooks/verify` verifies the raw `Stripe-Signature` HMAC and normalizes only supported payment events.

It deliberately rejects live-mode requests and `sk_live_` keys. It never calculates prices, shipping, handling, or tax; the admin Worker must complete and freeze those values first. It also does not connect Relay Financial. Relay is configured as the Stripe account's payout bank in Stripe, outside the website code.

## Security properties

- Stripe's API origin and hosted Checkout origin are fixed in code.
- The adapter sends the application's idempotency key as Stripe's `Idempotency-Key`.
- Returned Session amount, currency, mode, merchant, order metadata, and HTTPS host are revalidated.
- Cancellation is confirmed against Stripe before the application releases inventory.
- Webhook verification uses the unmodified request bytes, a five-minute timestamp tolerance, and the endpoint-specific `whsec_` secret.
- Partial refunds carry the verified refunded amount into a durable payment event and manual-review audit record instead of being represented as full refunds. A pre-settlement order becomes `session_uncertain`; an already-paid order remains paid while the refund is reconciled so its completed payment history is not rewritten.
- No request body, API key, webhook secret, or customer payment data is logged.

The design follows Stripe's current Checkout and webhook guidance: create Sessions on the server, redirect only to the returned hosted URL, fulfill from verified events rather than the return page, and expire only open Sessions.

## Prepare the ignored deployment configuration

Copy `wrangler.example.jsonc` to `wrangler.local.jsonc` (the repository ignores `.local/`; placing it at `payment-provider/stripe/.local/wrangler.jsonc` is preferred) and set:

- `STRIPE_MERCHANT_REFERENCE` to a stable test-account reference, preferably the Stripe account ID shown in the test Dashboard.
- `STRIPE_API_VERSION` to the pinned API version used by that test account.
- `STRIPE_RETURN_ORIGIN` to `https://nyahsark.com`.

Add secrets interactively; never put either value in Git or chat:

```powershell
npx wrangler secret put STRIPE_SECRET_KEY --config payment-provider/stripe/.local/wrangler.jsonc
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config payment-provider/stripe/.local/wrangler.jsonc
```

`STRIPE_SECRET_KEY` should be a least-privilege restricted test key beginning with `rk_test_`; an ordinary `sk_test_` sandbox key is also accepted. Live keys are rejected. `STRIPE_WEBHOOK_SECRET` must be the signing secret beginning with `whsec_` for the test webhook endpoint.

## Stripe test webhook

In Stripe **test mode**, create a webhook endpoint at:

```text
https://thearkadmin.nyahsark.com/api/payment/webhook
```

Subscribe only to the event types required by this sandbox configuration:

- `checkout.session.completed`
- `checkout.session.expired`
- `charge.refunded`

The sandbox explicitly permits card payments only and uses automatic capture. This avoids treating a retryable PaymentIntent failure as a terminal order failure and avoids unpaid delayed-method completions. Authorization-before-capture or delayed methods for a future live release require a separately reviewed payment-state contract; this sandbox Worker cannot be made live by changing one variable.

## Bind the provider to the admin Worker

After the sandbox Worker is deployed, add this service binding to the admin Worker release configuration:

```jsonc
"services": [
  {"binding": "PAYMENT_PROVIDER", "service": "nyahsark-stripe-sandbox"}
]
```

Set the admin Worker's plain variable `PAYMENT_PROVIDER_NAME` to `stripe`. In the authenticated store settings, set payment mode/status to `sandbox` and use exactly the same merchant reference. Checkout still remains unavailable until shipping origin, packing profiles, shipping services, destinations, fulfillment, handling, tax, and at least one approved sale listing are complete.

## Verification

```powershell
npm test
npm --prefix payment-provider/stripe run check
npm --prefix payment-provider/stripe run deploy:dry
```

Before any live launch, complete an end-to-end Stripe test-card checkout and confirm the verified webhook—not the browser redirect—moves the order to paid.

Official references:

- [Create a Checkout Session](https://docs.stripe.com/api/checkout/sessions/create)
- [Expire a Checkout Session](https://docs.stripe.com/api/checkout/sessions/expire)
- [Verify webhook signatures](https://docs.stripe.com/events/manage-webhook-endpoints#signature-errors)
- [Fulfill Checkout orders from events](https://docs.stripe.com/payments/existing-customers?platform=web&ui=stripe-hosted)
