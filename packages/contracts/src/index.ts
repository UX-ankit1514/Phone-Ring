export const TARGET_DEVICE_ID = "uae-phone-01" as const;
export const TARGET_DISPLAY_NAME = "UAE Calling Phone" as const;

export const LOCAL_STORAGE_KEYS = {
  displayName: "arnifi_phone_display_name",
  activeRequest: "arnifi_phone_active_request",
} as const;

export const PHONE_REQUEST_STATUSES = [
  "created",
  "sent",
  "delivered",
  "acknowledged",
  "cancelled",
  "expired",
  "failed",
] as const;

export type PhoneRequestStatus = (typeof PHONE_REQUEST_STATUSES)[number];

export const TERMINAL_PHONE_REQUEST_STATUSES = [
  "acknowledged",
  "cancelled",
  "expired",
  "failed",
] as const satisfies readonly PhoneRequestStatus[];

export interface RequestedBy {
  uid: string;
  name: string;
}

/** Wire representation. Firebase Timestamp values are serialized as ISO-8601 strings. */
export interface PhoneRequest {
  requestId: string;
  clientRequestId: string;
  targetDeviceId: string;
  requestedBy: RequestedBy;
  status: PhoneRequestStatus;
  createdAt: string;
  sentAt?: string | null;
  deliveredAt?: string | null;
  acknowledgedAt?: string | null;
  cancelledAt?: string | null;
  expiresAt: string;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export interface CreatePhoneRequestRequest {
  clientRequestId: string;
  targetDeviceId: string;
}

export interface CreatePhoneRequestResponse {
  success: true;
  requestId: string;
  status: PhoneRequestStatus;
  idempotentReplay: boolean;
}

export interface DeviceRequestRequest {
  deviceId: string;
}

export interface CancelPhoneRequestResponse {
  success: true;
  requestId: string;
  status: "cancelled";
}

export interface DeviceRegistrationRequest {
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

export interface DeviceEnrollmentRequest {
  deviceId: string;
  enrollmentCode: string;
  appVersion: string;
  deviceModel: string;
}

export interface DeviceEnrollmentResponse {
  success: true;
  customToken: string;
  deviceId: typeof TARGET_DEVICE_ID;
  environment: "dev" | "prod";
}

export interface DeviceHeartbeatRequest {
  deviceId: string;
  appVersion?: string;
}

export interface TargetPublicState {
  deviceId: string;
  displayName: string;
  active: boolean;
  availability: "idle" | "busy";
  health: "likely_online" | "unknown" | "possibly_offline" | "never_seen";
  lastSeenAt: string | null;
}

export interface ApiSuccessResponse {
  success: true;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    details?: Record<string, unknown>;
  };
}

export const REQUEST_EVENT_NAMES = [
  "REQUEST_CREATED",
  "FCM_SEND_STARTED",
  "FCM_SEND_SUCCEEDED",
  "FCM_SEND_FAILED",
  "FCM_RECEIVED",
  "RING_STARTED",
  "RING_STOPPED",
  "REQUEST_ACKNOWLEDGED",
  "REQUEST_CANCELLED",
  "CANCEL_FCM_SENT",
  "CANCEL_FCM_FAILED",
  "REQUEST_EXPIRED",
  "EXPIRY_TASK_ENQUEUE_FAILED",
  "DEVICE_ENROLLED",
  "DEVICE_REGISTERED",
  "DEVICE_HEARTBEAT",
] as const;

export type RequestEventName = (typeof REQUEST_EVENT_NAMES)[number];

export type PhoneRequestPushPayload = {
  type: "PHONE_REQUEST";
  requestId: string;
  targetDeviceId: string;
  requestedByName: string;
  expiresAtEpochMs: string;
  ringDurationSeconds: string;
  vibrationEnabled: string;
  ttsEnabled: string;
};

export type PhoneRequestCancelledPushPayload = {
  type: "PHONE_REQUEST_CANCELLED";
  requestId: string;
  targetDeviceId: string;
};

export type PhoneBellPushPayload =
  | PhoneRequestPushPayload
  | PhoneRequestCancelledPushPayload;

export interface PhoneRequestMutationResponse {
  success: true;
  request: PhoneRequest;
}
