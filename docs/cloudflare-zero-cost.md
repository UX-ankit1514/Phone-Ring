# Zero-cost Cloudflare Worker infrastructure

This deployment keeps both Firebase projects on the Spark plan and moves only the secure API execution to Cloudflare Workers Free. No billing account or payment card is needed for this pipeline.

## Resulting pipeline

```text
React on Firebase Hosting (Spark)
  -> Cloudflare Worker (Free)
     -> Firebase Auth token verification
     -> Firestore REST transactions (Spark quota)
     -> FCM HTTP v1 send (no-cost service)
  -> shared Samsung Android app
```

Development and production remain isolated:

| Environment | Firebase project | Wrangler environment |
| --- | --- | --- |
| Development | `arnifi-phone-bell-dev` | `dev` |
| Production | `arnifi-phone-bell-prod` | `prod` |

## What the provisioner changes

[`scripts/cloudflare/provision-google.mjs`](../scripts/cloudflare/provision-google.mjs) uses the existing local Firebase CLI login without displaying its OAuth access or refresh token. For each selected project it idempotently:

1. Enables only the APIs needed for provisioning and runtime: Service Usage, Cloud Resource Manager, IAM, Firebase Management, Firestore, Identity Toolkit and FCM.
2. Creates `arnifi-phone-bell-worker@PROJECT_ID.iam.gserviceaccount.com`.
3. Creates or reconciles three project custom roles:
   - Firestore: `datastore.databases.get` plus document create, delete, get, list and update. These cover begin/rollback transaction, commit, query and required document operations.
   - Device identity: `firebaseauth.users.create`, `firebaseauth.users.get` and `firebaseauth.users.update`, used only to create the single target-device identity and stamp its custom claims during enrollment.
   - FCM: only `cloudmessaging.messages.create`.
4. Grants only those three custom roles to the dedicated service account.

It does not grant Owner, Editor, Firebase Admin, Firestore Admin, Firebase Auth Admin or the broader FCM Admin role.

Employee and device ID tokens are verified inside the Worker against Google's
public `securetoken` signing keys, so no Firebase API key is part of the Worker's
configuration.

## Run preparation

Use Node 22 from the repository root. Status is read-only; apply is safe to repeat.

```bash
node scripts/cloudflare/provision-google.mjs status --project all
node scripts/cloudflare/provision-google.mjs apply --project all
node scripts/cloudflare/provision-google.mjs status --project all
```

If the cached Firebase login does not include the Cloud Platform scope, renew it locally:

```bash
npx firebase login --reauth
```

Do not paste the returned authorization code, access token or refresh token into chat, a source file, a shell argument or a CI log.

## Authenticate Wrangler

The Worker directory must have its dependencies installed and Wrangler must be authenticated to the desired free Cloudflare account:

```bash
cd worker
npm install
npx wrangler login
cd ..
```

`wrangler login` authorizes deployment; it does not add a paid Workers subscription.

## Install the two Worker secrets

Run each environment separately:

```bash
node scripts/cloudflare/provision-google.mjs install-secrets --project dev --worker-dir worker
node scripts/cloudflare/provision-google.mjs install-secrets --project prod --worker-dir worker
```

The command uploads these two independently named bindings in one encrypted Wrangler bulk-secret request:

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `DEVICE_ENROLLMENT_CODE`

The Google service-account JSON is created in memory and piped directly to Wrangler over stdin. It is never passed in process arguments, printed, or written to disk. If Wrangler fails, the new Google key is revoked automatically.

The one-time device enrollment code must also be entered on the Samsung. By default it is generated and written to a unique mode-`0600` file inside a mode-`0700` operating-system temporary directory. The script prints only that path. Copy it into the phone without printing it to terminal history, then remove the temporary directory after enrollment:

```bash
# macOS: copy without displaying
pbcopy < /private/tmp/arnifi-phone-bell-dev-XXXXXX/device-enrollment-code.txt

# after successful enrollment
rm /private/tmp/arnifi-phone-bell-dev-XXXXXX/device-enrollment-code.txt
rmdir /private/tmp/arnifi-phone-bell-dev-XXXXXX
```

