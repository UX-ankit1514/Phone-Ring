# Firebase dev and production setup

## 1. Create projects

Create `arnifi-phone-bell-dev` and `arnifi-phone-bell-prod` and select `asia-south1` when creating the Firestore database. The Firestore location cannot be changed later.

Enable Authentication, Firestore, Firebase Cloud Messaging and Firebase Hosting. Both projects stay on the free Spark plan: no billing account is linked, and no service that requires one is used.

## 2. Configure authentication

Enable the Google provider and add only the required Firebase domains plus `phone.arnifi.com` to authorized domains. The backend independently requires a verified email ending in `@arnifi.com`.

Create one Firebase web app per environment and copy its client values into the deployment environment using `web/.env.example` as the schema.

## 3. Configure the API

The API runs on Cloudflare Workers, not Cloud Functions. Its non-secret settings
live in `worker/wrangler.toml`; its service account and one-time enrollment code
are installed by the provisioner in
[Zero-cost Cloudflare infrastructure](cloudflare-zero-cost.md).

Use a randomly generated enrollment code of at least 24 characters, transfer it
through the approved password manager, and rotate it after the Samsung enrolls.

## 4. Seed safe configuration

Create `config/sharedPhone` with:

```json
{
  "targetDeviceId": "uae-phone-01",
  "ringDurationSeconds": 10,
  "requestTimeoutSeconds": 60,
  "targetterCooldownSeconds": 20,
  "allowConcurrentRequests": false,
  "vibrationEnabled": true,
  "ttsEnabled": false,
  "deliveryTimeoutSeconds": 15
}
```

The backend applies these defaults if the document is temporarily absent and clamps unsafe values.

## 5. Deploy dev

```bash
npx firebase login
npm run deploy:worker:dev
node scripts/set-worker-url.mjs dev https://arnifi-phone-bell-dev.<subdomain>.workers.dev
npm run deploy:firebase:dev
```

After endpoint tests, attach `phone.arnifi.com` to production Hosting and complete Firebase's DNS verification. Do not point employee traffic at production until the signed APK has passed the dev-project physical-device matrix.

## 6. Data retention

Firestore TTL policies require a billing account, so the Worker's one-minute
cron deletes documents past their `deleteAt` stamp instead:

- `idempotencyKeys.deleteAt` — 1 day
- `requestEvents.deleteAt` — 30 days
- `phoneRequests.deleteAt` — 90 days

Like TTL, this removal is asynchronous and must not be used for request
expiration or lock release; those are handled by the request state machine.

