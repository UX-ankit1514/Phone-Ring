import { describe, expect, it } from "vitest";
import { TARGET_DEVICE_ID } from "@arnifi/contracts";
import worker, { isAllowedOrigin } from "./index";
import { TEST_ENV } from "./test/fakeFirestore";

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`https://api.test${path}`, init), TEST_ENV);
}

describe("routing", () => {
  it("reports health without requiring a sign-in", async () => {
    const response = await call("/api/v1/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      service: "arnifi-phone-bell",
      environment: "dev",
    });
  });

  it("never caches API responses", async () => {
    const response = await call("/api/v1/health");

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns a structured error for an unknown route", async () => {
    const response = await call("/api/v1/not-a-route");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("rejects an unversioned path", async () => {
    expect((await call("/phone-requests", { method: "POST" })).status).toBe(404);
  });
});

describe("authentication", () => {
  it("requires a bearer token to ring the phone", async () => {
    const response = await call("/api/v1/phone-requests", {
      method: "POST",
      body: JSON.stringify({ clientRequestId: crypto.randomUUID(), targetDeviceId: TARGET_DEVICE_ID }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("requires a device identity to acknowledge a ring", async () => {
    const response = await call("/api/v1/phone-requests/req_1/acknowledge", { method: "POST" });

    expect(response.status).toBe(401);
  });

  it("requires a bearer token to read the phone status", async () => {
    expect((await call(`/api/v1/devices/${TARGET_DEVICE_ID}/status`)).status).toBe(401);
  });

  it("rejects a bearer token that is not a Firebase token", async () => {
    const response = await call("/api/v1/phone-requests", {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ clientRequestId: crypto.randomUUID(), targetDeviceId: TARGET_DEVICE_ID }),
    });

    expect(response.status).toBe(401);
  });
});

describe("request bodies", () => {
  it("rejects a body that is not valid JSON", async () => {
    const response = await call("/api/v1/devices/enroll", { method: "POST", body: "{oops" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  });

  it("rejects an oversized body before reading it", async () => {
    const response = await call("/api/v1/devices/enroll", {
      method: "POST",
      headers: { "content-length": "999999" },
      body: JSON.stringify({ deviceId: TARGET_DEVICE_ID }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects unknown fields in an enrollment request", async () => {
    const response = await call("/api/v1/devices/enroll", {
      method: "POST",
      body: JSON.stringify({
        deviceId: TARGET_DEVICE_ID,
        enrollmentCode: "a-long-enough-code",
        appVersion: "1.0.0",
        deviceModel: "SM-A155F",
        role: "admin",
      }),
    });

    expect(response.status).toBe(400);
  });
});

describe("CORS", () => {
  it("answers a preflight from the deployed web app", async () => {
    const response = await call("/api/v1/phone-requests", {
      method: "OPTIONS",
      headers: { origin: "https://arnifi-phone-bell-dev.web.app" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://arnifi-phone-bell-dev.web.app",
    );
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("does not answer a preflight from an unknown origin", async () => {
    const response = await call("/api/v1/phone-requests", {
      method: "OPTIONS",
      headers: { origin: "https://phishing.example.com" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows only the Arnifi domain, Firebase Hosting and local development", () => {
    expect(isAllowedOrigin("https://phone.arnifi.com")).toBe(true);
    expect(isAllowedOrigin("https://arnifi-phone-bell-prod.firebaseapp.com")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://phone.arnifi.com")).toBe(false);
    expect(isAllowedOrigin("https://arnifi.com.evil.example")).toBe(false);
    expect(isAllowedOrigin("not-a-url")).toBe(false);
  });
});
