import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { resetIdTokenKeyCache, verifyIdToken } from "./idToken";

const PROJECT_ID = "arnifi-phone-bell-test";
const KID = "test-signing-key";
const NOW = new Date("2026-09-10T10:00:00.000Z").getTime();

let keyPair: CryptoKeyPair;
let jwkFetchCount: number;
let fetchKeys: typeof fetch;

async function signToken(payload: Record<string, unknown>, kid = KID): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = base64Url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    encoder.encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: "user-1",
    iat: Math.floor(NOW / 1_000) - 30,
    exp: Math.floor(NOW / 1_000) + 3_600,
    email: "rahul@arnifi.com",
    email_verified: true,
    firebase: { sign_in_provider: "google.com" },
    ...overrides,
  };
}

function verify(token: string): Promise<unknown> {
  return verifyIdToken(token, PROJECT_ID, fetchKeys, () => NOW);
}

async function expectUnauthenticated(token: string): Promise<void> {
  const error = await verify(token).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe("UNAUTHENTICATED");
}

function base64Url(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

beforeEach(async () => {
  resetIdTokenKeyCache();
  jwkFetchCount = 0;
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2_048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  fetchKeys = async () => {
    jwkFetchCount += 1;
    return Response.json(
      { keys: [{ kid: KID, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] },
      { headers: { "cache-control": "public, max-age=3600" } },
    );
  };
});

describe("verifyIdToken", () => {
  it("accepts a correctly signed Firebase token", async () => {
    const principal = (await verify(await signToken(validPayload()))) as {
      uid: string;
      email: string;
      emailVerified: boolean;
      signInProvider: string;
    };

    expect(principal.uid).toBe("user-1");
    expect(principal.email).toBe("rahul@arnifi.com");
    expect(principal.emailVerified).toBe(true);
    expect(principal.signInProvider).toBe("google.com");
  });

  it("exposes the custom claims the shared phone enrols with", async () => {
    const principal = (await verify(
      await signToken(validPayload({ role: "target", deviceId: "uae-phone-01" })),
    )) as { claims: Record<string, unknown> };

    expect(principal.claims.role).toBe("target");
    expect(principal.claims.deviceId).toBe("uae-phone-01");
  });

  it("caches Google's signing keys instead of refetching them", async () => {
    await verify(await signToken(validPayload()));
    await verify(await signToken(validPayload()));

    expect(jwkFetchCount).toBe(1);
  });

  it("rejects a token issued for another Firebase project", async () => {
    await expectUnauthenticated(await signToken(validPayload({ aud: "some-other-project" })));
  });

  it("rejects a token from an untrusted issuer", async () => {
    await expectUnauthenticated(await signToken(validPayload({ iss: "https://evil.example.com" })));
  });

  it("rejects an expired token", async () => {
    await expectUnauthenticated(
      await signToken(validPayload({ exp: Math.floor(NOW / 1_000) - 3_600 })),
    );
  });

  it("rejects a token signed by an unknown key", async () => {
    await expectUnauthenticated(await signToken(validPayload(), "not-a-google-key"));
  });

  it("rejects a token whose payload was tampered with after signing", async () => {
    const token = await signToken(validPayload());
    const [header, , signature] = token.split(".");
    const forged = base64Url(JSON.stringify(validPayload({ sub: "someone-else" })));

    await expectUnauthenticated(`${header}.${forged}.${signature}`);
  });

  it("rejects a malformed token", async () => {
    await expectUnauthenticated("not-a-jwt");
  });
});
