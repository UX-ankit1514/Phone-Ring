export const STORAGE_KEYS = {
  displayName: "arnifi_phone_display_name",
  pendingRequest: "arnifi_phone_pending_request",
} as const;

export interface PendingRequest {
  clientRequestId: string;
  requestId?: string;
  createdAt: number;
}

export function readDisplayName(): string | null {
  return localStorage.getItem(STORAGE_KEYS.displayName);
}

export function writeDisplayName(displayName: string): void {
  localStorage.setItem(STORAGE_KEYS.displayName, displayName);
}

export function readPendingRequest(): PendingRequest | null {
  try {
    const value = localStorage.getItem(STORAGE_KEYS.pendingRequest);
    if (!value) return null;
    const parsed = JSON.parse(value) as PendingRequest;
    if (
      typeof parsed.clientRequestId !== "string" ||
      typeof parsed.createdAt !== "number" ||
      Date.now() - parsed.createdAt > 5 * 60 * 1000
    ) {
      clearPendingRequest();
      return null;
    }
    return parsed;
  } catch {
    clearPendingRequest();
    return null;
  }
}

export function writePendingRequest(request: PendingRequest): void {
  localStorage.setItem(STORAGE_KEYS.pendingRequest, JSON.stringify(request));
}

export function clearPendingRequest(): void {
  localStorage.removeItem(STORAGE_KEYS.pendingRequest);
}

