import { AppError } from "./errors";
import type { Env } from "./types";

const encoder = new TextEncoder();

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}

export function serviceAccount(env: Env): ServiceAccount {
  try {
    const parsed = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as Record<string, unknown>;
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") throw new Error();
    return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
  } catch {
    throw new AppError("SERVER_CONFIGURATION", "The service account is not configured.", 500);
  }
}

export function base64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares two secrets in constant time. Both sides are hashed first, so the
 * comparison always runs over two equal-length digests and leaks neither the
 * length nor the content of the configured code.
 */
export async function secureEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left.trim()), sha256(right.trim())]);
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function signJwt(
  claims: Record<string, unknown>,
  account: ServiceAccount,
  nowSeconds = Math.floor(Date.now() / 1_000),
  lifetimeSeconds = 3_600,
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64Url(
    JSON.stringify({ iat: nowSeconds, exp: nowSeconds + lifetimeSeconds, ...claims }),
  );
  const unsigned = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(account.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  return `${unsigned}.${base64Url(signature)}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const raw = pem.replace(/\\n/gu, "\n").replace(/-----[^-]+-----/gu, "").replace(/\s/gu, "");
  try {
    const binary = atob(raw);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
  } catch {
    throw new AppError("SERVER_CONFIGURATION", "The service-account private key is invalid.", 500);
  }
}
