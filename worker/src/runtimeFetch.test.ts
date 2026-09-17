import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeFetch } from "./runtimeFetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("runtimeFetch", () => {
  it("invokes platform fetch with globalThis as its receiver", async () => {
    let receiver: unknown;
    globalThis.fetch = vi.fn(function (this: unknown) {
      receiver = this;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    await runtimeFetch("https://example.test");

    expect(receiver).toBe(globalThis);
  });
});
