import express, { type NextFunction, type Request, type Response } from "express";
import { getApps, initializeApp } from "firebase-admin/app";
import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { AppError, errors } from "./errors";
import { assertPrincipalDevice, requireTargetDevice, requireTargetter } from "./auth";
import { FirestorePhoneBellRepository } from "./repositories/firestorePhoneBellRepository";
import { serializePhoneRequest } from "./serialization";
import { FirebaseTaskQueueExpiryScheduler } from "./services/expiryScheduler";
import { DeviceEnrollmentService, appEnvironment, deviceEnrollmentCode } from "./services/deviceEnrollmentService";
import { PhoneRequestService } from "./services/phoneRequestService";
import { FirebasePushNotificationService } from "./services/pushNotificationService";
import {
  createPhoneRequestSchema,
  deviceActionSchema,
  deviceEnrollmentSchema,
  deviceRegistrationSchema,
  heartbeatSchema,
  requestIdSchema,
} from "./validation";

if (getApps().length === 0) initializeApp();

const repository = new FirestorePhoneBellRepository();
const requests = new PhoneRequestService(
  repository,
  new FirebasePushNotificationService(),
  new FirebaseTaskQueueExpiryScheduler(),
);
const enrollment = new DeviceEnrollmentService();
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb", strict: true }));
app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && allowedOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  next();
});

app.get("/api/v1/health", (_request, response) => {
  response.json({ success: true, service: "arnifi-phone-bell", environment: appEnvironment.value() });
});

app.post("/api/v1/devices/enroll", asyncRoute(async (request, response) => {
  const input = parse(deviceEnrollmentSchema, request.body);
  const result = await enrollment.enroll(input);
  logger.info("DEVICE_ENROLLED", { deviceId: input.deviceId, environment: result.environment });
  response.status(201).json({
    success: true,
    customToken: result.customToken,
    deviceId: input.deviceId,
    environment: result.environment,
  });
}));

app.post("/api/v1/devices/register", requireTargetDevice, asyncRoute(async (request, response) => {
  const input = parse(deviceRegistrationSchema, request.body);
  assertPrincipalDevice(input.deviceId, request.principal);
  await repository.registerDevice(input);
  await repository.recordEvent(`device:${input.deviceId}`, "DEVICE_REGISTERED", {
    deviceId: input.deviceId,
    appVersion: input.appVersion,
  });
  response.json({ success: true });
}));

app.post("/api/v1/devices/heartbeat", requireTargetDevice, asyncRoute(async (request, response) => {
  const input = parse(heartbeatSchema, request.body);
  assertPrincipalDevice(input.deviceId, request.principal);
  await repository.heartbeat(input.deviceId, input.appVersion);
  response.json({ success: true });
}));

app.get("/api/v1/devices/:deviceId/status", requireTargetter, asyncRoute(async (request, response) => {
  const deviceId = parse(deviceActionSchema, { deviceId: request.params.deviceId }).deviceId;
  response.json({ success: true, device: await repository.getTargetPublicState(deviceId) });
}));

app.post("/api/v1/phone-requests", requireTargetter, asyncRoute(async (request, response) => {
  const input = parse(createPhoneRequestSchema, request.body);
  const result = await requests.create({ uid: request.principal!.uid, ...input });
  response.status(result.idempotentReplay ? 200 : 201).json(result);
}));

app.post("/api/v1/phone-requests/:id/delivered", requireTargetDevice, asyncRoute(async (request, response) => {
  const requestId = parse(requestIdSchema, request.params.id);
  const input = parse(deviceActionSchema, request.body);
  assertPrincipalDevice(input.deviceId, request.principal);
  const updated = await requests.delivered(requestId, input.deviceId);
  response.json({ success: true, request: serializePhoneRequest(updated) });
}));

app.post("/api/v1/phone-requests/:id/acknowledge", requireTargetDevice, asyncRoute(async (request, response) => {
  const requestId = parse(requestIdSchema, request.params.id);
  const input = parse(deviceActionSchema, request.body);
  assertPrincipalDevice(input.deviceId, request.principal);
  const updated = await requests.acknowledge(requestId, input.deviceId);
  response.json({ success: true, request: serializePhoneRequest(updated) });
}));

app.post("/api/v1/phone-requests/:id/cancel", requireTargetter, asyncRoute(async (request, response) => {
  const requestId = parse(requestIdSchema, request.params.id);
  const updated = await requests.cancel(requestId, request.principal!.uid);
  response.json({ success: true, request: serializePhoneRequest(updated) });
}));

app.use((_request, _response, next) => next(errors.requestNotFound()));
app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
  const appError = error instanceof AppError
    ? error
    : new AppError("INTERNAL", "The request could not be completed.", 500, true);
  logger.error("API_ERROR", {
    code: appError.code,
    status: appError.status,
    path: request.path,
    method: request.method,
    requestId: typeof request.params.id === "string" ? request.params.id : undefined,
  });
  const retryAfterSeconds = numberDetail(appError.details?.retryAfterSeconds);
  if (retryAfterSeconds) response.setHeader("Retry-After", String(retryAfterSeconds));
  response.status(appError.status).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      ...(appError.details ? { details: appError.details } : {}),
    },
  });
});

export const api = onRequest(
  {
    region: "asia-south1",
    secrets: [deviceEnrollmentCode],
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 10,
  },
  app,
);

export const expirePhoneRequest = onTaskDispatched(
  {
    region: "asia-south1",
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 10, maxBackoffSeconds: 60 },
    rateLimits: { maxConcurrentDispatches: 10 },
  },
  async (task) => {
    const requestId = parse(requestIdSchema, task.data.requestId);
    await repository.expire(requestId);
  },
);

export const sweepExpiredPhoneRequests = onSchedule(
  { region: "asia-south1", schedule: "every 1 minutes", timeoutSeconds: 60, memory: "256MiB" },
  async () => {
    const expiredCount = await repository.sweepExpired(200);
    logger.info("EXPIRY_SWEEP_COMPLETED", { expiredCount });
  },
);

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => void handler(request, response).catch(next);
}

function parse<T>(schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { flatten(): unknown } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw errors.invalidRequest({ validation: result.error.flatten() });
  return result.data;
}

function allowedOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    return (
      (protocol === "https:" && (hostname === "phone.arnifi.com" || hostname.endsWith(".web.app") || hostname.endsWith(".firebaseapp.com"))) ||
      (protocol === "http:" && (hostname === "127.0.0.1" || hostname === "localhost"))
    );
  } catch {
    return false;
  }
}

function numberDetail(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
