import type {
  ApiErrorResponse,
  CreatePhoneRequestRequest,
  CreatePhoneRequestResponse,
  PhoneRequest,
} from "@arnifi/contracts";
import { config } from "../config";

export class PhoneBellApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

async function apiFetch<T>(
  path: string,
  token: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const errorResponse =
      payload && typeof payload === "object" && "error" in payload
        ? (payload as ApiErrorResponse)
        : undefined;
    const error = errorResponse?.error;
    const retryAfterSeconds =
      typeof error?.details?.retryAfterSeconds === "number"
        ? error.details.retryAfterSeconds
        : undefined;
    throw new PhoneBellApiError(
      error?.code ?? "INTERNAL",
      error?.message ?? "The request could not be completed.",
      response.status,
      error?.retryable ?? response.status >= 500,
      retryAfterSeconds,
    );
  }
  return payload as T;
}

export function createPhoneRequest(
  token: string,
  body: CreatePhoneRequestRequest,
): Promise<CreatePhoneRequestResponse> {
  return apiFetch("/phone-requests", token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function cancelPhoneRequest(
  token: string,
  requestId: string,
): Promise<{ success: true; request: PhoneRequest }> {
  return apiFetch(`/phone-requests/${encodeURIComponent(requestId)}/cancel`, token, {
    method: "POST",
    body: "{}",
  });
}
