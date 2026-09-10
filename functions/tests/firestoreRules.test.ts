import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const projectId = "demo-arnifi-phone-bell";

function arnifiAuth(uid: string) {
  return {
    uid,
    token: {
      email: `${uid}@arnifi.com`,
      email_verified: true,
      firebase: { sign_in_provider: "google.com" },
    },
  };
}

describe("firestore.rules", () => {
  let testEnvironment: RulesTestEnvironment;

  beforeAll(async () => {
    testEnvironment = await initializeTestEnvironment({
      projectId,
      firestore: {
        rules: readFileSync(resolve(process.cwd(), "../firebase/firestore.rules"), "utf8"),
      },
    });
  });

  beforeEach(async () => {
    await testEnvironment.clearFirestore();
  });

  afterAll(async () => {
    await testEnvironment.cleanup();
  });

  it("allows an Arnifi Google user to create only their own valid profile", async () => {
    const auth = arnifiAuth("rahul");
    const db = testEnvironment.authenticatedContext(auth.uid, auth.token).firestore();

    await assertSucceeds(setDoc(doc(db, "users", auth.uid), {
      displayName: "Rahul Sharma",
      email: "rahul@arnifi.com",
      role: "targetter",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    }));

    await assertFails(setDoc(doc(db, "users", "another-user"), {
      displayName: "Rahul Sharma",
      email: "rahul@arnifi.com",
      role: "targetter",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    }));
  });

  it("rejects non-Arnifi, unverified, and non-Google identities", async () => {
    const invalidTokens = [
      { email: "person@example.com", email_verified: true, firebase: { sign_in_provider: "google.com" } },
      { email: "person@arnifi.com", email_verified: false, firebase: { sign_in_provider: "google.com" } },
      { email: "person@arnifi.com", email_verified: true, firebase: { sign_in_provider: "password" } },
    ];

    for (const [index, token] of invalidTokens.entries()) {
      const uid = `invalid-${index}`;
      const db = testEnvironment.authenticatedContext(uid, token).firestore();
      await assertFails(getDoc(doc(db, "config", "sharedPhone")));
    }
  });

  it("exposes only the safe device status projection", async () => {
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "devices", "uae-phone-01"), {
        deviceId: "uae-phone-01",
        displayName: "UAE Calling Phone",
        active: true,
        availability: "idle",
        lastSeenAt: new Date(),
      });
      await setDoc(doc(context.firestore(), "devices", "leaky-phone"), {
        deviceId: "leaky-phone",
        displayName: "Leaky Phone",
        active: true,
        availability: "idle",
        lastSeenAt: new Date(),
        fcmToken: "must-never-be-readable",
      });
    });

    const auth = arnifiAuth("rahul");
    const db = testEnvironment.authenticatedContext(auth.uid, auth.token).firestore();
    await assertSucceeds(getDoc(doc(db, "devices", "uae-phone-01")));
    await assertFails(getDoc(doc(db, "devices", "leaky-phone")));
    await assertFails(setDoc(doc(db, "devices", "uae-phone-01"), { availability: "busy" }));
  });

  it("lets users read only requests they created", async () => {
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "phoneRequests", "own-request"), {
        requestedBy: { uid: "rahul", name: "Rahul Sharma" },
        status: "sent",
      });
      await setDoc(doc(context.firestore(), "phoneRequests", "other-request"), {
        requestedBy: { uid: "someone-else", name: "Someone Else" },
        status: "sent",
      });
    });

    const auth = arnifiAuth("rahul");
    const db = testEnvironment.authenticatedContext(auth.uid, auth.token).firestore();
    await assertSucceeds(getDoc(doc(db, "phoneRequests", "own-request")));
    await assertFails(getDoc(doc(db, "phoneRequests", "other-request")));
    await assertFails(setDoc(doc(db, "phoneRequests", "forged"), {
      requestedBy: { uid: "rahul", name: "Rahul Sharma" },
      status: "sent",
    }));
  });

  it("denies private device data and unauthenticated access", async () => {
    const auth = arnifiAuth("rahul");
    const db = testEnvironment.authenticatedContext(auth.uid, auth.token).firestore();
    const anonymousDb = testEnvironment.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(db, "deviceCredentials", "uae-phone-01")));
    await assertFails(getDoc(doc(db, "deviceMetadata", "uae-phone-01")));
    await assertFails(getDoc(doc(anonymousDb, "devices", "uae-phone-01")));
  });
});
