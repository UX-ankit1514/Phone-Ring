import { AppError, errors } from "./errors";
import { serviceAccount, signJwt } from "./crypto";
import { verifyIdToken } from "./idToken";
import { runtimeFetch } from "./runtimeFetch";
import type { Env, Principal } from "./types";

type Fetch = typeof fetch;

let cachedToken: { key: string; value: string; expiresAt: number } | undefined;

/** Test seam: drops the cached Google OAuth access token. */
export function resetAccessTokenCache(): void {
  cachedToken = undefined;
}

export class GoogleClient {
  constructor(
    private readonly env: Env,
    private readonly fetcher: Fetch = runtimeFetch,
  ) {}

  async accessToken(): Promise<string> {
    const account = serviceAccount(this.env);
    const cacheKey = `${this.env.FIREBASE_PROJECT_ID}:${account.clientEmail}`;
    if (cachedToken?.key === cacheKey && cachedToken.expiresAt > Date.now() + 60_000) {
      return cachedToken.value;
    }
    const assertion = await signJwt(
      {
        iss: account.clientEmail,
        sub: account.clientEmail,
        aud: "https://oauth2.googleapis.com/token",
        scope: [
          "https://www.googleapis.com/auth/datastore",
          "https://www.googleapis.com/auth/firebase.messaging",
          "https://www.googleapis.com/auth/identitytoolkit",
        ].join(" "),
      },
      account,
    );
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!response.ok || !data.access_token) {
      throw new AppError("GOOGLE_AUTH_FAILED", "Google service authentication failed.", 503, true);
    }
    cachedToken = {
      key: cacheKey,
      value: data.access_token,
      expiresAt: Date.now() + Math.max(60, data.expires_in ?? 3_600) * 1_000,
    };
    return cachedToken.value;
  }

  verifyFirebaseIdToken(idToken: string): Promise<Principal> {
    return verifyIdToken(idToken, this.env.FIREBASE_PROJECT_ID, this.fetcher);
  }

  /** Creates the target-device identity if needed and stamps its custom claims. */
  async ensureTargetUser(
    uid: string,
    displayName: string,
    customClaims: Record<string, unknown>,
  ): Promise<void> {
    const token = await this.accessToken();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const project = encodeURIComponent(this.env.FIREBASE_PROJECT_ID);

    const lookup = await this.fetcher(
      `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:lookup`,
      { method: "POST", headers, body: JSON.stringify({ localId: [uid] }) },
    );
    const lookupData = (await lookup.json()) as { users?: Array<{ localId?: string }> };
    if (!lookupData.users?.some((user) => user.localId === uid)) {
      const created = await this.fetcher(
        `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:signUp`,
        { method: "POST", headers, body: JSON.stringify({ localId: uid, displayName, disabled: false }) },
      );
      if (!created.ok) {
        throw new AppError(
          "DEVICE_AUTH_SETUP_FAILED",
          "The target device identity could not be created.",
          503,
          true,
        );
      }
    }

    const updated = await this.fetcher(
      `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:update`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          localId: uid,
          displayName,
          customAttributes: JSON.stringify(customClaims),
          disableUser: false,
        }),
      },
    );
    if (!updated.ok) {
      throw new AppError(
        "DEVICE_AUTH_SETUP_FAILED",
        "The target device identity could not be configured.",
        503,
        true,
      );
    }
  }

  /** Mints a Firebase custom token; the device exchanges it for an ID token. */
  async createCustomToken(uid: string, claims: Record<string, unknown>): Promise<string> {
    const account = serviceAccount(this.env);
    return signJwt(
      {
        iss: account.clientEmail,
        sub: account.clientEmail,
        aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
        uid,
        claims,
      },
      account,
      Math.floor(Date.now() / 1_000),
      3_600,
    );
  }

  async sendFcm(
    token: string,
    data: Record<string, string>,
    ttlSeconds: number,
    collapseKey: string,
  ): Promise<string> {
    const accessToken = await this.accessToken();
    const response = await this.fetcher(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.env.FIREBASE_PROJECT_ID)}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            data,
            android: {
              priority: "HIGH",
              ttl: `${Math.max(1, Math.min(2_419_200, Math.round(ttlSeconds)))}s`,
              collapse_key: collapseKey,
            },
          },
        }),
      },
    );
    const result = (await response.json()) as { name?: string; error?: { status?: string } };
    if (!response.ok || !result.name) {
      // The provider payload can echo the device token, so only the coarse
      // status code is surfaced to callers and the audit trail.
      throw new AppError(
        "FCM_PROVIDER_ERROR",
        "FCM rejected the message.",
        503,
        true,
        { providerStatus: result.error?.status ?? String(response.status) },
      );
    }
    return result.name;
  }
}

export function bearerToken(request: Request): string {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/iu);
  if (!match?.[1]) throw errors.unauthenticated();
  return match[1];
}

/** An employee is a verified Google Workspace account in the allowed domain. */
export async function requireTargetter(
  request: Request,
  client: GoogleClient,
  env: Env,
): Promise<Principal> {
  const principal = await client.verifyFirebaseIdToken(bearerToken(request));
  const email = principal.email?.toLowerCase();
  const domain = env.ALLOWED_WORKSPACE_DOMAIN.toLowerCase();
  if (
    !principal.emailVerified ||
    !email?.endsWith(`@${domain}`) ||
    principal.signInProvider !== "google.com"
  ) {
    throw errors.forbidden(`Use a verified @${domain} Google Workspace account.`);
  }
  return principal;
}

/** The shared phone authenticates with the custom-claim identity it enrolled with. */
export async function requireTargetDevice(
  request: Request,
  client: GoogleClient,
): Promise<Principal> {
  const principal = await client.verifyFirebaseIdToken(bearerToken(request));
  if (principal.claims.role !== "target" || typeof principal.claims.deviceId !== "string") {
    throw errors.forbidden("A trusted target device identity is required.");
  }
  return principal;
}

export function assertPrincipalDevice(deviceId: string, principal: Principal): void {
  if (principal.claims.role !== "target" || principal.claims.deviceId !== deviceId) {
    throw errors.forbidden("The authenticated target does not match this device.");
  }
}
