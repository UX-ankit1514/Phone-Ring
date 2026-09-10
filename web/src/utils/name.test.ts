import { describe, expect, it } from "vitest";
import { firstName, validateDisplayName } from "./name";

describe("validateDisplayName", () => {
  it("normalizes and trims a valid name", () => {
    expect(validateDisplayName("  Rahul   Sharma  ")).toEqual({
      valid: true,
      value: "Rahul Sharma",
    });
  });

  it("enforces the lower and upper bounds", () => {
    expect(validateDisplayName("R").valid).toBe(false);
    expect(validateDisplayName("R".repeat(51)).valid).toBe(false);
    expect(validateDisplayName("RS").valid).toBe(true);
    expect(validateDisplayName("R".repeat(50)).valid).toBe(true);
  });

  it("rejects markup and control characters", () => {
    expect(validateDisplayName("<script>").valid).toBe(false);
    expect(validateDisplayName("Rahul\u0000Sharma").valid).toBe(false);
  });
});

describe("firstName", () => {
  it("returns the first token", () => {
    expect(firstName("Rahul Sharma")).toBe("Rahul");
  });
});

