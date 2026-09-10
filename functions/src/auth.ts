import type { RequestHandler } from "express";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { defineString } from "firebase-functions/params";
import { errors } from "./errors";

export const allowedWorkspaceDomain = defineString("ALLOWED_WORKSPACE_DOMAIN", {
  default: "arnifi.com",
  description: "Verified Google Workspace email domain allowed to create phone requests.",
});

declare global {
  namespace Express {
    interface Request {
      principal?: DecodedIdToken;
    }
  }
}

function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1] ?? null;
}

async function authenticate(header: string | undefined): Promise<DecodedIdToken> {
  const token = bearerToken(header);
  if (!token) throw errors.unauthenticated();
  try {
    return await getAuth().verifyIdToken(token);
  } catch {
    throw errors.unauthenticated();
  }
}

export const requireTargetter: RequestHandler = async (request, _response, next) => {
  try {
    const principal = await authenticate(request.headers.authorization);
    const email = principal.email?.toLowerCase();
    const domain = allowedWorkspaceDomain.value().toLowerCase();
    const provider = principal.firebase?.sign_in_provider;
    if (!principal.email_verified || !email?.endsWith(`@${domain}`) || provider !== "google.com") {
      throw errors.forbidden(`Use a verified @${domain} Google Workspace account.`);
    }
    request.principal = principal;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireTargetDevice: RequestHandler = async (request, _response, next) => {
  try {
    const principal = await authenticate(request.headers.authorization);
    if (principal.role !== "target" || typeof principal.deviceId !== "string") {
      throw errors.forbidden("A trusted target device identity is required.");
    }
    request.principal = principal;
    next();
  } catch (error) {
    next(error);
  }
};

export function assertPrincipalDevice(requestDeviceId: string, principal: DecodedIdToken | undefined): void {
  if (!principal || principal.role !== "target" || principal.deviceId !== requestDeviceId) {
    throw errors.forbidden("The authenticated target does not match this device.");
  }
}
