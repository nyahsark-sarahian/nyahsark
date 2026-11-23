# Sandbox shipping quote provider

This Worker implements Nyah's Ark's internal `SHIPPING_PROVIDER` `POST /quote` contract for checkout testing. It is deliberately **not a carrier integration** and cannot be enabled for live shipping by changing one setting.

The configured test rate for each service is:

```text
base_cents + (per_parcel_cents × parcel_count) + (per_item_cents × item_count)
```

All values are integer US cents. In `separate_packages` mode each ordered unit is one sandbox parcel. `single_package` is accepted only for exactly one unit, preventing an accidental multi-item underquote. The service validates origin, destination, dimensions, weight, units, package quantities, service code, currency, and packing strategy. Its opaque reference hashes the normalized quote inputs without returning an address.

## Local verification

```powershell
npm --prefix payment-provider/shipping-sandbox test
npm --prefix payment-provider/shipping-sandbox run check
npm --prefix payment-provider/shipping-sandbox run deploy:dry
npm run test:shipping
```

## Prepare a sandbox configuration

Copy `wrangler.example.jsonc` to the ignored path `payment-provider/shipping-sandbox/.local/wrangler.jsonc`. Because the copy is one directory deeper, change its `main` to `../src/index.js` and its `$schema` path to `../../../node_modules/wrangler/config-schema.json`. Keep `SHIPPING_MODE` equal to `sandbox`. Replace the example rate map only with explicitly approved test values. This provider needs no secret.

After deployment, bind it to the admin Worker:

```jsonc
"services": [
  {"binding": "SHIPPING_PROVIDER", "service": "nyahsark-shipping-sandbox"}
]
```

Configure the authenticated store's sandbox shipping service with a `provider_service_code` that exactly matches one key in `SANDBOX_SERVICE_RATES_JSON`. These are test totals only. Production launch requires a separately reviewed carrier or fulfillment integration plus Sarah's actual packages, origin, destinations, services, and handling policy.
