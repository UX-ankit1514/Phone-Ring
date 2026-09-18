import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import {
  BellRing,
  ChevronRight,
  CircleUserRound,
  LogOut,
  Phone,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useAuth } from "./auth/AuthProvider";
import { ArnifiMark } from "./components/ArnifiMark";
import { ProfileForm } from "./components/ProfileForm";
import { ThemeToggle } from "./components/ThemeToggle";
import { isTerminalState, StatusPanel } from "./components/StatusPanel";
import { config } from "./config";
import { getFirebaseServices } from "./firebase/client";
import { usePhoneRequest } from "./hooks/usePhoneRequest";
import { usePhoneBellWebMcp } from "./hooks/usePhoneBellWebMcp";
import { useTargetState } from "./hooks/useTargetState";
import { readDisplayName, writeDisplayName } from "./storage";
import { firstName } from "./utils/name";

export function App() {
  const auth = useAuth();
  const [displayName, setDisplayName] = useState(() =>
    auth.isDemo ? "Rahul Sharma" : readDisplayName(),
  );
  const [editingName, setEditingName] = useState(false);
  const request = usePhoneRequest({
    getIdToken: auth.getIdToken,
    enabled: Boolean(auth.user) || auth.isDemo,
    demoMode: auth.isDemo,
  });
  const target = useTargetState(Boolean(auth.user) || auth.isDemo, auth.isDemo);

  const authenticated = Boolean(auth.user) || auth.isDemo;
  const suggestedName = useMemo(
    () => displayName ?? auth.user?.displayName ?? "",
    [displayName, auth.user?.displayName],
  );

  const targetBusy = target?.availability === "busy" && !request.isActive;
  const targetUnavailable = target?.active === false;
  const canRing = authenticated && Boolean(displayName) && !request.isActive && !targetBusy && !targetUnavailable;

  usePhoneBellWebMcp({
    enabled: authenticated && Boolean(displayName) && !editingName,
    canRing,
    uiState: request.uiState,
    target,
    ring: request.ring,
  });

  async function saveProfile(name: string) {
    if (!auth.isDemo) {
      const user = auth.user;
      if (!user) throw new Error("Authentication required");
      const { db } = getFirebaseServices();
      const userRef = doc(db, "users", user.uid);
      const existingProfile = await getDoc(userRef);
      await setDoc(
        userRef,
        {
          displayName: name,
          email: user.email,
          role: "targetter",
          updatedAt: serverTimestamp(),
          lastSeenAt: serverTimestamp(),
          ...(!existingProfile.exists() ? { createdAt: serverTimestamp() } : {}),
        },
        { merge: true },
      );
    }
    writeDisplayName(name);
    setDisplayName(name);
    setEditingName(false);
  }

  if (auth.loading) {
    return (
      <main className="shell loading-shell">
        <ArnifiMark />
        <div className="loader-orbit" aria-label="Loading"><span /></div>
      </main>
    );
  }

  if (!config.firebaseConfigured && !auth.isDemo) {
    return (
      <main className="shell centered-shell">
        <ArnifiMark />
        <section className="setup-card">
          <ShieldCheck aria-hidden="true" />
          <p className="eyebrow">Setup required</p>
          <h1>Connect the Firebase project</h1>
          <p>Copy <code>web/.env.example</code> to <code>web/.env.local</code> and add the dev project’s web configuration.</p>
        </section>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="shell auth-shell">
        <header><ArnifiMark /><ThemeToggle /></header>
        <section className="auth-card">
          <div className="phone-glyph"><Phone aria-hidden="true" /></div>
          <p className="eyebrow">Internal utility</p>
          <h1>Find the UAE phone,<br />without the office search.</h1>
          <p className="auth-copy">Sign in with your Arnifi account to ring the shared calling phone.</p>
          {auth.error && <div className="error-banner" role="alert">{auth.error}</div>}
          <button className="button-primary sign-in" onClick={auth.signIn}>
            Continue with Google <ChevronRight aria-hidden="true" />
          </button>
          <div className="trust-line"><ShieldCheck aria-hidden="true" /> Restricted to @{config.allowedEmailDomain}</div>
        </section>
      </main>
    );
  }

  if (!displayName || editingName) {
    return (
      <main className="shell profile-shell">
        <header><ArnifiMark /><ThemeToggle /></header>
        <section className="profile-card">
          <p className="eyebrow">One quick detail</p>
          <h1>Your name on the phone</h1>
          <ProfileForm
            initialValue={suggestedName}
            onSave={saveProfile}
            onCancel={displayName ? () => setEditingName(false) : undefined}
          />
        </section>
      </main>
    );
  }

  const canCancel = ["created", "sent", "delivered"].includes(request.uiState);

  return (
    <main className="shell app-shell">
      <header className="app-header">
        <ArnifiMark />
        <div className="account-menu">
          <span><CircleUserRound aria-hidden="true" /> {displayName}</span>
          <ThemeToggle />
          {!auth.isDemo && (
            <button onClick={auth.signOutUser} title="Sign out" aria-label="Sign out">
              <LogOut aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      <section className="workspace">
        <div className="intro">
          <div>
            <p className="eyebrow">Shared device · Bengaluru office</p>
            <h1>Hi {firstName(displayName)}.<br />Need the UAE phone?</h1>
          </div>
          <div className="device-badge">
            <span className={target?.active === false ? "offline-dot" : ""} />
            {targetBusy ? "Phone request in progress" : target?.displayName ?? "UAE Calling Phone"}
          </div>
        </div>

        <div className="action-grid">
          <section className="ring-card">
            <div className="ring-visual" aria-hidden="true">
              <span className={request.isActive ? "pulse pulse-one active" : "pulse pulse-one"} />
              <span className={request.isActive ? "pulse pulse-two active" : "pulse pulse-two"} />
              <div><BellRing /></div>
            </div>
            <button className="ring-button" onClick={request.ring} disabled={!canRing}>
              <BellRing aria-hidden="true" />
              {request.isActive ? "RINGING…" : targetBusy ? "PHONE BUSY" : "RING PHONE"}
            </button>
            <p>Alerts the shared Samsung for 10 seconds</p>
          </section>

          <div className="status-stack">
            <StatusPanel state={request.uiState} deliveryDelayed={request.deliveryDelayed} />
            {request.error && (
              <div className="error-banner" role="alert">
                {request.error.code === "ACTIVE_REQUEST_EXISTS"
                  ? "The UAE phone is already being requested. Please wait for the current request to finish."
                  : request.error.message}
              </div>
            )}
            {target && target.health === "possibly_offline" && request.uiState === "idle" && (
              <div className="warning-banner" role="status">
                The UAE phone may be offline. We will still attempt delivery.
              </div>
            )}
            {targetBusy && request.uiState === "idle" && (
              <div className="warning-banner" role="status">
                The UAE phone is already being requested. Please wait for the current request to finish.
              </div>
            )}
            {targetUnavailable && request.uiState === "idle" && (
              <div className="error-banner" role="status">
                The UAE phone is not enrolled yet. Ask an administrator to open the Android app and complete setup.
              </div>
            )}
            <div className="secondary-actions">
              {canCancel && (
                <button className="button-secondary danger" onClick={request.cancel}>
                  Cancel request
                </button>
              )}
              {isTerminalState(request.uiState) && (
                <button className="button-secondary" onClick={request.reset}>
                  {request.uiState === "expired" || request.uiState === "failed" ? "Ring again" : "Done"}
                </button>
              )}
              {!request.isActive && request.uiState === "idle" && (
                <button className="text-button" onClick={() => setEditingName(true)}>Change name</button>
              )}
            </div>
          </div>
        </div>
      </section>

      <footer>
        <span className="online"><span /> Service ready</span>
        <span><WifiOff aria-hidden="true" /> If the phone is offline, this request will expire safely.</span>
      </footer>
    </main>
  );
}
