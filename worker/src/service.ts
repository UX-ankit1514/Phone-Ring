import type { CreatePhoneRequestResponse } from "@arnifi/contracts";
import { AppError, errors } from "./errors";
import type { PhoneBellRepository } from "./repository";
import type { PushSender } from "./push";
import type { CreateCommand, PhoneRequestRecord } from "./types";

export class PhoneRequestService {
  constructor(
    private readonly repository: PhoneBellRepository,
    private readonly push: PushSender,
  ) {}

  async create(command: CreateCommand): Promise<CreatePhoneRequestResponse> {
    const reserved = await this.repository.reserveRequest(command);
    if (reserved.idempotentReplay) {
      return {
        success: true,
        requestId: reserved.request.requestId,
        status: reserved.request.status,
        idempotentReplay: true,
      };
    }

    await this.repository.recordEvent(reserved.request.requestId, "FCM_SEND_STARTED");
    try {
      const messageId = await this.push.sendPhoneRequest(
        reserved.device.fcmToken,
        reserved.request,
        reserved.config,
      );
      const sent = await this.repository.markSent(reserved.request.requestId);
      if (sent.status === "failed" || sent.status === "expired") {
        // A slow send can race the expiry sweep. Do not report a terminal
        // request as successfully sent even if FCM accepted the message.
        throw errors.requestExpired();
      }
      await this.repository.recordEvent(sent.requestId, "FCM_SEND_SUCCEEDED", { messageId });
      return { success: true, requestId: sent.requestId, status: sent.status, idempotentReplay: false };
    } catch (error) {
      if (error instanceof AppError && error.code === "REQUEST_EXPIRED") throw error;
      const message = safeErrorMessage(error);
      await this.repository.markFailed(reserved.request.requestId, "FCM_SEND_FAILED", message);
      await this.repository.recordEvent(reserved.request.requestId, "FCM_SEND_FAILED", { message });
      throw errors.fcmFailed();
    }
  }

  delivered(requestId: string, deviceId: string): Promise<PhoneRequestRecord> {
    return this.repository.markDelivered(requestId, deviceId);
  }

  acknowledge(requestId: string, deviceId: string): Promise<PhoneRequestRecord> {
    return this.repository.acknowledge(requestId, deviceId);
  }

  async cancel(requestId: string, uid: string): Promise<PhoneRequestRecord> {
    const result = await this.repository.cancel(requestId, uid);
    if (result.deviceToken) {
      try {
        const messageId = await this.push.sendCancellation(result.deviceToken, result.request);
        await this.repository.recordEvent(requestId, "CANCEL_FCM_SENT", { messageId });
      } catch (error) {
        await this.repository.recordEvent(requestId, "CANCEL_FCM_FAILED", {
          message: safeErrorMessage(error),
        });
      }
    }
    return result.request;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error) {
    // Provider errors are persisted in the request/event audit trail. Keep
    // useful diagnostics while preventing accidental token disclosure if a
    // provider echoes request details in its message.
    return error.message
      .slice(0, 250)
      .replace(/(token|authorization|secret|password|api[_ -]?key)\s*[=:]\s*[^\s,;]+/giu, "$1=[redacted]");
  }
  return "Unknown error";
}
