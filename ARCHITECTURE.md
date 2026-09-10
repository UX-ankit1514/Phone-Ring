# System architecture

## Request path

1. An employee signs in with a verified `@arnifi.com` Google Workspace account.
2. The browser saves a validated display name and creates a UUID idempotency key.
3. The Worker API atomically checks cooldown, target availability, and the target lock, then writes a `created` request.
4. The backend loads the latest FCM token from the server-only credential document and sends one high-priority data message.
5. Firebase acceptance moves the request to `sent`; it is not treated as handset delivery.
6. `FirebaseMessagingService` validates and persistently deduplicates the message, triggers the local alert, and posts the Delivered callback.
7. Firestore moves to `delivered`; the owning browser's realtime listener updates without refresh.
8. `I'VE GOT IT` stops the local alert immediately and queues an idempotent acknowledgement, moving the request to `acknowledged` when online.

Firestore security rules deny every client write to server-owned collections.
The Worker reaches Firestore over the REST API with a dedicated service account,
which bypasses rules the same way the Admin SDK did.

## Firestore collections

| Collection | Access | Purpose |
| --- | --- | --- |
| `users` | owner read/write validated profile fields | Employee display profile |
| `devices` | Workspace read, server write | Safe target status and health |
| `deviceCredentials` | server only | FCM token and target Auth UID |
| `phoneRequests` | requester read, server write | Canonical request state |
| `config` | Workspace read, server write | Bounded operational defaults |
| `deviceRequestLocks` | server only | One active request per target |
| `userRequestLimits` | server only | Per-employee cooldown |
| `idempotencyKeys` | server only | Retry-safe request lookup |
| `requestEvents` | server only | Structured request timeline |
| `deviceEnrollments` | server only | One-time enrollment consumption |

## State model

```text
created -> sent -> delivered -> acknowledged
   |         |         |
   +---------+---------+----> cancelled / expired / failed
```

Device receipt may atomically recover `created` to `delivered` if the process stopped after FCM acceptance but before the `sent` write. Acknowledgement may record the missing Delivered event in the same transaction. These recovery paths never move state backward and make the physical device proof authoritative.

## Expiration and concurrency

- `deviceRequestLocks/uae-phone-01` is acquired in the same transaction that creates the request.
- A one-minute Cloudflare Cron Trigger sweeps overdue requests; create-time stale-lock recovery heals anything it misses, so a request is never blocked waiting for the sweep.
- Terminal transitions release the matching lock and publish safe device availability.
- FCM TTL and the payload expiry prevent stale offline delivery from ringing after the request's 60-second lifetime.
- Documents carry a `deleteAt` retention stamp that the same cron sweeps, standing in for Firestore TTL policies, which require a billing account.

## Android alert path

- High-priority data FCM enters `FirebaseMessagingService`.
- The payload is validated for type, request ID, target, expiry, requester length, and ring bounds.
- DataStore records the request ID before alerting so duplicate FCM delivery cannot ring twice.
- The shared RingController drives both real alerts and Test Ring.
- A foreground RingService posts the high-importance notification, sound, and vibration and owns the hard stop timer.
- WorkManager handles callback retry and heartbeat only; it is never the ringing trigger.

