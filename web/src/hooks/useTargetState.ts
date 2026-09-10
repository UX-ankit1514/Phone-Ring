import type { TargetPublicState } from "@arnifi/contracts";
import { doc, onSnapshot, Timestamp } from "firebase/firestore";
import { useEffect, useState } from "react";
import { config } from "../config";
import { getFirebaseServices } from "../firebase/client";

interface TargetSnapshotData {
  deviceId?: string;
  displayName?: string;
  active?: boolean;
  availability?: string;
  lastSeenAt?: Timestamp | null;
}

const demoState: TargetPublicState = {
  deviceId: "uae-phone-01",
  displayName: "UAE Calling Phone",
  active: true,
  availability: "idle",
  health: "likely_online",
  lastSeenAt: new Date().toISOString(),
};

export function useTargetState(enabled: boolean, demoMode: boolean): TargetPublicState | null {
  const [target, setTarget] = useState<TargetPublicState | null>(demoMode ? demoState : null);

  useEffect(() => {
    if (!enabled || demoMode) return;
    const { db } = getFirebaseServices();
    return onSnapshot(doc(db, "devices", config.targetDeviceId), (snapshot) => {
      if (!snapshot.exists()) {
        setTarget({
          deviceId: config.targetDeviceId,
          displayName: "UAE Calling Phone",
          active: false,
          availability: "idle",
          health: "never_seen",
          lastSeenAt: null,
        });
        return;
      }
      const data = snapshot.data() as TargetSnapshotData;
      const lastSeen = data.lastSeenAt?.toDate() ?? null;
      const age = lastSeen ? Date.now() - lastSeen.getTime() : null;
      setTarget({
        deviceId: data.deviceId ?? config.targetDeviceId,
        displayName: data.displayName ?? "UAE Calling Phone",
        active: data.active === true,
        availability: data.availability === "busy" ? "busy" : "idle",
        health: age === null
          ? "never_seen"
          : age < 5 * 60_000
            ? "likely_online"
            : age <= 15 * 60_000
              ? "unknown"
              : "possibly_offline",
        lastSeenAt: lastSeen?.toISOString() ?? null,
      });
    });
  }, [enabled, demoMode]);

  return target;
}
