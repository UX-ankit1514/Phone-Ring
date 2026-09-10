import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneBellRepository, PhoneRequestRecord, ReservedRequest } from "../domain/models";
import type { ExpiryScheduler } from "./expiryScheduler";
import { PhoneRequestService } from "./phoneRequestService";
import type { PushNotificationService } from "./pushNotificationService";

const now = new Date("2026-09-10T10:00:00.000Z");
const request: PhoneRequestRecord = {
  requestId: "req_123",
  clientRequestId: "78a08308-5c43-4b80-b155-12d28c652fee",
  targetDeviceId: "uae-phone-01",
  requestedBy: { uid: "uid-1", name: "Rahul Sharma" },
  status: "created",
  createdAt: now,
  sentAt: null,
  deliveredAt: null,
  acknowledgedAt: null,
  cancelledAt: null,
  expiresAt: new Date(now.getTime() + 60_000),
  failureCode: null,
  failureMessage: null,
};

const reserved: ReservedRequest = {
  request,
  config: {
    targetDeviceId: "uae-phone-01",
    ringDurationSeconds: 10,
    requestTimeoutSeconds: 60,
    targetterCooldownSeconds: 20,
    allowConcurrentRequests: false,
    vibrationEnabled: true,
    ttsEnabled: false,
    deliveryTimeoutSeconds: 15,
  },
  device: {
    deviceId: "uae-phone-01",
    displayName: "UAE Calling Phone",
    active: true,
    fcmToken: "token",
    lastSeenAt: now,
  },
  idempotentReplay: false,
};

describe("PhoneRequestService", () => {
  let repository: PhoneBellRepository;
  let push: PushNotificationService;
  let expiry: ExpiryScheduler;

  beforeEach(() => {
    repository = {
      reserveRequest: vi.fn().mockResolvedValue(reserved),
      markSent: vi.fn().mockResolvedValue({ ...request, status: "sent", sentAt: now }),
      markFailed: vi.fn().mockResolvedValue({ ...request, status: "failed" }),
      markDelivered: vi.fn(),
      acknowledge: vi.fn(),
      cancel: vi.fn(),
      expire: vi.fn(),
      sweepExpired: vi.fn(),
      recordEvent: vi.fn().mockResolvedValue(undefined),
      registerDevice: vi.fn(),
      heartbeat: vi.fn(),
      getTargetPublicState: vi.fn(),
    };
    push = {
      sendPhoneRequest: vi.fn().mockResolvedValue("message-1"),
      sendCancellation: vi.fn(),
    };
    expiry = { enqueue: vi.fn().mockResolvedValue(undefined) };
  });

  it("schedules expiry, sends once, and returns sent", async () => {
    const service = new PhoneRequestService(repository, push, expiry);
    const result = await service.create({ uid: "uid-1", clientRequestId: request.clientRequestId, targetDeviceId: "uae-phone-01" });
    expect(expiry.enqueue).toHaveBeenCalledWith(request.requestId, request.expiresAt);
    expect(push.sendPhoneRequest).toHaveBeenCalledTimes(1);
    expect(repository.markSent).toHaveBeenCalledWith(request.requestId);
    expect(result.status).toBe("sent");
  });

  it("returns an idempotent replay without another send", async () => {
    vi.mocked(repository.reserveRequest).mockResolvedValue({ ...reserved, idempotentReplay: true, request: { ...request, status: "sent" } });
    const service = new PhoneRequestService(repository, push, expiry);
    const result = await service.create({ uid: "uid-1", clientRequestId: request.clientRequestId, targetDeviceId: "uae-phone-01" });
    expect(result.idempotentReplay).toBe(true);
    expect(push.sendPhoneRequest).not.toHaveBeenCalled();
    expect(expiry.enqueue).not.toHaveBeenCalled();
  });

  it("marks a definite push failure and exposes a retryable error", async () => {
    vi.mocked(push.sendPhoneRequest).mockRejectedValue(new Error("unregistered"));
    const service = new PhoneRequestService(repository, push, expiry);
    await expect(service.create({ uid: "uid-1", clientRequestId: request.clientRequestId, targetDeviceId: "uae-phone-01" })).rejects.toMatchObject({ code: "FCM_SEND_FAILED", retryable: true });
    expect(repository.markFailed).toHaveBeenCalledWith(request.requestId, "FCM_SEND_FAILED", "unregistered");
  });

  it("does not report a request as sent when expiry wins the send race", async () => {
    vi.mocked(repository.markSent).mockResolvedValue({
      ...request,
      status: "failed",
      failureCode: "DISPATCH_TIMEOUT",
      failureMessage: "Request dispatch did not complete before expiry.",
    });
    const service = new PhoneRequestService(repository, push, expiry);
    await expect(
      service.create({ uid: "uid-1", clientRequestId: request.clientRequestId, targetDeviceId: "uae-phone-01" }),
    ).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
    expect(repository.recordEvent).not.toHaveBeenCalledWith(request.requestId, "FCM_SEND_SUCCEEDED", expect.anything());
    expect(repository.markFailed).not.toHaveBeenCalled();
  });
});
