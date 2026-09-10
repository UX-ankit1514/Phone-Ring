# Android installation and enrollment

## Build prerequisites

- Android Studio with Android SDK 36.
- JDK 17.
- The repository Gradle wrapper.
- The dev or production Firebase Android application values.

Copy `android/firebase.properties.example` to the gitignored `android/firebase.properties`, or add the same environment-specific values to `~/.gradle/gradle.properties`. `node scripts/set-worker-url.mjs <dev|prod> <worker-origin>` fills in the API base URLs after the Worker is deployed:

```properties
ARNIFI_DEV_API_BASE_URL=https://arnifi-phone-bell-dev.<subdomain>.workers.dev/api/v1/
ARNIFI_DEV_FIREBASE_PROJECT_ID=arnifi-phone-bell-dev
ARNIFI_DEV_FIREBASE_APPLICATION_ID=
ARNIFI_DEV_FIREBASE_API_KEY=
ARNIFI_DEV_FIREBASE_GCM_SENDER_ID=

ARNIFI_PROD_API_BASE_URL=https://arnifi-phone-bell-prod.<subdomain>.workers.dev/api/v1/
ARNIFI_PROD_FIREBASE_PROJECT_ID=arnifi-phone-bell-prod
ARNIFI_PROD_FIREBASE_APPLICATION_ID=
ARNIFI_PROD_FIREBASE_API_KEY=
ARNIFI_PROD_FIREBASE_GCM_SENDER_ID=

# Required only for installable production release artifacts.
ARNIFI_KEYSTORE_PATH=/absolute/path/to/arnifi-phone-bell.jks
ARNIFI_KEYSTORE_PASSWORD=
ARNIFI_KEY_ALIAS=arnifi-phone-bell
ARNIFI_KEY_PASSWORD=
```

Build with:

```bash
cd android
./gradlew testDevDebugUnitTest assembleDevDebug
./gradlew testProdDebugUnitTest lintProdRelease assembleProdRelease
```

## First enrollment

1. Deploy the matching backend and create a fresh `DEVICE_ENROLLMENT_CODE` secret.
2. Install the dev APK on the Samsung for acceptance testing.
3. Open Arnifi Phone Bell and enter the one-time code.
4. Confirm Diagnostics reports Firebase configured, device enrolled, FCM token registered, notifications enabled, and Test Ring successful.
5. Rotate the enrollment secret immediately after success.

## Samsung operating settings

1. Allow notifications and confirm the `UAE Phone Requests` channel is enabled.
2. Set notification volume high enough for the office.
3. Allow background data.
4. Set battery use to Unrestricted where the Samsung model provides that option.
5. Remove the app from Sleeping and Deep sleeping apps.
6. Keep Google Play services enabled and updated.

The product intentionally respects Silent and Do Not Disturb. Operational setup must keep the company-owned phone in an audible mode when it is expected to receive requests.

Force-stopping the app prevents reliable FCM receipt until it is opened again. Diagnostics and the runbook treat a force-stopped app as not ready.
