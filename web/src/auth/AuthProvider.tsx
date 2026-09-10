import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  User,
} from "firebase/auth";
import { config } from "../config";
import { getFirebaseServices, googleProvider } from "../firebase/client";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOutUser: () => Promise<void>;
  getIdToken: () => Promise<string>;
  isDemo: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!config.demoMode);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config.demoMode || !config.firebaseConfigured) {
      setLoading(false);
      return;
    }
    const { auth } = getFirebaseServices();
    return onAuthStateChanged(
      auth,
      (nextUser) => {
        setUser(nextUser);
        setLoading(false);
      },
      () => {
        setError("We couldn't confirm your Arnifi account. Try again.");
        setLoading(false);
      },
    );
  }, []);

  const signIn = useCallback(async () => {
    if (config.demoMode) return;
    setError(null);
    try {
      const { auth } = getFirebaseServices();
      await setPersistence(auth, browserLocalPersistence);
      const credential = await signInWithPopup(auth, googleProvider);
      const email = credential.user.email?.toLowerCase() ?? "";
      if (!email.endsWith(`@${config.allowedEmailDomain}`)) {
        await signOut(auth);
        throw new Error("domain");
      }
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === "domain"
          ? `Use your @${config.allowedEmailDomain} account.`
          : "Sign-in didn't complete. Check the popup and try again.",
      );
    }
  }, []);

  const signOutUser = useCallback(async () => {
    if (config.demoMode) return;
    const { auth } = getFirebaseServices();
    await signOut(auth);
  }, []);

  const getIdToken = useCallback(async () => {
    if (config.demoMode) return "demo-token";
    if (!user) throw new Error("Authentication required");
    return user.getIdToken();
  }, [user]);

  const value = useMemo(
    () => ({
      user,
      loading,
      error,
      signIn,
      signOutUser,
      getIdToken,
      isDemo: config.demoMode,
    }),
    [user, loading, error, signIn, signOutUser, getIdToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

