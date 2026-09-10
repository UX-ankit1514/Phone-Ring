import { TARGET_DEVICE_ID } from "@arnifi/contracts";
import { z } from "zod";

const deviceId = z.literal(TARGET_DEVICE_ID);

export const createPhoneRequestSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    targetDeviceId: deviceId,
  })
  .strict();

export const deviceActionSchema = z.object({ deviceId }).strict();

export const deviceEnrollmentSchema = z
  .object({
    deviceId,
    enrollmentCode: z.string().trim().min(6).max(128),
    appVersion: z.string().trim().min(1).max(32),
    deviceModel: z.string().trim().min(1).max(100),
  })
  .strict();

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);

export const deviceRegistrationSchema = z
  .object({
    deviceId,
    fcmToken: z.string().min(20).max(4096),
    appVersion: z.string().trim().min(1).max(32),
    deviceModel: z.string().trim().min(1).max(100),
    capabilities: z
      .object({
        ring: z.boolean(),
        vibration: z.boolean(),
        tts: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const heartbeatSchema = z
  .object({
    deviceId,
    appVersion: z.string().trim().min(1).max(32).optional(),
  })
  .strict();

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > 50) return null;
  if (/[<>\u0000-\u001F\u007F]/u.test(normalized)) return null;
  return normalized;
}
