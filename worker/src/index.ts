import { TARGET_DEVICE_ID } from "@arnifi/contracts";
import { DeviceEnrollmentService } from "./enrollment";
import { AppError, errorResponse, errors } from "./errors";
import { FirestoreRest } from "./firestore";
import {
  GoogleClient,
  assertPrincipalDevice,
  requireTargetDevice,
  requireTargetter,
} from "./google";
import { FcmPushSender } from "./push";
import { PhoneBellRepository } from "./repository";
import { serializePhoneRequest } from "./serialization";
import { PhoneRequestService } from "./service";
import type { Env } from "./types";
import {
  createPhoneRequestSchema,
  deviceActionSchema,
  deviceEnrollmentSchema,
  deviceRegistrationSchema,
  heartbeatSchema,
  parse,
  requestIdSchema,
} from "./validation";

const MAX_BODY_BYTES = 16 * 1_024;
const SWEEP_LIMIT = 200;
const PURGE_LIMIT = 100;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

interface Context {
  env: Env;
  google: GoogleClient;
  repository: PhoneBellRepository;
  requests: PhoneRequestService;
  enrollment: DeviceEnrollmentService;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, ...SECURITY_HEADERS } });
    }

    let response: Response;
    try {
      response = await route(request, buildContext(env));
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) {
        console.error(
          JSON.stringify({
            event: "API_ERROR",
            code: error instanceof AppError ? error.code : "INTERNAL",
            path: new URL(request.url).pathname,
            method: request.method,
          }),
        );
      }
      response = errorResponse(error);
    }

    const headers = new Headers(response.headers);
    for (const [key, header] of Object.entries({ ...cors, ...SECURITY_HEADERS })) {
      headers.set(key, header);
    }
    return new Response(response.body, { status: response.status, headers });
  },

  /**
   * Replaces the Cloud Tasks expiry queue and the Firestore TTL policies, both
   * of which need a billing account. Runs every minute.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const repository = buildContext(env).repository;
    const expiredCount = await repository.sweepExpired(SWEEP_LIMIT);
    const purgedCount = await repository.purgeExpiredDocuments(PURGE_LIMIT);
    console.log(JSON.stringify({ event: "EXPIRY_SWEEP_COMPLETED", expiredCount, purgedCount }));
  },
};

function buildContext(env: Env): Context {
  const google = new GoogleClient(env);
  const db = new FirestoreRest(env, google);
  const repository = new PhoneBellRepository(db, env.TARGET_DEVICE_ID || TARGET_DEVICE_ID);
  return {
    env,
    google,
    repository,
    requests: new PhoneRequestService(repository, new FcmPushSender(google)),
    enrollment: new DeviceEnrollmentService(env, google, db),
  };
}

async function route(request: Request, context: Context): Promise<Response> {
  const { pathname } = new URL(request.url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments[1] !== "v1") throw errors.routeNotFound();
  const path = segments.slice(2);
  const { method } = request;

  if (method === "GET" && match(path, ["health"])) {
    return Response.json({
      success: true,
      service: "arnifi-phone-bell",
      environment: context.env.APP_ENVIRONMENT,
    });
  }

  if (method === "POST" && match(path, ["devices", "enroll"])) {
    const input = parse(deviceEnrollmentSchema, await body(request));
    const result = await context.enrollment.enroll(input);
    console.log(
      JSON.stringify({ event: "DEVICE_ENROLLED", deviceId: input.deviceId, environment: result.environment }),
    );
    return Response.json(
      {
        success: true,
        customToken: result.customToken,
        deviceId: input.deviceId,
        environment: result.environment,
      },
      { status: 201 },
    );
  }

  if (method === "POST" && match(path, ["devices", "register"])) {
    const principal = await requireTargetDevice(request, context.google);
    const input = parse(deviceRegistrationSchema, await body(request));
    assertPrincipalDevice(input.deviceId, principal);
    await context.repository.registerDevice(input);
    await context.repository.recordEvent(`device:${input.deviceId}`, "DEVICE_REGISTERED", {
      deviceId: input.deviceId,
      appVersion: input.appVersion,
    });
    return Response.json({ success: true });
  }

  if (method === "POST" && match(path, ["devices", "heartbeat"])) {
    const principal = await requireTargetDevice(request, context.google);
    const input = parse(heartbeatSchema, await body(request));
    assertPrincipalDevice(input.deviceId, principal);
    await context.repository.heartbeat(input.deviceId, input.appVersion);
    return Response.json({ success: true });
  }

  if (method === "GET" && path.length === 3 && path[0] === "devices" && path[2] === "status") {
    await requireTargetter(request, context.google, context.env);
    const { deviceId } = parse(deviceActionSchema, { deviceId: path[1] });
    return Response.json({
      success: true,
      device: await context.repository.getTargetPublicState(deviceId),
    });
  }

  if (method === "POST" && match(path, ["phone-requests"])) {
    const principal = await requireTargetter(request, context.google, context.env);
    const input = parse(createPhoneRequestSchema, await body(request));
    const result = await context.requests.create({ uid: principal.uid, ...input });
    return Response.json(result, { status: result.idempotentReplay ? 200 : 201 });
  }

  if (method === "POST" && path.length === 3 && path[0] === "phone-requests") {
    const requestId = parse(requestIdSchema, path[1]);
    const action = path[2];

    if (action === "delivered" || action === "acknowledge") {
      const principal = await requireTargetDevice(request, context.google);
      const input = parse(deviceActionSchema, await body(request));
      assertPrincipalDevice(input.deviceId, principal);
      const updated =
        action === "delivered"
          ? await context.requests.delivered(requestId, input.deviceId)
          : await context.requests.acknowledge(requestId, input.deviceId);
      return Response.json({ success: true, request: serializePhoneRequest(updated) });
    }

    if (action === "cancel") {
      const principal = await requireTargetter(request, context.google, context.env);
      const updated = await context.requests.cancel(requestId, principal.uid);
      return Response.json({ success: true, request: serializePhoneRequest(updated) });
    }
  }

  throw errors.routeNotFound();
}

function match(path: string[], expected: string[]): boolean {
  return path.length === expected.length && expected.every((segment, index) => path[index] === segment);
}

async function body(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw errors.invalidRequest({ reason: "Request body is too large." });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw errors.invalidRequest({ reason: "Request body is too large." });
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.invalidRequest({ reason: "Request body is not valid JSON." });
  }
}

export function isAllowedOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    return (
      (protocol === "https:" &&
        (hostname === "phone.arnifi.com" ||
          hostname.endsWith(".web.app") ||
          hostname.endsWith(".firebaseapp.com"))) ||
      (protocol === "http:" && (hostname === "127.0.0.1" || hostname === "localhost"))
    );
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "3600",
  };
}
