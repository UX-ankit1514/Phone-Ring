# Security model

## Employee identity

- Production access requires a verified Google Workspace account in `arnifi.com`.
- Authentication is rechecked by the backend; hiding a button in the web UI is not authorization.
- Display names remain editable for office familiarity but are associated with the verified Firebase UID.

## Target identity

- The APK never contains an enrollment code or privileged service credential.
- An administrator creates a one-time code in Secret Manager and enters it on the physical Samsung.
- A successful exchange consumes that code and returns a Firebase custom token carrying `role=target` and `deviceId=uae-phone-01`.
- Registration and callbacks must present a current Firebase ID token whose target claim matches the request body and request target.
- Re-enrollment requires a new secret value; rotating a code is an explicit administrator action.

## Data controls

- Browser clients cannot send FCM or read the target token.
- FCM tokens live only in `deviceCredentials`, which has no client access.
- Clients cannot write request state, timestamps, locks, events, cooldowns, or operational configuration.
- Employees can read only their own request documents and the safe target/config documents.
- Server timestamps own authoritative lifecycle time.
- Logs exclude auth headers, enrollment codes, FCM tokens, and secrets.

## Secret handling

Never commit service accounts, enrollment codes, release keystores, keystore passwords, or signing properties. Firebase web configuration and Android Firebase application identifiers are client identifiers, but environment-specific files still remain separate to prevent dev/prod cross-registration.

Before production, verify:

- Google provider and authorized domains are limited to the intended projects.
- `DEVICE_ENROLLMENT_CODE` is rotated after enrollment.
- least-privilege deployment/service accounts are used.
- Firestore rules tests and Firebase Rules Playground checks pass.
- release signing material is backed up in the approved password manager.

