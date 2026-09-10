import { createHash, timingSafeEqual } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { TARGET_DEVICE_ID, TARGET_DISPLAY_NAME } from "@arnifi/contracts";
import { errors } from "../errors";

export const deviceEnrollmentCode = defineSecret("DEVICE_ENROLLMENT_CODE");
export const appEnvironment = defineString("APP_ENVIRONMENT", {
  default: "dev",
  description: "Deployment environment returned to the target app.",
});

interface EnrollInput {
  deviceId: typeof TARGET_DEVICE_ID;
  enrollmentCode: string;
  appVersion: string;
  deviceModel: string;
}

export class DeviceEnrollmentService {
  async enroll(input: EnrollInput): Promise<{ customToken: string; environment: "dev" | "prod" }> {
    const configuredCode = deviceEnrollmentCode.value();
    if (!configuredCode || !safeCodeMatch(input.enrollmentCode, configuredCode)) {
      throw errors.enrollmentInvalid();
    }

    const environment = appEnvironment.value() === "prod" ? "prod" : "dev";
    const auth = getAuth();
    const db = getFirestore();
    const uid = `target-${input.deviceId}`;
    const codeHash = sha256(configuredCode);

    try {
      await auth.getUser(uid);
    } catch (error) {
      if ((error as { code?: string }).code === "auth/user-not-found") {
        await auth.createUser({ uid, displayName: TARGET_DISPLAY_NAME, disabled: false });
      } else {
        throw error;
      }
    }
    await auth.setCustomUserClaims(uid, { role: "target", deviceId: input.deviceId, environment });

    await db.runTransaction(async (transaction) => {
      const enrollmentRef = db.collection("deviceEnrollments").doc(input.deviceId);
      const credentialRef = db.collection("deviceCredentials").doc(input.deviceId);
      const deviceRef = db.collection("devices").doc(input.deviceId);
      const enrollment = await transaction.get(enrollmentRef);
      if (enrollment.data()?.consumedCodeHash === codeHash) throw errors.enrollmentInvalid();

      transaction.set(enrollmentRef, {
        deviceId: input.deviceId,
        consumedCodeHash: codeHash,
        consumedAt: FieldValue.serverTimestamp(),
        environment,
      });
      transaction.set(credentialRef, {
        deviceId: input.deviceId,
        authUid: uid,
        enrolledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(deviceRef, {
        deviceId: input.deviceId,
        displayName: TARGET_DISPLAY_NAME,
        active: true,
        availability: "idle",
        // Remove fields written by older deployments so the status projection
        // remains safe to read under the Firestore rules below.
        deviceType: FieldValue.delete(),
        platform: FieldValue.delete(),
        appVersion: FieldValue.delete(),
        deviceModel: FieldValue.delete(),
        capabilities: FieldValue.delete(),
        enrolledAt: FieldValue.delete(),
        updatedAt: FieldValue.delete(),
        activeRequestExpiresAt: FieldValue.delete(),
      }, { merge: true });
      transaction.set(db.collection("deviceMetadata").doc(input.deviceId), {
        deviceId: input.deviceId,
        deviceType: "target",
        platform: "android",
        appVersion: input.appVersion,
        deviceModel: input.deviceModel,
        capabilities: { ring: true, vibration: true, tts: false },
        enrolledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return { customToken: await auth.createCustomToken(uid, { role: "target", deviceId: input.deviceId, environment }), environment };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeCodeMatch(candidate: string, configured: string): boolean {
  const left = Buffer.from(sha256(candidate.trim()), "hex");
  const right = Buffer.from(sha256(configured.trim()), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
