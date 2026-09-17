import { errors } from "./errors";
import { runtimeFetch } from "./runtimeFetch";
import type { Principal } from "./types";

const JWK_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const CLOCK_SKEW_SECONDS = 60;

interface JsonWebKey_ {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
}

interface IdTokenPayload {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  auth_time?: number;
  email?: string;
  email_verified?: boolean;
  firebase?: { sign_in_provider?: string };
  [claim: string]: unknown;
}

let keyCache: { keys: Map<string, CryptoKey>; expiresAt: number } | undefined;

/**
 * Verifies a Firebase ID token the way the Admin SDK does, but with Web Crypto
 * so it runs on Workers. Google's signing keys are cached for as long as the
 * key endpoint says they are valid, so the hot path makes no extra round trip.
 */
export async function verifyIdToken(
  token: string,
  projectId: string,
  fetcher: typeof fetch = runtimeFetch,
  now: () => number = Date.now,
): Promise<Principal> {
  const segments = token.split(".");
  if (segments.length !== 3) throw errors.unauthenticated();
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];

  const header = decodeJson<{ alg?: string; kid?: string; typ?: string }>(encodedHeader);
  if (header.alg !== "RS256" || !header.kid) throw errors.unauthenticated();

  const key = await publicKey(header.kid, fetcher, now);
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!verified) throw errors.unauthenticated();

  const payload = decodeJson<IdTokenPayload>(encodedPayload);
  const seconds = Math.floor(now() / 1_000);
  const valid =
    payload.aud === projectId &&
    payload.iss === `https://securetoken.google.com/${projectId}` &&
    typeof payload.sub === "string" &&
    payload.sub.length > 0 &&
    typeof payload.exp === "number" &&
    payload.exp > seconds - CLOCK_SKEW_SECONDS &&
    typeof payload.iat === "number" &&
    payload.iat <= seconds + CLOCK_SKEW_SECONDS;
  if (!valid) throw errors.unauthenticated();

  return {
    uid: payload.sub as string,
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
    signInProvider: payload.firebase?.sign_in_provider ?? "",
    claims: payload as Record<string, unknown>,
  };
}

/** Test seam: drops the cached Google signing keys. */
export function resetIdTokenKeyCache(): void {
  keyCache = undefined;
}

async function publicKey(
  kid: string,
  fetcher: typeof fetch,
  now: () => number,
): Promise<CryptoKey> {
  const cached = keyCache && keyCache.expiresAt > now() ? keyCache.keys.get(kid) : undefined;
  if (cached) return cached;

  const response = await fetcher(JWK_URL, { method: "GET" });
  if (!response.ok) throw errors.unauthenticated();
  const body = (await response.json()) as { keys?: JsonWebKey_[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA" || !jwk.n || !jwk.e) continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  keyCache = { keys, expiresAt: now() + maxAgeMs(response.headers.get("cache-control")) };
  const key = keys.get(kid);
  if (!key) throw errors.unauthenticated();
  return key;
}

function maxAgeMs(cacheControl: string | null): number {
  const seconds = Number(cacheControl?.match(/max-age=(\d+)/u)?.[1] ?? 0);
  return Math.max(60, Math.min(seconds || 3_600, 86_400)) * 1_000;
}

function decodeJson<T>(segment: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
  } catch {
    throw errors.unauthenticated();
  }
}

function base64UrlToBytes(segment: string): ArrayBuffer {
  const padded = segment.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}
