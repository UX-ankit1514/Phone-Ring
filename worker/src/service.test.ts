import { beforeEach, describe, expect, it } from "vitest";
import { TARGET_DEVICE_ID, TARGET_DISPLAY_NAME } from "@arnifi/contracts";
import { AppError } from "./errors";
import type { PushSender } from "./push";
import { PhoneBellRepository } from "./repository";
import { PhoneRequestService } from "./service";
import { FakeFirestore } from "./test/fakeFirestore";
import type { PhoneRequestRecord, SharedPhoneConfig } from "./types";

const START = new Date("2026-09-10T10:00:00.000Z");
const UID = "user-1";
const CLIENT_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

class RecordingPush implements PushSender {
  readonly requests: Array<{ token: string; request: PhoneRequestRecord; config: SharedPhoneConfig }> = [];
  readonly cancellations: Array<{ token: string; request: PhoneRequestRecord }> = [];
  failure: Error | null = null;

  async sendPhoneRequest(
    token: string,
    request: PhoneRequestRecord,
    config: SharedPhoneConfig,
  ): Promise<string> {
    if (this.failure) throw this.failure;
    this.requests.push({ token, request, config });
    return "projects/test/messages/1";
  }

  async sendCancellation(token: string, request: PhoneRequestRecord): Promise<string> {
    this.cancellations.push({ token, request });
    return "projects/test/messages/2";
  }
}

let fake: FakeFirestore;
let repository: PhoneBellRepository;
let push: RecordingPush;
let service: PhoneRequestService;
let clock: Date;

function events(): string[] {
  return [...fake.documents.keys()]
    .filter((path) => path.startsWith("requestEvents/"))
    .map((path) => String(fake.read(path)?.event));
}

beforeEach(() => {
  fake = new FakeFirestore();
  clock = START;
  repository = new PhoneBellRepository(fake.client(), TARGET_DEVICE_ID, () => clock);
  push = new RecordingPush();
  service = new PhoneRequestService(repository, push);
  fake.seed(`users/${UID}`, { displayName: "Rahul Sharma", email: "rahul@arnifi.com" });
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

describe("PhoneRequestService.create", () => {
  it("pushes the ring to the phone and records the request as sent", async () => {
    const result = await service.create({
      uid: UID,
      clientRequestId: CLIENT_REQUEST_ID,
      targetDeviceId: TARGET_DEVICE_ID,
    });

    expect(result).toMatchObject({ success: true, status: "sent", idempotentReplay: false });
    expect(push.requests).toHaveLength(1);
    expect(push.requests[0]?.token).toBe("a-target-device-fcm-token-value");
    expect(push.requests[0]?.request.requestedBy.name).toBe("Rahul Sharma");
    expect(push.requests[0]?.config.ringDurationSeconds).toBe(10);
    expect(events()).toEqual(
      expect.arrayContaining(["REQUEST_CREATED", "FCM_SEND_STARTED", "FCM_SEND_SUCCEEDED"]),
    );
  });

  it("does not ring twice for a replayed client request id", async () => {
    await service.create({ uid: UID, clientRequestId: CLIENT_REQUEST_ID, targetDeviceId: TARGET_DEVICE_ID });
    const replay = await service.create({
      uid: UID,
      clientRequestId: CLIENT_REQUEST_ID,
      targetDeviceId: TARGET_DEVICE_ID,
    });

    expect(replay.idempotentReplay).toBe(true);
    expect(push.requests).toHaveLength(1);
  });

  it("marks the request failed and frees the phone when the push is rejected", async () => {
    push.failure = new Error("fcm token=abc123 was rejected");

    const error = await service
      .create({ uid: UID, clientRequestId: CLIENT_REQUEST_ID, targetDeviceId: TARGET_DEVICE_ID })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("FCM_SEND_FAILED");
    const stored = [...fake.documents.keys()].find((path) => path.startsWith("phoneRequests/")) as string;
    expect(fake.read(stored)?.status).toBe("failed");
    expect(fake.read(`devices/${TARGET_DEVICE_ID}`)?.availability).toBe("idle");
  });

  it("redacts credentials that a provider echoes back in its error", async () => {
    push.failure = new Error("fcm token=super-secret-value was rejected");

    await service
      .create({ uid: UID, clientRequestId: CLIENT_REQUEST_ID, targetDeviceId: TARGET_DEVICE_ID })
      .catch(() => undefined);

    const messages = [...fake.documents.keys()]
      .filter((path) => path.startsWith("requestEvents/"))
      .map((path) => String(fake.read(path)?.message ?? ""));
    expect(messages.join(" ")).not.toContain("super-secret-value");
    expect(messages.join(" ")).toContain("[redacted]");
  });

  it("does not report a request as sent when the push outlives its deadline", async () => {
    const slowClock = () => clock;
    repository = new PhoneBellRepository(fake.client(), TARGET_DEVICE_ID, slowClock);
    service = new PhoneRequestService(repository, {
      async sendPhoneRequest() {
        clock = new Date(clock.getTime() + 61_000);
        return "projects/test/messages/1";
      },
      async sendCancellation() {
        return "projects/test/messages/2";
      },
    });

    const error = await service
      .create({ uid: UID, clientRequestId: CLIENT_REQUEST_ID, targetDeviceId: TARGET_DEVICE_ID })
      .catch((cause: unknown) => cause);

    expect((error as AppError).code).toBe("REQUEST_EXPIRED");
  });
});

describe("PhoneRequestService.cancel", () => {
  it("tells the phone to stop ringing", async () => {
    const created = await service.create({
      uid: UID,
      clientRequestId: CLIENT_REQUEST_ID,
      targetDeviceId: TARGET_DEVICE_ID,
    });

    const cancelled = await service.cancel(created.requestId, UID);

    expect(cancelled.status).toBe("cancelled");
    expect(push.cancellations).toHaveLength(1);
    expect(events()).toEqual(expect.arrayContaining(["REQUEST_CANCELLED", "CANCEL_FCM_SENT"]));
  });

  it("still cancels when the stop-ringing push cannot be delivered", async () => {
    const created = await service.create({
      uid: UID,
      clientRequestId: CLIENT_REQUEST_ID,
      targetDeviceId: TARGET_DEVICE_ID,
    });
    push.sendCancellation = async () => {
      throw new Error("network down");
    };

    const cancelled = await service.cancel(created.requestId, UID);

    expect(cancelled.status).toBe("cancelled");
    expect(events()).toEqual(expect.arrayContaining(["CANCEL_FCM_FAILED"]));
  });
});
