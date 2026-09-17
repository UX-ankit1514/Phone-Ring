import { TARGET_DISPLAY_NAME, type DeviceEnrollmentRequest } from "@arnifi/contracts";
import { secureEqual, sha256 } from "./crypto";
import { AppError, errors } from "./errors";
import type { FirestoreRest } from "./firestore";
import type { GoogleClient } from "./google";
import type { Env } from "./types";

const DEVICE_LEGACY_FIELDS = [
  "deviceType",
  "platform",
  "appVersion",
  "deviceModel",
  "capabilities",
  "enrolledAt",
  "updatedAt",
  "activeRequestExpiresAt",
];

export class DeviceEnrollmentService {
  constructor(
    private readonly env: Env,
    private readonly google: GoogleClient,
    private readonly db: FirestoreRest,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Exchanges the one-time enrollment code for a Firebase custom token that
   * carries the target-device claims. The code is single use: its hash is
   * stored and a second attempt with the same code is rejected.
   */
  async enroll(
    input: DeviceEnrollmentRequest,
  ): Promise<{ customToken: string; environment: "dev" | "prod" }> {
    const configured = this.env.DEVICE_ENROLLMENT_CODE ?? "";
    if (!configured || !(await secureEqual(input.enrollmentCode, configured))) {
      throw errors.enrollmentInvalid();
    }

    const environment = this.env.APP_ENVIRONMENT === "prod" ? "prod" : "dev";
    const uid = `target-${input.deviceId}`;
    const claims = { role: "target", deviceId: input.deviceId, environment };
    const codeHash = await sha256(configured.trim());

    try {
      await this.google.ensureTargetUser(uid, TARGET_DISPLAY_NAME, claims);
    } catch (error) {
      logEnrollmentFailure("identity", error);
      throw error;
    }

    // Mint the Firebase token before consuming the one-time code. A transient
    // signing/runtime failure must not burn the only credential the device can
    // use to retry enrollment.
    let customToken: string;
    try {
      customToken = await this.google.createCustomToken(uid, claims);
    } catch (error) {
      logEnrollmentFailure("custom_token", error);
      throw new AppError(
        "DEVICE_TOKEN_SETUP_FAILED",
        "The target device identity could not be created.",
        503,
        true,
      );
    }

    try {
      await this.db.runTransaction([`deviceEnrollments/${input.deviceId}`], (documents) => {
        const enrollment = documents.get(`deviceEnrollments/${input.deviceId}`);
        if (enrollment?.consumedCodeHash === codeHash) throw errors.enrollmentInvalid();
        const now = this.now();
        return {
          value: undefined,
          writes: [
            this.db.setWrite(`deviceEnrollments/${input.deviceId}`, {
              deviceId: input.deviceId,
              consumedCodeHash: codeHash,
              consumedAt: now,
              environment,
            }),
            this.db.mergeWrite(`deviceCredentials/${input.deviceId}`, {
              deviceId: input.deviceId,
              authUid: uid,
              enrolledAt: now,
              updatedAt: now,
            }),
            this.db.mergeWrite(
              `devices/${input.deviceId}`,
              {
                deviceId: input.deviceId,
                displayName: TARGET_DISPLAY_NAME,
                active: true,
                availability: "idle",
              },
              DEVICE_LEGACY_FIELDS,
            ),
            this.db.mergeWrite(`deviceMetadata/${input.deviceId}`, {
              deviceId: input.deviceId,
              deviceType: "target",
              platform: "android",
              appVersion: input.appVersion,
              deviceModel: input.deviceModel,
              capabilities: { ring: true, vibration: true, tts: false },
              enrolledAt: now,
              updatedAt: now,
            }),
          ],
        };
      });
    } catch (error) {
      logEnrollmentFailure("firestore", error);
      throw error;
    }

    return { customToken, environment };
  }
}

function logEnrollmentFailure(stage: "identity" | "custom_token" | "firestore", error: unknown): void {
  console.error(JSON.stringify({
    event: "DEVICE_ENROLLMENT_FAILED",
    stage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : "Unknown error",
  }));
}