To supply an existing enrollment code, first create it through an approved secret manager, ensure it contains 24-256 non-whitespace characters, and restrict the file before use:

```bash
chmod 600 /secure/path/device-enrollment-code.txt
node scripts/cloudflare/provision-google.mjs install-secrets \
  --project dev \
  --worker-dir worker \
  --enrollment-code-file /secure/path/device-enrollment-code.txt
```

Never commit `.dev.vars`, `.env`, a service-account JSON file or an enrollment code. Cloudflare recommends Wrangler Secrets for deployed credentials because secret values cannot be viewed again in Wrangler or the dashboard.

## Rotate and clean up Google keys

Each `install-secrets` run creates a new key so Cloudflare receives current key material. After the upload succeeds, `--retire-old-keys` revokes all prior user-managed keys on this dedicated account:

```bash
node scripts/cloudflare/provision-google.mjs install-secrets \
  --project dev \
  --worker-dir worker \
  --retire-old-keys
```

Without that flag, the non-secret key IDs remain visible in `status`. Delete one exact stale key only after confirming it is not the active Worker key:

```bash
node scripts/cloudflare/provision-google.mjs status --project dev
node scripts/cloudflare/provision-google.mjs delete-key \
  --project dev \
  --key-id KEY_ID \
  --confirm-delete KEY_ID
```

Deleting the key currently stored in Cloudflare immediately stops Firestore and FCM calls. Recover by rerunning `install-secrets` for that environment.

To remove Cloudflare secrets during decommissioning:

```bash
cd worker
npx wrangler secret delete GOOGLE_SERVICE_ACCOUNT_JSON --env dev
npx wrangler secret delete DEVICE_ENROLLMENT_CODE --env dev
```

Repeat with `--env prod` for production. Then use the exact-key command above for every remaining user-managed Google key. Service-account or custom-role deletion is deliberately not automated because those destructive project-wide changes require an explicit decommission decision.

## Verification

Google-side verification:

```bash
node scripts/cloudflare/provision-google.mjs status --project all
```

Every project should report:

- all required services with `enabled: true`;
- `serviceAccount.exists: true` and `disabled: false`;
- all three custom roles with `matchesDefinition: true`;
- all three role bindings with `granted: true`;
- `readyForSecretInstallation: true`.

Cloudflare-side verification exposes only secret names, never values:

```bash
cd worker
npx wrangler secret list --env dev
npx wrangler secret list --env prod
npx wrangler deploy --dry-run --outdir /tmp/arnifi-worker-dry-run
```

After deployment, verify the Worker health endpoint, then submit one development ring request and confirm `created -> sent -> delivered -> acknowledged` before deploying production.

## Free-tier behavior and limits

- Firebase Spark has no payment method. Authentication, Firestore, Hosting and FCM remain limited by their published no-cost quotas. Exhausted quotas reject or defer work; they do not silently upgrade the project.
- Workers Free currently allows 100,000 requests per account per day, resetting at midnight UTC, 10 ms CPU time per HTTP request and 50 external subrequests per invocation. Above the daily request limit, Cloudflare returns Error 1027. Use fail-closed routing for this security-sensitive API.
- Wrangler environment secrets are separate and non-inheritable, which is why dev and prod are installed independently.
- Merely enabling the Google APIs in this document does not enable Cloud Functions, Cloud Run, Cloud Build, Cloud Tasks, Cloud Scheduler or Firestore TTL and does not move Firebase to Blaze.

Current references:

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler secret commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret)
- [Firestore IAM method permissions](https://cloud.google.com/firestore/docs/security/iam)
- [Firebase Cloud Messaging IAM permissions](https://cloud.google.com/iam/docs/roles-permissions/firebasecloudmessaging)
- [FCM HTTP v1 authorization](https://firebase.google.com/docs/cloud-messaging/auth-server)
