# The API on Cloudflare Workers

The trusted API runs as a Cloudflare Worker instead of a Cloud Function, because
Firebase Cloud Functions cannot be deployed on the Spark plan and this project
must stay on free tiers. Everything else stays on Firebase.

| Concern | Service | Plan |
| --- | --- | --- |
| Sign-in, ID tokens, device identity | Firebase Authentication | Spark |
| Request/device state, realtime updates | Cloud Firestore | Spark |
| Employee web app | Firebase Hosting | Spark |
| Push to the shared phone | Firebase Cloud Messaging | free |
| Trusted API, FCM sender, expiry sweep | Cloudflare Workers | free |

Cloudflare's free plan includes 100,000 Worker requests per day and Cron
Triggers. Exceeding the limit fails requests rather than generating a bill.

For provisioning Google credentials and installing the Worker secrets, see
[Zero-cost Cloudflare Worker infrastructure](cloudflare-zero-cost.md). This
document covers what the Worker is, how it is configured, and how to run it.

## What replaced what

| Cloud Functions | Worker |
| --- | --- |
| `onRequest` Express app | `fetch` handler in `worker/src/index.ts` |
| `firebase-admin` Firestore SDK | Firestore REST in `worker/src/firestore.ts` |
| `admin.auth().verifyIdToken` | Local RS256 verification in `worker/src/idToken.ts` |
| `admin.messaging().send` | FCM HTTP v1 in `worker/src/google.ts` |
| Cloud Tasks expiry queue | one-minute Cron Trigger |
| `onSchedule` sweep | the same Cron Trigger |
| Firestore TTL policies | `purgeExpiredDocuments`, driven by `deleteAt` |

The API contract, request state machine, Firestore documents and security rules
are unchanged, so the web and Android clients only needed a new base URL.

Two consequences of leaving the Admin SDK behind are worth knowing:

- **Server timestamps.** `FieldValue.serverTimestamp()` has no REST equivalent
  in a plain commit, so the Worker stamps times from its own clock. Cloudflare
  keeps Worker clocks NTP-synchronised; expiry decisions are made from the
  request document, which is written by the same clock.
- **Field deletion.** `FieldValue.delete()` becomes an update mask that lists a
  field without supplying a value. `FirestoreRest.mergeWrite` does this, which
  is how `devices/{id}` is kept to the five keys the Firestore rules allow
  employees to read.

`functions/` still holds the Cloud Functions implementation. It is not deployed;
it remains the ready-made path if this project ever moves to Blaze, and it hosts
the Firestore rules test suite (`npm run test:rules`).

## Configuration

Non-secret values live in `worker/wrangler.toml` per environment:
`APP_ENVIRONMENT`, `FIREBASE_PROJECT_ID`, `ALLOWED_WORKSPACE_DOMAIN`,
`TARGET_DEVICE_ID`.

Two values are secrets and are never committed:

| Secret | Purpose |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Signs Google API calls: Firestore, FCM, and the device custom token |
| `DEVICE_ENROLLMENT_CODE` | The one-time code the shared phone types in to enrol |

## Deploying

Once per environment, after the secrets are installed:

```bash
npm run deploy:worker:dev          # prints the workers.dev URL
node scripts/set-worker-url.mjs dev https://arnifi-phone-bell-dev.<subdomain>.workers.dev
npm run deploy:firebase:dev        # builds the web app and deploys rules + hosting
```

`set-worker-url.mjs` writes the base URL into `web/.env.dev.local` and
`android/firebase.properties`, both of which are gitignored. The URL is stable
across later deploys, so subsequent releases are just:

```bash
npm run deploy:dev                 # worker, then rules and hosting
```

Replace `dev` with `prod` for production. Production authorizes only the
Firebase Hosting domains and `phone.arnifi.com`; development also allows
`localhost`.

Verify a deployment with:

```bash
curl -s https://arnifi-phone-bell-dev.<subdomain>.workers.dev/api/v1/health
```

Expect `{"success":true,"service":"arnifi-phone-bell","environment":"dev"}`.

## Local development

```bash
cp worker/.dev.vars.example worker/.dev.vars   # then fill in the two secrets
npm run dev:worker                             # http://127.0.0.1:8787
npm run dev:web                                # proxies /api to the worker
```

`npm run dev:worker` talks to the real dev Firebase project, so a local run
writes real dev data.

## Operations

- Live logs: `wrangler tail --env dev`. The Worker logs structured JSON and
  never logs tokens, push tokens or enrollment codes.
- The cron runs every minute: it expires overdue requests, frees the shared
  phone, and deletes documents past their `deleteAt` retention date
  (idempotency keys after 1 day, events after 30, requests after 90).
- Rolling back: `wrangler rollback --env dev`.
- Rotating the service-account key: rerun `install-secrets` with
  `--retire-old-keys`, as described in the provisioning runbook.
