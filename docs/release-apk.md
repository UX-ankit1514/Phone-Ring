# Release APK procedure

## Versioning

- Increment `versionCode` for every installed build.
- Use semantic `versionName`; dev builds receive the `-dev` suffix.
- Production uses application ID `com.arnifi.phonebell`; dev uses `com.arnifi.phonebell.dev`.

## Signing

Create and store the release keystore outside the repository. Place signing values in the approved CI secret store or local `~/.gradle/gradle.properties`. Never send the keystore or passwords in chat, email, logs, or source control.

```properties
ARNIFI_KEYSTORE_PATH=/absolute/path/to/arnifi-phone-bell.jks
ARNIFI_KEYSTORE_PASSWORD=use-the-approved-secret-store
ARNIFI_KEY_ALIAS=arnifi-phone-bell
ARNIFI_KEY_PASSWORD=use-the-approved-secret-store
```

The Gradle build signs release variants only when all four properties are present. Without them, it still produces an unsigned release APK for compile-time verification and cannot be installed as the production update.

Build the signed artifact only after dev acceptance passes:

```bash
cd android
./gradlew clean testProdDebugUnitTest lintProdRelease assembleProdRelease
```

Verify the APK signature, install it as an update over the previous production version, and confirm enrollment, FCM registration, dedupe history, and diagnostics remain intact.

Keep the immediately previous signed APK and its version record as the rollback artifact. An APK signed with a different key cannot update the installed application.

## Rollout

1. Install the signed dev canary and run the complete matrix.
2. Soak for 24–48 hours with structured request-event monitoring.
3. Deploy production backend/Hosting.
4. Install the signed production APK and enroll it with the production one-time code.
5. Complete one production test request, Delivered callback, acknowledgement, cancellation, and token refresh check.
