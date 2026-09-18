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
4. Grant the two caller-display permissions the home screen asks for: **Display over other apps** and **Full-screen alerts** (Android 14+). Neither is needed for the phone to ring, only to show who is asking.
5. Confirm Diagnostics reports Firebase configured, device enrolled, FCM token registered, notifications enabled, and Test Ring successful.
6. Rotate the enrollment secret immediately after success.

## Samsung operating settings

1. Allow notifications and confirm the `UAE Phone Requests` channel is enabled.
2. Allow **Display over other apps** and, on Android 14+, **Full-screen alerts**.
3. Allow background data.
4. Set battery use to Unrestricted where the Samsung model provides that option.
5. Remove the app from Sleeping and Deep sleeping apps.
6. Keep Google Play services enabled and updated.

From V2 the alert is an alarm, not a notification tone. It plays on the loudspeaker at maximum alarm volume regardless of the media or ringer volume, and it is not silenced by Silent mode or by ordinary Do Not Disturb profiles. The alarm stream volume is restored to whatever it was as soon as the request ends.

The bell is the handset's own ringtone, read from the phone at ring time, so the alert sounds like the device it lives on and follows any later change in Settings. Nothing copyrighted is bundled into the APK. A phone whose ringtone is set to Silent falls back to the bell shipped with the app, so a shared phone cannot be muted by accident. Diagnostics names the tone that will play.

The one setting that still silences it is Do Not Disturb set to **Total silence**, which is the phone owner's explicit "nothing at all". The caller's name is still shown on screen in that case.

Force-stopping the app prevents reliable FCM receipt until it is opened again. Diagnostics and the runbook treat a force-stopped app as not ready.
