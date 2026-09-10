import { describe, expect, it } from "vitest";
import { createPhoneRequestSchema, deviceEnrollmentSchema, normalizeDisplayName } from "./validation";

describe("validation", () => {
  it("accepts the one production target and a UUID", () => {
    expect(createPhoneRequestSchema.safeParse({
      clientRequestId: "78a08308-5c43-4b80-b155-12d28c652fee",
      targetDeviceId: "uae-phone-01",
    }).success).toBe(true);
  });

  it("rejects unknown targets and malformed enrollment", () => {
    expect(createPhoneRequestSchema.safeParse({ clientRequestId: "nope", targetDeviceId: "other" }).success).toBe(false);
    expect(deviceEnrollmentSchema.safeParse({ deviceId: "uae-phone-01", enrollmentCode: "x" }).success).toBe(false);
  });

  it("normalizes safe names and rejects markup", () => {
    expect(normalizeDisplayName("  Rahul   Sharma ")).toBe("Rahul Sharma");
    expect(normalizeDisplayName("<script>")).toBeNull();
    expect(normalizeDisplayName("R")).toBeNull();
  });
});
