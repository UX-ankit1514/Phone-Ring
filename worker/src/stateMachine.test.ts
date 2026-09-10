import { describe, expect, it } from "vitest";
import { PHONE_REQUEST_STATUSES } from "@arnifi/contracts";
import { AppError } from "./errors";
import { ACTIVE_STATUSES, TERMINAL_STATUSES, assertTransition, canTransition } from "./stateMachine";

describe("phone request state machine", () => {
  it("follows the happy path", () => {
    expect(canTransition("created", "sent")).toBe(true);
    expect(canTransition("sent", "delivered")).toBe(true);
    expect(canTransition("delivered", "acknowledged")).toBe(true);
  });

  it("never leaves a terminal state", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of PHONE_REQUEST_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("never moves backwards", () => {
    expect(canTransition("delivered", "sent")).toBe(false);
    expect(canTransition("sent", "created")).toBe(false);
  });

  it("cannot expire a request that was never dispatched", () => {
    expect(canTransition("created", "expired")).toBe(false);
    expect(canTransition("created", "failed")).toBe(true);
  });

  it("cannot fail a request the phone already received", () => {
    expect(canTransition("delivered", "failed")).toBe(false);
  });

  it("classifies every status as active or terminal", () => {
    for (const status of PHONE_REQUEST_STATUSES) {
      expect(ACTIVE_STATUSES.has(status) !== TERMINAL_STATUSES.has(status)).toBe(true);
    }
  });

  it("raises a conflict for an illegal transition", () => {
    expect(() => assertTransition("acknowledged", "cancelled")).toThrow(AppError);
    try {
      assertTransition("acknowledged", "cancelled");
    } catch (error) {
      expect((error as AppError).code).toBe("INVALID_STATE_TRANSITION");
      expect((error as AppError).status).toBe(409);
    }
  });
});
