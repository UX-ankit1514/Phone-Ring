const requiredFirebaseValues = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const config = {
  firebase: requiredFirebaseValues,
  firebaseConfigured: Object.values(requiredFirebaseValues).every(Boolean),
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "/api/v1",
  targetDeviceId: import.meta.env.VITE_TARGET_DEVICE_ID ?? "uae-phone-01",
  allowedEmailDomain: import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN ?? "arnifi.com",
  useEmulators: import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true",
  demoMode: import.meta.env.VITE_DEMO_MODE === "true",
} as const;

