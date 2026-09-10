import type { PhoneRequest, PhoneRequestStatus } from "@arnifi/contracts";
import { doc, onSnapshot, Unsubscribe } from "firebase/firestore";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPhoneRequest, cancelPhoneRequest, PhoneBellApiError } from "../api/phoneRequestApi";
import { config } from "../config";
import { getFirebaseServices } from "../firebase/client";
import {
  clearPendingRequest,
  PendingRequest,
  readPendingRequest,
  writePendingRequest,
} from "../storage";

export type RequestUiState =
  | "idle"
  | "creating"
  | PhoneRequestStatus;

export type RingSubmissionResult =
  | { submitted: true; requestId: string; status: PhoneRequestStatus }
  | { submitted: false; code: string; message: string };

interface UsePhoneRequestOptions {
  getIdToken: () => Promise<string>;
  enabled: boolean;
  demoMode: boolean;
}

const terminalStates = new Set<PhoneRequestStatus>([
  "acknowledged",
  "cancelled",
  "expired",
  "failed",
]);

export function usePhoneRequest({
  getIdToken,
  enabled,
  demoMode,
}: UsePhoneRequestOptions) {
  const [request, setRequest] = useState<PhoneRequest | null>(null);
  const [uiState, setUiState] = useState<RequestUiState>("idle");
  const [error, setError] = useState<PhoneBellApiError | null>(null);
  const [deliveryDelayed, setDeliveryDelayed] = useState(false);
  const [pending, setPending] = useState<PendingRequest | null>(() =>
    readPendingRequest(),
  );
  const unsubscribeRef = useRef<Unsubscribe | null>(null);
  const deliveryTimerRef = useRef<number | null>(null);

  const stopSubscription = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    if (deliveryTimerRef.current !== null) {
      window.clearTimeout(deliveryTimerRef.current);
      deliveryTimerRef.current = null;
    }
  }, []);

  const subscribe = useCallback(
    (requestId: string) => {
      if (demoMode) return;
      stopSubscription();
      const { db } = getFirebaseServices();
      unsubscribeRef.current = onSnapshot(
        doc(db, "phoneRequests", requestId),
        (snapshot) => {
          if (!snapshot.exists()) return;
          const next = snapshot.data() as PhoneRequest;
          setRequest(next);
          setUiState(next.status);
          setError(null);
          if (next.status === "sent") {
            deliveryTimerRef.current = window.setTimeout(
              () => setDeliveryDelayed(true),
              15_000,
            );
          } else {
            setDeliveryDelayed(false);
          }
          if (terminalStates.has(next.status)) {
            clearPendingRequest();
            setPending(null);
          }
        },
        () => {
          setError(
            new PhoneBellApiError(
              "REALTIME_UNAVAILABLE",
              "Live updates paused. We’ll reconnect automatically.",
              0,
              true,
            ),
          );
        },
      );
    },
    [demoMode, stopSubscription],
  );

  useEffect(() => {
    if (enabled && pending?.requestId && !demoMode) subscribe(pending.requestId);
    return stopSubscription;
  }, [enabled, pending?.requestId, demoMode, subscribe, stopSubscription]);

  const ring = useCallback(async (): Promise<RingSubmissionResult> => {
    setError(null);
    setDeliveryDelayed(false);
    setUiState("creating");
    const existing = readPendingRequest();
    const nextPending: PendingRequest = existing ?? {
      clientRequestId: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    writePendingRequest(nextPending);
    setPending(nextPending);

    if (demoMode) {
      const demoRequest = {
        requestId: `demo-${nextPending.clientRequestId}`,
        clientRequestId: nextPending.clientRequestId,
        targetDeviceId: config.targetDeviceId,
        requestedBy: { uid: "demo", name: "Rahul Sharma" },
        status: "sent" as PhoneRequestStatus,
      } as PhoneRequest;
      setRequest(demoRequest);
      setUiState("sent");
      window.setTimeout(() => {
        setRequest({ ...demoRequest, status: "delivered" });
        setUiState("delivered");
      }, 1_600);
      window.setTimeout(() => {
        setRequest({ ...demoRequest, status: "acknowledged" });
        setUiState("acknowledged");
        clearPendingRequest();
        setPending(null);
      }, 4_500);
      return {
        submitted: true,
        requestId: demoRequest.requestId,
        status: demoRequest.status,
      };
    }

    try {
      const token = await getIdToken();
      const response = await createPhoneRequest(token, {
        clientRequestId: nextPending.clientRequestId,
        targetDeviceId: config.targetDeviceId,
      });
      const saved = { ...nextPending, requestId: response.requestId };
      writePendingRequest(saved);
      setPending(saved);
      setUiState(response.status);
      subscribe(response.requestId);
      return {
        submitted: true,
        requestId: response.requestId,
        status: response.status,
      };
    } catch (cause) {
      setUiState("idle");
      const nextError = cause instanceof PhoneBellApiError
        ? cause
        : new PhoneBellApiError(
              "NETWORK_ERROR",
              navigator.onLine
                ? "Unable to send the phone request. Please try again."
                : "You appear to be offline. Connect to the internet and try again.",
              0,
              true,
            );
      setError(nextError);
      return {
        submitted: false,
        code: nextError.code,
        message: nextError.message,
      };
    }
  }, [demoMode, getIdToken, subscribe]);

  const cancel = useCallback(async () => {
    if (!request) return;
    if (demoMode) {
      setRequest({ ...request, status: "cancelled" });
      setUiState("cancelled");
      clearPendingRequest();
      setPending(null);
      return;
    }
    try {
      const token = await getIdToken();
      const response = await cancelPhoneRequest(token, request.requestId);
      setRequest(response.request);
      setUiState(response.request.status);
    } catch (cause) {
      setError(
        cause instanceof PhoneBellApiError
          ? cause
          : new PhoneBellApiError(
              "NETWORK_ERROR",
              "Unable to cancel the request. Please try again.",
              0,
              true,
            ),
      );
    }
  }, [demoMode, getIdToken, request]);

  const reset = useCallback(() => {
    stopSubscription();
    clearPendingRequest();
    setPending(null);
    setRequest(null);
    setUiState("idle");
    setError(null);
    setDeliveryDelayed(false);
  }, [stopSubscription]);

  return {
    request,
    uiState,
    error,
    deliveryDelayed,
    ring,
    cancel,
    reset,
    isActive: uiState === "creating" || ["created", "sent", "delivered"].includes(uiState),
  };
}
