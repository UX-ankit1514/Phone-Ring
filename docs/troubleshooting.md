# Troubleshooting

## Test Ring works, real request does not

Check, in order:

1. The APK environment matches the web/backend environment.
2. Diagnostics reports enrolled and token registered.
3. The safe device document is active and the private credential document has a recent token timestamp.
4. Worker logs (`wrangler tail --env dev`) and the `requestEvents` collection contain `REQUEST_CREATED` and `FCM_SEND_SUCCEEDED` for the request ID.
5. The phone has internet, Google Play services, background data, and is not force-stopped or sleeping.

## Test Ring fails

Check notification permission, `UAE Phone Requests` channel state, notification volume, Silent/DND mode, vibration setting, and Samsung battery controls. Use the Diagnostics shortcut to open notification settings.

## Website remains Sent

Firebase accepted the push but the APK has not confirmed receipt. This is intentionally not shown as Delivered. Inspect the request timeline and the APK's last FCM time; allow the request to expire before retrying with a new request.

## Token registration fails

Confirm target authentication is still present and the build's Firebase application ID/project/sender ID match. Open the app to retry current-token registration. Re-enroll only after an administrator creates a new one-time code.

## Cancellation does not stop sound

The cancellation push may have been delayed or unavailable. The RingService hard-stops at the configured limit. Confirm the cancellation request ID matches the active notification and inspect `CANCEL_FCM_SENT` or `CANCEL_FCM_FAILED` in the request timeline.

