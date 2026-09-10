import type {
  PhoneRequestStatus,
  RequestedBy,
  TARGET_DEVICE_ID,
} from "@arnifi/contracts";

export interface Env {
  APP_ENVIRONMENT: "dev" | "prod";
  FIREBASE_PROJECT_ID: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  DEVICE_ENROLLMENT_CODE: string;
  ALLOWED_WORKSPACE_DOMAIN: string;
  TARGET_DEVICE_ID: string;
}

export interface Principal {
  uid: string;
  email?: string;
  emailVerified: boolean;
  signInProvider: string;
  claims: Record<string, unknown>;
}

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
  targetDeviceId: typeof TARGET_DEVICE_ID;
}

export interface ReservedRequest {
  request: PhoneRequestRecord;
  config: SharedPhoneConfig;
  device: TargetDeviceRecord;
  idempotentReplay: boolean;
}

export interface RegisteredDevice {
  deviceId: typeof TARGET_DEVICE_ID;
  fcmToken: string;
  appVersion: string;
  deviceModel: string;
  capabilities?: { ring: boolean; vibration: boolean; tts: boolean };
}

export interface FirestoreDocument {
  name: string;
  fields?: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
}

export type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

export interface FirestoreWrite {
  update?: FirestoreDocument;
  updateMask?: { fieldPaths: string[] };
  delete?: string;
  currentDocument?: { exists?: boolean; updateTime?: string };
}
