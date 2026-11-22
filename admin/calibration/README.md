# Isolated Listing Copilot calibration

Calibration must use its own Worker and D1 database. Copy `wrangler.example.jsonc` to an ignored local configuration and replace only the placeholders. Keep `CALIBRATION_MODE=yes`.

After applying migrations to the isolated database, install the tracked publication guards before deploying:

```powershell
npx wrangler d1 execute nyahsark-admin-ai-calibration --remote --config admin/.local/calibration.json --file admin/calibration/publication-guards.sql
npx wrangler deploy --config admin/.local/calibration.json --domain ai-calibration.nyahsark.com
```

During protected API initialization, calibration mode verifies both database triggers and fails closed if either is missing. It also skips legacy baseline publication and rejects the publish route in application code. The database triggers independently reject publish-command inserts and non-null published heads.

After signoff, set `AI_ASSIST_ENABLED=no` in the ignored calibration configuration and redeploy. Retain the isolated D1 database as an audit record; never copy calibration inventory into production.
