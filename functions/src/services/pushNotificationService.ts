import { getMessaging, type Messaging } from "firebase-admin/messaging";
import type { PhoneRequestRecord, SharedPhoneConfig } from "../domain/models";

export interface PushNotificationService {
  sendPhoneRequest(deviceToken: string, request: PhoneRequestRecord, config: SharedPhoneConfig): Promise<string>;
  sendCancellation(deviceToken: string, request: PhoneRequestRecord): Promise<string>;
}

export class FirebasePushNotificationService implements PushNotificationService {
  constructor(private readonly messaging: Messaging = getMessaging()) {}

  sendPhoneRequest(
    deviceToken: string,
    request: PhoneRequestRecord,
    config: SharedPhoneConfig,
  ): Promise<string> {
    // FCM accepts TTLs up to four weeks. Keep the message deliverable for the
    // complete configured request window (which may be longer than the 60s
    // production default) instead of silently truncating it to one minute.
    const ttlMilliseconds = Math.max(
      1,
      Math.min(2_419_200_000, request.expiresAt.getTime() - Date.now()),
    );
    return this.messaging.send({
      token: deviceToken,
      android: {
        priority: "high",
        ttl: ttlMilliseconds,
        collapseKey: request.requestId,
      },
      data: {
        type: "PHONE_REQUEST",
        requestId: request.requestId,
        targetDeviceId: request.targetDeviceId,
        requestedByName: request.requestedBy.name,
        expiresAtEpochMs: String(request.expiresAt.getTime()),
        ringDurationSeconds: String(config.ringDurationSeconds),
        vibrationEnabled: String(config.vibrationEnabled),
        ttsEnabled: String(config.ttsEnabled),
      },
    });
  }

  sendCancellation(deviceToken: string, request: PhoneRequestRecord): Promise<string> {
    return this.messaging.send({
      token: deviceToken,
      android: { priority: "high", ttl: 60_000, collapseKey: request.requestId },
      data: {
        type: "PHONE_REQUEST_CANCELLED",
        requestId: request.requestId,
        targetDeviceId: request.targetDeviceId,
      },
    });
  }
}
