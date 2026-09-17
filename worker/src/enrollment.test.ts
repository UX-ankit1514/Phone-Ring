import { beforeEach, describe, expect, it } from "vitest";
import { TARGET_DEVICE_ID } from "@arnifi/contracts";
import { AppError } from "./errors";
import { DeviceEnrollmentService } from "./enrollment";
import type { GoogleClient } from "./google";
import { FakeFirestore, TEST_ENV } from "./test/fakeFirestore";
import type { Env } from "./types";

const CODE = TEST_ENV.DEVICE_ENROLLMENT_CODE;
const INPUT = {
  deviceId: TARGET_DEVICE_ID,
  enrollmentCode: CODE,
  appVersion: "1.0.0",
  deviceModel: "SM-A155F",
} as const;

let fake: FakeFirestore;
let identities: Array<{ uid: string; claims: Record<string, unknown> }>;
let google: GoogleClient;
let tokenCreationError: Error | undefined;

function service(env: Env = TEST_ENV): DeviceEnrollmentService {
  return new DeviceEnrollmentService(env, google, fake.client(), () => new Date("2026-09-10T10:00:00Z"));
}

async function expectRejected(action: Promise<unknown>, code: string): Promise<void> {
  const error = await action.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

beforeEach(() => {
  fake = new FakeFirestore();
  identities = [];
  tokenCreationError = undefined;
  google = {
    async ensureTargetUser(uid: string, _displayName: string, claims: Record<string, unknown>) {
      identities.push({ uid, claims });
    },
    async createCustomToken(uid: string) {
      if (tokenCreationError) throw tokenCreationError;
      return `custom-token-for-${uid}`;
    },
  } as unknown as GoogleClient;
});

describe("device enrollment", () => {
  it("issues a device identity carrying the target claims", async () => {
    const result = await service().enroll(INPUT);

    expect(result.environment).toBe("dev");
    expect(result.customToken).toBe(`custom-token-for-target-${TARGET_DEVICE_ID}`);
    expect(identities[0]?.claims).toEqual({
      role: "target",
      deviceId: TARGET_DEVICE_ID,
      environment: "dev",
    });
  });

  it("activates the phone and records its metadata privately", async () => {
    await service().enroll(INPUT);

    expect(fake.read(`devices/${TARGET_DEVICE_ID}`)).toMatchObject({
      active: true,
      availability: "idle",
    });
    expect(Object.keys(fake.read(`devices/${TARGET_DEVICE_ID}`) ?? {})).not.toContain("deviceModel");
    expect(fake.read(`deviceMetadata/${TARGET_DEVICE_ID}`)?.deviceModel).toBe("SM-A155F");
    expect(fake.read(`deviceCredentials/${TARGET_DEVICE_ID}`)?.authUid).toBe(
      `target-${TARGET_DEVICE_ID}`,
    );
  });

  it("never stores the enrollment code itself", async () => {
    await service().enroll(INPUT);

    const enrollment = fake.read(`deviceEnrollments/${TARGET_DEVICE_ID}`);
    expect(String(enrollment?.consumedCodeHash)).toHaveLength(64);
    expect(JSON.stringify(enrollment)).not.toContain(CODE);
  });

  it("burns the code so it cannot be replayed", async () => {
    await service().enroll(INPUT);
    await expectRejected(service().enroll(INPUT), "DEVICE_ENROLLMENT_INVALID");
  });

  it("does not burn the code when custom-token creation fails", async () => {
    tokenCreationError = new Error("signing unavailable");

    await expectRejected(service().enroll(INPUT), "DEVICE_TOKEN_SETUP_FAILED");
    expect(fake.read(`deviceEnrollments/${TARGET_DEVICE_ID}`)).toBeNull();

    tokenCreationError = undefined;
    await expect(service().enroll(INPUT)).resolves.toMatchObject({
      customToken: `custom-token-for-target-${TARGET_DEVICE_ID}`,
    });
  });

  it("rejects a wrong code", async () => {
    await expectRejected(
      service().enroll({ ...INPUT, enrollmentCode: "definitely-not-the-code" }),
      "DEVICE_ENROLLMENT_INVALID",
    );
    expect(identities).toHaveLength(0);
  });

  it("rejects enrollment when no code is configured", async () => {
    await expectRejected(
      service({ ...TEST_ENV, DEVICE_ENROLLMENT_CODE: "" }).enroll(INPUT),
      "DEVICE_ENROLLMENT_INVALID",
    );
  });

  it("stamps the production environment on a production deployment", async () => {
    const result = await service({ ...TEST_ENV, APP_ENVIRONMENT: "prod" }).enroll(INPUT);

    expect(result.environment).toBe("prod");
    expect(identities[0]?.claims.environment).toBe("prod");
  });
});
