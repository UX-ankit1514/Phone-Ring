import { beforeEach, describe, expect, it } from "vitest";
import { TARGET_DEVICE_ID, TARGET_DISPLAY_NAME } from "@arnifi/contracts";
import { AppError } from "./errors";
import { PhoneBellRepository, deterministicRequestId } from "./repository";
import { FakeFirestore } from "./test/fakeFirestore";

const START = new Date("2026-09-10T10:00:00.000Z");
const UID = "user-1";
const OTHER_UID = "user-2";
const CLIENT_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

let fake: FakeFirestore;
let repository: PhoneBellRepository;
let clock: Date;

function advance(milliseconds: number): void {
  clock = new Date(clock.getTime() + milliseconds);
}

function seedTargetter(uid: string, name: string): void {
  fake.seed(`users/${uid}`, { displayName: name, email: `${uid}@arnifi.com`, role: "targetter" });
}

function create(uid = UID, clientRequestId = CLIENT_REQUEST_ID) {
  return repository.reserveRequest({ uid, clientRequestId, targetDeviceId: TARGET_DEVICE_ID });
}

async function expectError(action: Promise<unknown>, code: string): Promise<AppError> {
  const error = await action.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

beforeEach(() => {
  fake = new FakeFirestore();
  clock = START;
  repository = new PhoneBellRepository(fake.client(), TARGET_DEVICE_ID, () => clock);
  seedTargetter(UID, "Rahul Sharma");
  seedTargetter(OTHER_UID, "Priya Nair");
  fake.seed(`devices/${TARGET_DEVICE_ID}`, {
    deviceId: TARGET_DEVICE_ID,
    displayName: TARGET_DISPLAY_NAME,
    active: true,
    availability: "idle",
    lastSeenAt: START,
  });
  fake.seed(`deviceCredentials/${TARGET_DEVICE_ID}`, {
    deviceId: TARGET_DEVICE_ID,
    fcmToken: "a-target-device-fcm-token-value",
  });
});

describe("reserveRequest", () => {
  it("creates the request, claims the lock and marks the phone busy", async () => {
    const reserved = await create();

    expect(reserved.idempotentReplay).toBe(false);
    expect(reserved.request.status).toBe("created");
    expect(reserved.request.requestedBy).toEqual({ uid: UID, name: "Rahul Sharma" });
    expect(reserved.request.expiresAt.getTime()).toBe(START.getTime() + 60_000);
    expect(reserved.device.fcmToken).toBe("a-target-device-fcm-token-value");

    const stored = fake.read(`phoneRequests/${reserved.request.requestId}`);
    expect(stored?.status).toBe("created");
    expect(stored?.deleteAt).toBeInstanceOf(Date);
    expect(fake.read(`deviceRequestLocks/${TARGET_DEVICE_ID}`)?.activeRequestId).toBe(
      reserved.request.requestId,
    );
    expect(fake.read(`devices/${TARGET_DEVICE_ID}`)?.availability).toBe("busy");
    expect(fake.read(`idempotencyKeys/${reserved.request.requestId}`)?.uid).toBe(UID);
  });

  it("keeps the devices document a narrow public projection", async () => {
    await create();
    expect(Object.keys(fake.read(`devices/${TARGET_DEVICE_ID}`) ?? {}).sort()).toEqual([
      "active",
      "availability",
      "deviceId",
      "displayName",
      "lastSeenAt",
    ]);
  });

  it("replays the same client request id instead of ringing twice", async () => {
    const first = await create();
    const replay = await create();

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.request.requestId).toBe(first.request.requestId);
  });

  it("derives the request id from the caller and the client request id", async () => {
    const reserved = await create();
    expect(reserved.request.requestId).toBe(await deterministicRequestId(UID, CLIENT_REQUEST_ID));
  });

  it("rejects a second employee while a request is still active", async () => {
    const first = await create();
    const error = await expectError(
      create(OTHER_UID, "22222222-2222-4222-8222-222222222222"),
      "ACTIVE_REQUEST_EXISTS",
    );
    expect(error.details?.requestId).toBe(first.request.requestId);
  });

  it("applies the per-employee cooldown", async () => {
    const first = await create();
    await repository.acknowledge(first.request.requestId, TARGET_DEVICE_ID);
    advance(5_000);

    const error = await expectError(
      create(UID, "33333333-3333-4333-8333-333333333333"),
      "TARGETTER_COOLDOWN",
    );
    expect(error.details?.retryAfterSeconds).toBe(15);
  });

  it("recovers a lock still held by a request that has already expired", async () => {
    const first = await create();
    await repository.markSent(first.request.requestId);
    advance(61_000);

    const second = await create(OTHER_UID, "44444444-4444-4444-8444-444444444444");

    expect(second.request.status).toBe("created");
    expect(fake.read(`phoneRequests/${first.request.requestId}`)?.status).toBe("expired");
    expect(fake.read(`deviceRequestLocks/${TARGET_DEVICE_ID}`)?.activeRequestId).toBe(
      second.request.requestId,
    );
  });

  it("requires a display name before ringing", async () => {
    fake.documents.delete(`users/${UID}`);
    await expectError(create(), "PROFILE_REQUIRED");
  });

  it("refuses to ring a phone that is not registered", async () => {
    fake.seed(`devices/${TARGET_DEVICE_ID}`, {
      deviceId: TARGET_DEVICE_ID,
      displayName: TARGET_DISPLAY_NAME,
      active: false,
      availability: "idle",
      lastSeenAt: START,
    });
    await expectError(create(), "TARGET_UNAVAILABLE");
  });
});

