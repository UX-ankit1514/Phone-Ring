# Arnifi Shared UAE Phone Bell

An internal request system for Arnifi's shared Samsung UAE calling phone.

```text
Employee web app -> Cloudflare Worker API -> FCM -> Samsung APK
                                            |
                       Firestore request state -> realtime web status
```

The non-negotiable design rule is that FCM wakes the Samsung and triggers the alert. Firestore is the request-state source of truth; the Android app never polls Firestore to decide when to ring.

## Workspace

- `web/` — React + TypeScript employee experience.
- `worker/` — the deployed Cloudflare Worker: REST API, trusted request state machine, FCM sender and expiry cron.
- `functions/` — the equivalent Firebase Functions v2 implementation. Not deployed; it needs the Blaze plan. It also hosts the Firestore rules tests.
- `packages/contracts/` — shared web/backend wire contracts.
- `android/` — native Kotlin/Jetpack Compose target APK.
- `firebase/` — Firestore rules and indexes.
- `scripts/` — Google provisioning and client configuration helpers.
- `docs/` — provisioning, testing, release, and troubleshooting runbooks.

## Local setup

Requirements:

- Node.js 22 and npm.
- JDK 17 and Android SDK 36 for APK builds.
- JDK 21 for the current Firebase Firestore emulator CLI.
- A free Cloudflare account for the Worker API. Both Firebase projects stay on the free Spark plan; nothing here needs a billing account.

```bash
nvm use
npm install
cp web/.env.example web/.env.local
npm run build
npm test
npm run test:rules
```

Run the web UI against the local API:

```bash
npm run dev:worker   # in one terminal
npm run dev:web      # in another; /api is proxied to the worker
```

For a UI-only preview without Firebase, start the web app with `VITE_DEMO_MODE=true`. Demo mode is compiled out of normal production configuration by leaving that flag false.

## Environment configuration

Populate `web/.env.local` from the Firebase web-app settings. The Worker's
non-secret parameters (`APP_ENVIRONMENT`, `FIREBASE_PROJECT_ID`,
`ALLOWED_WORKSPACE_DOMAIN`, `TARGET_DEVICE_ID`) live in `worker/wrangler.toml`.

Its two secrets — the Google service account and the one-time device enrollment
code — are installed with the provisioner described in
[Zero-cost Cloudflare infrastructure](docs/cloudflare-zero-cost.md).

Android Firebase client identifiers and the API base URL come from
`android/firebase.properties`; see [Android installation](docs/android-installation.md).

See [The API on Cloudflare Workers](docs/cloudflare-worker.md) for the backend
design and deployment steps, and [Deployment status](docs/deployment-status.md)
for live URLs and the remaining handoff.

## Commands

```bash
npm run build          # contracts, backend, and web production build
npm run build:dev      # contracts/backend plus dev-configured web bundle
npm run build:prod     # contracts/backend plus production-configured web bundle
npm test               # backend, worker and web automated tests
npm run test:rules     # Firestore rules tests in the local emulator (JDK 21)
npm run typecheck      # all TypeScript workspaces
npm run dev:worker     # the API on http://127.0.0.1:8787
npm run emulators      # Auth, Firestore, Hosting, Emulator UI
npm run deploy:dev     # worker, then Firestore rules and Hosting
```

Real FCM delivery is not emulated. Production readiness requires the physical Samsung matrix in [Testing](docs/testing.md).
