# Deployment status

Last updated: 2026-09-10.

## Architecture

Both Firebase projects stay on the free **Spark** plan. No billing account is
linked and nothing in the deployed system requires one. The trusted API runs on
the Cloudflare Workers free plan; see
[The API on Cloudflare Workers](cloudflare-worker.md).

| Environment | Firebase project | Hosting | Worker |
| --- | --- | --- | --- |
| Development | `arnifi-phone-bell-dev` | https://arnifi-phone-bell-dev.web.app | `arnifi-phone-bell-dev` |
| Production | `arnifi-phone-bell-prod` | https://arnifi-phone-bell-prod.web.app | `arnifi-phone-bell-prod` |

## Provisioned

Both Firebase environments have:

- separate web and Android Firebase app registrations;
- Google sign-in enabled, with the Hosting domains authorized;
- Firestore Native databases in `asia-south1` with deletion protection;
- the shared-phone bounded configuration seeded at `config/sharedPhone`;
- tested Firestore rules and indexes deployed;
- environment-specific React bundles deployed to Hosting;
- real client identifiers stored only in gitignored local configuration.

Production authorizes only its Firebase domains plus `phone.arnifi.com`;
development also allows `localhost` for local work.

## Verified locally

- Backend (Cloud Functions implementation): 11 tests
- Worker (deployed implementation): 75 tests
- Web: 6 tests
- Firestore rules: 5 tests
- TypeScript: clean across every workspace
- Android dev variant: unit tests, lint and assembly pass
- Worker bundle: 36 KB gzipped, well inside the free-plan limit

## Remaining to go live

1. Provision the Worker service accounts and install the two secrets per
   environment — see [Zero-cost Cloudflare infrastructure](cloudflare-zero-cost.md).
2. `npm run deploy:worker:dev`, then
   `node scripts/set-worker-url.mjs dev <worker-origin>`, then
   `npm run deploy:firebase:dev`.
3. Confirm `GET /api/v1/health` returns `success: true`.
4. Rebuild the dev APK so it carries the Worker URL, install it on the Samsung,
   and enrol it with the one-time code.
5. Complete the physical-device matrix in [Testing](testing.md).
6. Repeat steps 2-3 for production, only after dev acceptance passes.
7. Add the release keystore described in [Release APK](release-apk.md), rebuild,
   and verify the signature before installing production.
8. Optionally attach `phone.arnifi.com` to production Hosting and complete DNS
   verification.

## Device and signing handoff

- Installable dev APK: `android/app/build/outputs/apk/dev/debug/app-dev-debug.apk`.
  Rebuild it after step 2 so it points at the deployed Worker.
- Compile-verified production artifact:
  `android/app/build/outputs/apk/prod/release/app-prod-release-unsigned.apk`.
- Keep the phone audible when operational. The implementation deliberately
  suppresses sound and vibration in Silent and Do Not Disturb modes.
