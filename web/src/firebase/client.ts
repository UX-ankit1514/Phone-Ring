import { FirebaseApp, getApps, initializeApp } from "firebase/app";
import {
  Auth,
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
} from "firebase/auth";
import {
  connectFirestoreEmulator,
  Firestore,
  getFirestore,
} from "firebase/firestore";
import { config } from "../config";

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let emulatorsConnected = false;

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  hd: config.allowedEmailDomain,
  prompt: "select_account",
});

export function getFirebaseServices(): { auth: Auth; db: Firestore } {
  if (!config.firebaseConfigured) {
    throw new Error("Firebase web configuration is incomplete.");
  }

  app = app ?? (getApps()[0] ?? initializeApp(config.firebase));
  auth = auth ?? getAuth(app);
  db = db ?? getFirestore(app);

  if (config.useEmulators && !emulatorsConnected) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    emulatorsConnected = true;
  }

  return { auth, db };
}

