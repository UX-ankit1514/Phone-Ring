import { describe, expect, it } from "vitest";
import { TARGET_DEVICE_ID } from "@arnifi/contracts";
import { AppError } from "./errors";
import {
  createPhoneRequestSchema,
  deviceRegistrationSchema,
  normalizeDisplayName,
  parse,
  requestIdSchema,
} from "./validation";

describe("normalizeDisplayName", () => {
  it("collapses whitespace and normalises unicode", () => {
    expect(normalizeDisplayName("  Rahul   Sharma ")).toBe("Rahul Sharma");
  });

  it("rejects names that are too short or too long", () => {
    expect(normalizeDisplayName("R")).toBeNull();
    expect(normalizeDisplayName("R".repeat(51))).toBeNull();
  });

  it("rejects markup and control characters", () => {
    expect(normalizeDisplayName("<script>alert(1)</script>")).toBeNull();
    expect(normalizeDisplayName(`Rahul${String.fromCharCode(7)}Sharma`)).toBeNull();
  });

  it("rejects a value that is not a string", () => {
    expect(normalizeDisplayName(42)).toBeNull();
    expect(normalizeDisplayName(undefined)).toBeNull();
  });
});

describe("request schemas", () => {
  it("accepts a well formed ring request", () => {
    const input = {
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      targetDeviceId: TARGET_DEVICE_ID,
    };
    expect(parse(createPhoneRequestSchema, input)).toEqual(input);
  });

  it("rejects a ring request for another device", () => {
    expect(() =>
      parse(createPhoneRequestSchema, {
        clientRequestId: "11111111-1111-4111-8111-111111111111",
        targetDeviceId: "someone-elses-phone",
      }),
    ).toThrow(AppError);
  });

  it("rejects a client request id that is not a uuid", () => {
    expect(() =>
      parse(createPhoneRequestSchema, { clientRequestId: "1", targetDeviceId: TARGET_DEVICE_ID }),
    ).toThrow(AppError);
  });

  it("rejects an implausibly short push token", () => {
    expect(() =>
      parse(deviceRegistrationSchema, {
        deviceId: TARGET_DEVICE_ID,
        fcmToken: "too-short",
        appVersion: "1.0.0",
        deviceModel: "SM-A155F",
      }),
    ).toThrow(AppError);
  });

  it("reports validation failures as a 400 with details", () => {
    const error = (() => {
      try {
        parse(requestIdSchema, "../../etc/passwd");
        return null;
      } catch (cause) {
        return cause as AppError;
      }
    })();

    expect(error?.status).toBe(400);
    expect(error?.code).toBe("INVALID_ARGUMENT");
    expect(error?.details).toHaveProperty("validation");
  });

  it("accepts a generated request id", () => {
    expect(parse(requestIdSchema, "req_0123456789abcdef0123456789abcdef")).toBe(
      "req_0123456789abcdef0123456789abcdef",
    );
  });
});
