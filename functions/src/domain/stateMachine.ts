import type { PhoneRequestStatus } from "@arnifi/contracts";
import { errors } from "../errors";

const transitions: Readonly<Record<PhoneRequestStatus, readonly PhoneRequestStatus[]>> = {
  created: ["sent", "delivered", "acknowledged", "cancelled", "failed"],
  sent: ["delivered", "acknowledged", "cancelled", "expired", "failed"],
  delivered: ["acknowledged", "cancelled", "expired"],
  acknowledged: [],
  cancelled: [],
  expired: [],
  failed: [],
};

export const ACTIVE_STATUSES = new Set<PhoneRequestStatus>(["created", "sent", "delivered"]);
export const TERMINAL_STATUSES = new Set<PhoneRequestStatus>([
  "acknowledged",
  "cancelled",
  "expired",
  "failed",
]);

export function canTransition(from: PhoneRequestStatus, to: PhoneRequestStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: PhoneRequestStatus, to: PhoneRequestStatus): void {
  if (!canTransition(from, to)) {
    throw errors.invalidTransition(from, to);
  }
}
