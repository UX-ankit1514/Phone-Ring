import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingRequest,
  readPendingRequest,
  writePendingRequest,
} from "./storage";

describe("pending request storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a current idempotency key", () => {
    const value = { clientRequestId: "abc", requestId: "req-1", createdAt: Date.now() };
    writePendingRequest(value);
    expect(readPendingRequest()).toEqual(value);
  });

  it("drops stale pending actions", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    writePendingRequest({ clientRequestId: "abc", createdAt: 1 });
    expect(readPendingRequest()).toBeNull();
    clearPendingRequest();
    vi.restoreAllMocks();
  });
});