describe("state transitions", () => {
  it("marks a request sent", async () => {
    const { request } = await create();
    const sent = await repository.markSent(request.requestId);

    expect(sent.status).toBe("sent");
    expect(sent.sentAt).toEqual(START);
  });

  it("fails rather than sending a request that already expired", async () => {
    const { request } = await create();
    advance(61_000);

    const sent = await repository.markSent(request.requestId);

    expect(sent.status).toBe("failed");
    expect(sent.failureCode).toBe("DISPATCH_TIMEOUT");
    expect(fake.read(`deviceRequestLocks/${TARGET_DEVICE_ID}`)?.activeRequestId).toBeUndefined();
    expect(fake.read(`devices/${TARGET_DEVICE_ID}`)?.availability).toBe("idle");
  });

  it("moves a request through delivered to acknowledged and frees the phone", async () => {
    const { request } = await create();
    await repository.markSent(request.requestId);
    advance(1_000);
    const delivered = await repository.markDelivered(request.requestId, TARGET_DEVICE_ID);
    advance(1_000);
    const acknowledged = await repository.acknowledge(request.requestId, TARGET_DEVICE_ID);

    expect(delivered.status).toBe("delivered");
    expect(acknowledged.status).toBe("acknowledged");
    expect(acknowledged.acknowledgedAt).not.toBeNull();
    expect(fake.read(`deviceRequestLocks/${TARGET_DEVICE_ID}`)?.activeRequestId).toBeUndefined();
    expect(fake.read(`devices/${TARGET_DEVICE_ID}`)?.availability).toBe("idle");
  });

  it("reports an acknowledgement that arrives after expiry as expired", async () => {
    const { request } = await create();
    await repository.markSent(request.requestId);
    advance(61_000);

    await expectError(repository.acknowledge(request.requestId, TARGET_DEVICE_ID), "REQUEST_EXPIRED");
    expect(fake.read(`phoneRequests/${request.requestId}`)?.status).toBe("expired");
  });

  it("cancels only for the employee who created the request", async () => {
    const { request } = await create();
    await repository.markSent(request.requestId);

    await expectError(repository.cancel(request.requestId, OTHER_UID), "FORBIDDEN");

    const cancelled = await repository.cancel(request.requestId, UID);
    expect(cancelled.request.status).toBe("cancelled");
    expect(cancelled.deviceToken).toBe("a-target-device-fcm-token-value");
    expect(fake.read(`devices/${TARGET_DEVICE_ID}`)?.availability).toBe("idle");
  });

  it("rejects a device callback for a different phone", async () => {
    const { request } = await create();
    await expectError(repository.markDelivered(request.requestId, "some-other-phone"), "FORBIDDEN");
  });

  it("reports an unknown request", async () => {
    await expectError(repository.markSent("req_missing"), "REQUEST_NOT_FOUND");
  });
});

describe("scheduled maintenance", () => {
  it("expires overdue requests and releases the phone", async () => {
    const { request } = await create();
    await repository.markSent(request.requestId);
    advance(61_000);

    expect(await repository.sweepExpired(50)).toBe(1);
    expect(fake.read(`phoneRequests/${request.requestId}`)?.status).toBe("expired");
    expect(fake.read(`devices/${TARGET_DEVICE_ID}`)?.availability).toBe("idle");
    expect(await repository.sweepExpired(50)).toBe(0);
  });

  it("deletes documents past their retention date", async () => {
    const { request } = await create();
    advance(25 * 60 * 60 * 1_000);

    const deleted = await repository.purgeExpiredDocuments(50);

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(fake.read(`idempotencyKeys/${request.requestId}`)).toBeNull();
    expect(fake.read(`phoneRequests/${request.requestId}`)).not.toBeNull();
  });
});

describe("device registration", () => {
  it("stores the push token privately and keeps the phone idle when free", async () => {
    await repository.registerDevice({
      deviceId: TARGET_DEVICE_ID,
      fcmToken: "a-freshly-rotated-fcm-token",
      appVersion: "1.0.0",
      deviceModel: "SM-A155F",
    });

    expect(fake.read(`deviceCredentials/${TARGET_DEVICE_ID}`)?.fcmToken).toBe(
      "a-freshly-rotated-fcm-token",
    );
    expect(fake.read(`devices/${TARGET_DEVICE_ID}`)?.availability).toBe("idle");
    expect(fake.read(`devices/${TARGET_DEVICE_ID}`)?.fcmToken).toBeUndefined();
    expect(fake.read(`deviceMetadata/${TARGET_DEVICE_ID}`)?.deviceModel).toBe("SM-A155F");
  });

  it("keeps the phone busy across a re-registration during an active request", async () => {
    await create();
    await repository.registerDevice({
      deviceId: TARGET_DEVICE_ID,
      fcmToken: "a-freshly-rotated-fcm-token",
      appVersion: "1.0.0",
      deviceModel: "SM-A155F",
    });

    expect(fake.read(`devices/${TARGET_DEVICE_ID}`)?.availability).toBe("busy");
  });

  it("reports health from the last heartbeat", async () => {
    await repository.heartbeat(TARGET_DEVICE_ID, "1.0.0");
    expect((await repository.getTargetPublicState(TARGET_DEVICE_ID)).health).toBe("likely_online");

    advance(20 * 60_000);
    expect((await repository.getTargetPublicState(TARGET_DEVICE_ID)).health).toBe("possibly_offline");
  });
});
