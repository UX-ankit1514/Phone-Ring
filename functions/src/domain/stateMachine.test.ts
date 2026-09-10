import { describe, expect, it } from "vitest";
import { ACTIVE_STATUSES, TERMINAL_STATUSES, assertTransition, canTransition } from "./stateMachine";

describe("phone request state machine", () => {
  it("accepts the canonical happy path", () => {
    expect(canTransition("created", "sent")).toBe(true);
    expect(canTransition("sent", "delivered")).toBe(true);
    expect(canTransition("delivered", "acknowledged")).toBe(true);
  });

  it("supports receipt and acknowledgement recovery", () => {
    expect(canTransition("created", "delivered")).toBe(true);
    expect(canTransition("created", "acknowledged")).toBe(true);
    expect(canTransition("sent", "acknowledged")).toBe(true);
  });

  it("keeps terminal states terminal", () => {
    for (const state of TERMINAL_STATUSES) {
      expect(() => assertTransition(state, "sent")).toThrow(/Cannot transition/);
    }
  });

  it("defines only created, sent, and delivered as active", () => {
    expect([...ACTIVE_STATUSES]).toEqual(["created", "sent", "delivered"]);
  });
});
