import type { PhoneRequestRecord, SharedPhoneConfig } from "./types";
import type { GoogleClient } from "./google";

export interface PushSender {
  sendPhoneRequest(
    deviceToken: string,
    request: PhoneRequestRecord,
    config: SharedPhoneConfig,
  ): Promise<string>;
  sendCancellation(deviceToken: string, request: PhoneRequestRecord): Promise<string>;
}

export class FcmPushSender implements PushSender {
  constructor(
    private readonly google: GoogleClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  sendPhoneRequest(
    deviceToken: string,
    request: PhoneRequestRecord,
    config: SharedPhoneConfig,
  ): Promise<string> {
    // Keep the message deliverable for the whole configured request window
    // rather than truncating it to the 60s production default.
    const ttlSeconds = (request.expiresAt.getTime() - this.now().getTime()) / 1_000;
    return this.google.sendFcm(
      deviceToken,
      {
        type: "PHONE_REQUEST",
        requestId: request.requestId,
        targetDeviceId: request.targetDeviceId,
        requestedByName: request.requestedBy.name,
        expiresAtEpochMs: String(request.expiresAt.getTime()),
        ringDurationSeconds: String(config.ringDurationSeconds),
        vibrationEnabled: String(config.vibrationEnabled),
        ttsEnabled: String(config.ttsEnabled),
      },
      ttlSeconds,
      request.requestId,
    );
  }

  sendCancellation(deviceToken: string, request: PhoneRequestRecord): Promise<string> {
    return this.google.sendFcm(
      deviceToken,
      {
        type: "PHONE_REQUEST_CANCELLED",
        requestId: request.requestId,
        targetDeviceId: request.targetDeviceId,
      },
      60,
      request.requestId,
    );
  }
}
