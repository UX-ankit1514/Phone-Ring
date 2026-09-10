import type { PhoneRequest } from "@arnifi/contracts";
import type { PhoneRequestRecord } from "./domain/models";

export function serializePhoneRequest(request: PhoneRequestRecord): PhoneRequest {
  return {
    requestId: request.requestId,
    clientRequestId: request.clientRequestId,
    targetDeviceId: request.targetDeviceId,
    requestedBy: request.requestedBy,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    sentAt: request.sentAt?.toISOString() ?? null,
    deliveredAt: request.deliveredAt?.toISOString() ?? null,
    acknowledgedAt: request.acknowledgedAt?.toISOString() ?? null,
    cancelledAt: request.cancelledAt?.toISOString() ?? null,
    expiresAt: request.expiresAt.toISOString(),
    failureCode: request.failureCode,
    failureMessage: request.failureMessage,
  };
}
