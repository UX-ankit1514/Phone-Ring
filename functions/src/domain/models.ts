import type { PhoneRequestStatus, RequestedBy, TargetPublicState } from "@arnifi/contracts";

export interface PhoneRequestRecord {
  requestId: string;
  clientRequestId: string;
  targetDeviceId: string;
  requestedBy: RequestedBy;
  status: PhoneRequestStatus;
  createdAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  acknowledgedAt: Date | null;
  cancelledAt: Date | null;
  expiresAt: Date;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface SharedPhoneConfig {
  targetDeviceId: string;
  ringDurationSeconds: number;
  requestTimeoutSeconds: number;
  targetterCooldownSeconds: number;
  allowConcurrentRequests: boolean;
  vibrationEnabled: boolean;
  ttsEnabled: boolean;
  deliveryTimeoutSeconds: number;
}

export interface TargetDeviceRecord {
  deviceId: string;
  displayName: string;
  active: boolean;
  fcmToken: string;
  lastSeenAt: Date | null;
}

export interface CreateCommand {
  uid: string;
  clientRequestId: string;
  targetDeviceId: string;
}

export interface ReservedRequest {
  request: PhoneRequestRecord;
  config: SharedPhoneConfig;
  device: TargetDeviceRecord;
  idempotentReplay: boolean;
}

export interface RegisteredDevice {
  deviceId: string;
  fcmToken: string;
  appVersion: string;
  deviceModel: string;
  capabilities?: {
    ring: boolean;
    vibration: boolean;
    tts: boolean;
  };
}

export interface PhoneBellRepository {
  reserveRequest(command: CreateCommand): Promise<ReservedRequest>;
  markSent(requestId: string): Promise<PhoneRequestRecord>;
  markFailed(requestId: string, code: string, message: string): Promise<PhoneRequestRecord>;
  markDelivered(requestId: string, deviceId: string): Promise<PhoneRequestRecord>;
  acknowledge(requestId: string, deviceId: string): Promise<PhoneRequestRecord>;
  cancel(requestId: string, uid: string): Promise<{ request: PhoneRequestRecord; deviceToken: string | null }>;
  expire(requestId: string): Promise<PhoneRequestRecord | null>;
  sweepExpired(limit: number): Promise<number>;
  recordEvent(requestId: string, event: string, attributes?: Record<string, unknown>): Promise<void>;
  registerDevice(device: RegisteredDevice): Promise<void>;
  heartbeat(deviceId: string, appVersion?: string): Promise<void>;
  getTargetPublicState(deviceId: string): Promise<TargetPublicState>;
}
