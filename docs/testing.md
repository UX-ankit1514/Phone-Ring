# Test and acceptance plan

## Automated gates

Use Node.js 22, JDK 21 for `test:rules`, and JDK 17 plus Android SDK 36 for the Android command.

Run before each deployment:

```bash
npm run build
npm test
npm run test:rules
cd android && ./gradlew testDevDebugUnitTest lintDevDebug assembleDevDebug
```

The backend suite covers the state machine, validation, idempotent replay, one-send behavior, expiry scheduling, push failure, and recovery semantics. The Firestore emulator suite verifies Arnifi Google identity checks, profile validation, owner-scoped requests, the safe device projection, and denial of every private/device write path.

## PRD acceptance matrix

| ID | Scenario | Pass condition |
| --- | --- | --- |
| A | First visit and name confirmation | Profile is saved and Ring screen opens |
| B | Reopen browser | Confirmed name and active request recover |
| C | Samsung screen off | Sound, vibration, and requester notification appear |
| D | Samsung locked | Alert and notification action remain usable |
| E | Tap I'VE GOT IT | Local ring stops and browser acknowledges without refresh |
| F | Double-click Ring | One request, one FCM send, one physical ring |
| G | Second employee during active request | Atomic conflict with clear wait copy |
| H | No acknowledgement | Request expires and Ring becomes available |
| I | FCM token refresh | Backend updates automatically and future request arrives |
| J | Samsung offline | Browser remains Sent/unconfirmed and later expires |
| K | Cancel active request | State cancels and only the matching alert stops |
| L | Duplicate FCM | Persistent dedupe prevents a second ring |
| M | Notifications disabled | Diagnostics identifies the issue and opens settings |
| N | Test Ring | The production RingController alerts without Firebase |

## Physical Samsung matrix

Repeat C–N with the app foregrounded, backgrounded, process removed, device locked, screen off, Doze, battery saver, Wi-Fi, mobile data, offline/reconnect, channel muted, low/maximum volume, and after an APK upgrade. Record model, Android version, One UI version, battery settings, notification-channel state, request ID, timestamps, and outcome.

Do not classify FCM send acceptance as delivery. The request passes delivery only when the target callback moves Firestore to `delivered`.
