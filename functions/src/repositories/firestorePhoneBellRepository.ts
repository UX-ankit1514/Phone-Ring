import { createHash } from "node:crypto";
import {
  FieldValue,
  Firestore,
  Timestamp,
  getFirestore,
  type DocumentData,
  type DocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import { TARGET_DEVICE_ID, TARGET_DISPLAY_NAME, type PhoneRequestStatus, type TargetPublicState } from "@arnifi/contracts";
import { AppError, errors } from "../errors";
import { ACTIVE_STATUSES, assertTransition } from "../domain/stateMachine";
import type {
  CreateCommand,
  PhoneBellRepository,
  PhoneRequestRecord,
  RegisteredDevice,
  ReservedRequest,
  SharedPhoneConfig,
  TargetDeviceRecord,
} from "../domain/models";
import { normalizeDisplayName } from "../validation";

const DEFAULT_CONFIG: SharedPhoneConfig = {
  targetDeviceId: TARGET_DEVICE_ID,
  ringDurationSeconds: 10,
  requestTimeoutSeconds: 60,
  targetterCooldownSeconds: 20,
  allowConcurrentRequests: false,
  vibrationEnabled: true,
  ttsEnabled: false,
  deliveryTimeoutSeconds: 15,
};

export class FirestorePhoneBellRepository implements PhoneBellRepository {
  constructor(
    private readonly db: Firestore = getFirestore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reserveRequest(command: CreateCommand): Promise<ReservedRequest> {
    const requestId = deterministicRequestId(command.uid, command.clientRequestId);
    const requestRef = this.db.collection("phoneRequests").doc(requestId);
    const userRef = this.db.collection("users").doc(command.uid);
    const deviceRef = this.db.collection("devices").doc(command.targetDeviceId);
    const credentialRef = this.db.collection("deviceCredentials").doc(command.targetDeviceId);
    const configRef = this.db.collection("config").doc("sharedPhone");
    const lockRef = this.db.collection("deviceRequestLocks").doc(command.targetDeviceId);
    const limitRef = this.db.collection("userRequestLimits").doc(command.uid);
    const idempotencyRef = this.db.collection("idempotencyKeys").doc(requestId);

    return this.db.runTransaction(async (tx) => {
      const existing = await tx.get(requestRef);
      if (existing.exists) {
        const request = requestFromSnapshot(existing);
        if (request.clientRequestId !== command.clientRequestId || request.requestedBy.uid !== command.uid) {
          throw new AppError("IDEMPOTENCY_CONFLICT", "The idempotency key conflicts with another request.", 409);
        }
        return {
          request,
          config: DEFAULT_CONFIG,
          device: emptyDevice(command.targetDeviceId),
          idempotentReplay: true,
        };
      }

      const [userSnap, deviceSnap, credentialSnap, configSnap, lockSnap, limitSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(deviceRef),
        tx.get(credentialRef),
        tx.get(configRef),
        tx.get(lockRef),
        tx.get(limitRef),
      ]);

      const now = this.now();
      const config = configFromData(configSnap.data());
      const displayName = normalizeDisplayName(userSnap.data()?.displayName);
      if (!userSnap.exists || !displayName) throw errors.profileMissing();

      const device = deviceFromSnapshots(deviceSnap, credentialSnap, command.targetDeviceId);
      if (!device.active || !device.fcmToken) throw errors.targetUnavailable();

      const lastCreatedAt = asDate(limitSnap.data()?.lastCreatedAt);
      if (lastCreatedAt) {
        const retryMs = config.targetterCooldownSeconds * 1_000 - (now.getTime() - lastCreatedAt.getTime());
        if (retryMs > 0) throw errors.cooldown(Math.ceil(retryMs / 1_000));
      }

      let staleRequest: { snapshot: DocumentSnapshot; status: PhoneRequestStatus } | null = null;
      const activeRequestId = stringOrNull(lockSnap.data()?.activeRequestId);
      if (!config.allowConcurrentRequests && activeRequestId) {
        const activeRef = this.db.collection("phoneRequests").doc(activeRequestId);
        const activeSnap = await tx.get(activeRef);
        if (activeSnap.exists) {
          const active = requestFromSnapshot(activeSnap);
          // The request is the source of truth for expiry. The lock's expiry is
          // a recovery hint and can be stale after a partial write/deployment.
          // Do not expire a still-valid request merely because that hint is old.
          if (ACTIVE_STATUSES.has(active.status) && active.expiresAt.getTime() > now.getTime()) {
            throw errors.activeRequest(activeRequestId);
          }
          if (ACTIVE_STATUSES.has(active.status)) staleRequest = { snapshot: activeSnap, status: active.status };
        }
      }

      const expiresAt = new Date(now.getTime() + config.requestTimeoutSeconds * 1_000);
      const request: PhoneRequestRecord = {
        requestId,
        clientRequestId: command.clientRequestId,
        targetDeviceId: command.targetDeviceId,
        requestedBy: { uid: command.uid, name: displayName },
        status: "created",
        createdAt: now,
        sentAt: null,
        deliveredAt: null,
        acknowledgedAt: null,
        cancelledAt: null,
        expiresAt,
        failureCode: null,
        failureMessage: null,
      };

      if (staleRequest) {
        const staleStatus: PhoneRequestStatus = staleRequest.status === "created" ? "failed" : "expired";
        tx.update(staleRequest.snapshot.ref, {
          status: staleStatus,
          failureCode: staleStatus === "failed" ? "DISPATCH_TIMEOUT" : null,
          failureMessage: staleStatus === "failed" ? "Request dispatch did not complete." : null,
        });
        writeEvent(tx, this.db, activeRequestId!, staleStatus === "failed" ? "FCM_SEND_FAILED" : "REQUEST_EXPIRED", {
          recoveredByRequestId: requestId,
        });
      }

      tx.create(requestRef, requestToFirestore(request));
      tx.create(idempotencyRef, {
        uid: command.uid,
        clientRequestId: command.clientRequestId,
        requestId,
        createdAt: Timestamp.fromDate(now),
        deleteAt: Timestamp.fromDate(new Date(now.getTime() + 24 * 60 * 60 * 1_000)),
      });
      tx.set(lockRef, {
        targetDeviceId: command.targetDeviceId,
        activeRequestId: requestId,
        expiresAt: Timestamp.fromDate(expiresAt),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(
        deviceRef,
        {
          availability: "busy",
          deviceType: FieldValue.delete(),
          platform: FieldValue.delete(),
          appVersion: FieldValue.delete(),
          deviceModel: FieldValue.delete(),
          capabilities: FieldValue.delete(),
          enrolledAt: FieldValue.delete(),
          updatedAt: FieldValue.delete(),
          activeRequestExpiresAt: FieldValue.delete(),
        },
        { merge: true },
      );
      tx.set(limitRef, {
        uid: command.uid,
        lastCreatedAt: Timestamp.fromDate(now),
        lastRequestId: requestId,
      });
      writeEvent(tx, this.db, requestId, "REQUEST_CREATED", { uid: command.uid, targetDeviceId: command.targetDeviceId });
      return { request, config, device, idempotentReplay: false };
    });
  }

  markSent(requestId: string): Promise<PhoneRequestRecord> {
    return this.db.runTransaction(async (tx) => {
      const requestRef = this.db.collection("phoneRequests").doc(requestId);
      const snap = await tx.get(requestRef);
      if (!snap.exists) throw errors.requestNotFound();
      const request = requestFromSnapshot(snap);
      if (request.status === "sent") return request;
      if (request.status === "delivered" || request.status === "acknowledged") {
        if (!request.sentAt) {
          const now = this.now();
          tx.update(requestRef, { sentAt: Timestamp.fromDate(now) });
          return { ...request, sentAt: now };
        }
        return request;
      }
      if (["cancelled", "expired", "failed"].includes(request.status)) return request;

      const now = this.now();
      if (request.expiresAt.getTime() <= now.getTime()) {
        // A slow FCM call must not resurrect a request after its deadline.
        // Android also rejects an already-expired payload, so leave the
        // request terminal and release the single-device lock.
        assertTransition(request.status, "failed");
        const lockRef = this.db.collection("deviceRequestLocks").doc(request.targetDeviceId);
        const deviceRef = this.db.collection("devices").doc(request.targetDeviceId);
        const lockSnap = await tx.get(lockRef);
        const failureCode = "DISPATCH_TIMEOUT";
        const failureMessage = "Request dispatch did not complete before expiry.";
        tx.update(requestRef, { status: "failed", failureCode, failureMessage });
        clearLockIfMatching(tx, lockRef, lockSnap.data(), requestId);
        setDeviceIdle(tx, deviceRef, lockSnap.data(), requestId);
        writeEvent(tx, this.db, requestId, "FCM_SEND_FAILED", {
          source: "sent_transition_expired",
          failureCode,
        });
        return { ...request, status: "failed" as const, failureCode, failureMessage };
      }

      assertTransition(request.status, "sent");
      tx.update(requestRef, { status: "sent", sentAt: Timestamp.fromDate(now) });
      return { ...request, status: "sent" as const, sentAt: now };
    });
  }

  async markFailed(requestId: string, code: string, message: string): Promise<PhoneRequestRecord> {
    return this.db.runTransaction(async (tx) => {
      const requestRef = this.db.collection("phoneRequests").doc(requestId);
      const snap = await tx.get(requestRef);
      if (!snap.exists) throw errors.requestNotFound();
      const request = requestFromSnapshot(snap);
      if (request.status === "failed") return request;
      if (["delivered", "acknowledged", "cancelled", "expired"].includes(request.status)) {
        return request;
      }
      assertTransition(request.status, "failed");
      const lockRef = this.db.collection("deviceRequestLocks").doc(request.targetDeviceId);
      const deviceRef = this.db.collection("devices").doc(request.targetDeviceId);
      const lockSnap = await tx.get(lockRef);
      tx.update(requestRef, { status: "failed", failureCode: code, failureMessage: message.slice(0, 500) });
      clearLockIfMatching(tx, lockRef, lockSnap.data(), requestId);
      setDeviceIdle(tx, deviceRef, lockSnap.data(), requestId);
      return { ...request, status: "failed", failureCode: code, failureMessage: message.slice(0, 500) };
    });
  }

  async markDelivered(requestId: string, deviceId: string): Promise<PhoneRequestRecord> {
    const result = await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection("phoneRequests").doc(requestId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw errors.requestNotFound();
      const request = requestFromSnapshot(snap);
      assertMatchingDevice(request, deviceId);
      if (request.status === "delivered" || request.status === "acknowledged") return { request, expired: false };
      const now = this.now();
      if (request.expiresAt.getTime() <= now.getTime()) {
        const lockRef = this.db.collection("deviceRequestLocks").doc(request.targetDeviceId);
        const deviceRef = this.db.collection("devices").doc(request.targetDeviceId);
        const lockSnap = await tx.get(lockRef);
        const terminalStatus: PhoneRequestStatus = request.status === "created" ? "failed" : "expired";
        tx.update(ref, {
          status: terminalStatus,
          ...(terminalStatus === "failed"
            ? { failureCode: "DISPATCH_TIMEOUT", failureMessage: "Request dispatch did not complete." }
            : {}),
        });
        clearLockIfMatching(tx, lockRef, lockSnap.data(), requestId);
        setDeviceIdle(tx, deviceRef, lockSnap.data(), requestId);
        writeEvent(
          tx,
          this.db,
          requestId,
          terminalStatus === "failed" ? "FCM_SEND_FAILED" : "REQUEST_EXPIRED",
          { source: "delivered_callback" },
        );
        return {
          request: {
            ...request,
            status: terminalStatus,
            ...(terminalStatus === "failed"
              ? { failureCode: "DISPATCH_TIMEOUT", failureMessage: "Request dispatch did not complete." }
              : {}),
          },
          expired: true,
        };
      }
      assertTransition(request.status, "delivered");
      tx.update(ref, {
        status: "delivered",
        deliveredAt: Timestamp.fromDate(now),
        ...(request.sentAt ? {} : { sentAt: Timestamp.fromDate(now) }),
      });
      if (request.status === "created") {
        writeEvent(tx, this.db, requestId, "FCM_SEND_SUCCEEDED", { source: "device_receipt_recovery" });
      }
      writeEvent(tx, this.db, requestId, "FCM_RECEIVED", { deviceId });
      return {
        request: { ...request, status: "delivered" as const, sentAt: request.sentAt ?? now, deliveredAt: now },
        expired: false,
      };
    });
    if (result.expired) throw errors.requestExpired();
    return result.request;
  }

  async acknowledge(requestId: string, deviceId: string): Promise<PhoneRequestRecord> {
    const result = await this.db.runTransaction(async (tx) => {
      const requestRef = this.db.collection("phoneRequests").doc(requestId);
      const snap = await tx.get(requestRef);
      if (!snap.exists) throw errors.requestNotFound();
      const request = requestFromSnapshot(snap);
      assertMatchingDevice(request, deviceId);
      if (request.status === "acknowledged") return { request, expired: false };
      if (request.status === "cancelled" || request.status === "expired" || request.status === "failed") {
        return { request, expired: request.status === "expired" };
      }
      const lockRef = this.db.collection("deviceRequestLocks").doc(request.targetDeviceId);
      const deviceRef = this.db.collection("devices").doc(request.targetDeviceId);
      const lockSnap = await tx.get(lockRef);
      const now = this.now();
      if (request.expiresAt.getTime() <= now.getTime()) {
        if (ACTIVE_STATUSES.has(request.status)) {
          const terminalStatus: PhoneRequestStatus = request.status === "created" ? "failed" : "expired";
          tx.update(requestRef, {
            status: terminalStatus,
            ...(terminalStatus === "failed"
              ? { failureCode: "DISPATCH_TIMEOUT", failureMessage: "Request dispatch did not complete." }
              : {}),
          });
          clearLockIfMatching(tx, lockRef, lockSnap.data(), requestId);
          setDeviceIdle(tx, deviceRef, lockSnap.data(), requestId);
          writeEvent(
            tx,
            this.db,
            requestId,
            terminalStatus === "failed" ? "FCM_SEND_FAILED" : "REQUEST_EXPIRED",
            { source: "acknowledge_callback" },
          );
          return {
            request: {
              ...request,
              status: terminalStatus,
              ...(terminalStatus === "failed"
                ? { failureCode: "DISPATCH_TIMEOUT", failureMessage: "Request dispatch did not complete." }
                : {}),
            },
            expired: true,
          };
        }
        return { request, expired: true };
      }
      assertTransition(request.status, "acknowledged");
      tx.update(requestRef, {
        status: "acknowledged",
        sentAt: Timestamp.fromDate(request.sentAt ?? now),
        deliveredAt: Timestamp.fromDate(request.deliveredAt ?? now),
        acknowledgedAt: Timestamp.fromDate(now),
      });
      clearLockIfMatching(tx, lockRef, lockSnap.data(), requestId);
      setDeviceIdle(tx, deviceRef, lockSnap.data(), requestId);
      if (!request.deliveredAt) {
        writeEvent(tx, this.db, requestId, "FCM_RECEIVED", { deviceId, source: "ack_recovery" });
      }
      writeEvent(tx, this.db, requestId, "REQUEST_ACKNOWLEDGED", { deviceId });
      return {
        request: {
          ...request,
          status: "acknowledged" as const,
          sentAt: request.sentAt ?? now,
          deliveredAt: request.deliveredAt ?? now,
          acknowledgedAt: now,
        },
        expired: false,
      };
    });
    if (result.expired) throw errors.requestExpired();
    return result.request;
  }

  async cancel(requestId: string, uid: string): Promise<{ request: PhoneRequestRecord; deviceToken: string | null }> {
    return this.db.runTransaction(async (tx) => {
      const requestRef = this.db.collection("phoneRequests").doc(requestId);
      const snap = await tx.get(requestRef);
      if (!snap.exists) throw errors.requestNotFound();
      const request = requestFromSnapshot(snap);
      if (request.requestedBy.uid !== uid) throw errors.forbidden("Only the requester can cancel this request.");
      if (request.status === "cancelled") return { request, deviceToken: null };
      assertTransition(request.status, "cancelled");
      const credentialRef = this.db.collection("deviceCredentials").doc(request.targetDeviceId);
      const deviceRef = this.db.collection("devices").doc(request.targetDeviceId);
      const lockRef = this.db.collection("deviceRequestLocks").doc(request.targetDeviceId);
      const [credentialSnap, lockSnap] = await Promise.all([tx.get(credentialRef), tx.get(lockRef)]);
      const now = this.now();
      tx.update(requestRef, { status: "cancelled", cancelledAt: Timestamp.fromDate(now) });
      clearLockIfMatching(tx, lockRef, lockSnap.data(), requestId);
      setDeviceIdle(tx, deviceRef, lockSnap.data(), requestId);
      writeEvent(tx, this.db, requestId, "REQUEST_CANCELLED", { uid });
      return {
        request: { ...request, status: "cancelled" as const, cancelledAt: now },
        deviceToken: stringOrNull(credentialSnap.data()?.fcmToken),
      };
    });
  }

  async expire(requestId: string): Promise<PhoneRequestRecord | null> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.db.collection("phoneRequests").doc(requestId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const request = requestFromSnapshot(snap);
      if (!ACTIVE_STATUSES.has(request.status)) return request;
      const now = this.now();
      if (request.expiresAt.getTime() > now.getTime()) return request;
      const lockRef = this.db.collection("deviceRequestLocks").doc(request.targetDeviceId);
      const deviceRef = this.db.collection("devices").doc(request.targetDeviceId);
      const lockSnap = await tx.get(lockRef);
      const status: PhoneRequestStatus = request.status === "created" ? "failed" : "expired";
      tx.update(ref, {
        status,
        failureCode: status === "failed" ? "DISPATCH_TIMEOUT" : request.failureCode,
        failureMessage: status === "failed" ? "Request dispatch did not complete." : request.failureMessage,
      });
      clearLockIfMatching(tx, lockRef, lockSnap.data(), requestId);
      setDeviceIdle(tx, deviceRef, lockSnap.data(), requestId);
      writeEvent(tx, this.db, requestId, status === "failed" ? "FCM_SEND_FAILED" : "REQUEST_EXPIRED", {
        source: "expiry",
      });
      return { ...request, status };
    });
  }

  async sweepExpired(limit: number): Promise<number> {
    const now = Timestamp.fromDate(this.now());
    const snapshot = await this.db
      .collection("phoneRequests")
      .where("status", "in", ["created", "sent", "delivered"])
      .where("expiresAt", "<=", now)
      .limit(Math.min(Math.max(limit, 1), 500))
      .get();
    const results = await Promise.all(snapshot.docs.map((document) => this.expire(document.id)));
    return results.filter((result) => result && (result.status === "expired" || result.status === "failed")).length;
  }

  async recordEvent(requestId: string, event: string, attributes: Record<string, unknown> = {}): Promise<void> {
    await this.db.collection("requestEvents").add({
      requestId,
      event,
      createdAt: FieldValue.serverTimestamp(),
      ...sanitizeAttributes(attributes),
    });
  }

  async registerDevice(device: RegisteredDevice): Promise<void> {
    const deviceRef = this.db.collection("devices").doc(device.deviceId);
    const credentialRef = this.db.collection("deviceCredentials").doc(device.deviceId);
    const lockRef = this.db.collection("deviceRequestLocks").doc(device.deviceId);
    await this.db.runTransaction(async (tx) => {
      const lockSnap = await tx.get(lockRef);
      const lock = lockSnap.data();
      const lockRequestId = stringOrNull(lock?.activeRequestId);
      const lockExpiry = asDate(lock?.expiresAt);
      const busy = Boolean(lockRequestId && lockExpiry && lockExpiry.getTime() > this.now().getTime());
      tx.set(
        deviceRef,
        {
          deviceId: device.deviceId,
          displayName: TARGET_DISPLAY_NAME,
          active: true,
          lastSeenAt: FieldValue.serverTimestamp(),
          ...(busy ? { availability: "busy" } : { availability: "idle" }),
          // Keep this document a safe public status projection even when
          // upgrading an installation created by an older deployment.
          deviceType: FieldValue.delete(),
          platform: FieldValue.delete(),
          appVersion: FieldValue.delete(),
          deviceModel: FieldValue.delete(),
          capabilities: FieldValue.delete(),
          enrolledAt: FieldValue.delete(),
          updatedAt: FieldValue.delete(),
          activeRequestExpiresAt: FieldValue.delete(),
        },
        { merge: true },
      );
      tx.set(
        this.db.collection("deviceMetadata").doc(device.deviceId),
        {
          deviceId: device.deviceId,
          deviceType: "target",
          platform: "android",
          appVersion: device.appVersion,
          deviceModel: device.deviceModel,
          capabilities: device.capabilities ?? { ring: true, vibration: true, tts: false },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      tx.set(
        credentialRef,
        {
          deviceId: device.deviceId,
          fcmToken: device.fcmToken,
          lastTokenRefreshAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  }

  async heartbeat(deviceId: string, appVersion?: string): Promise<void> {
    const batch = this.db.batch();
    batch.set(
      this.db.collection("devices").doc(deviceId),
      {
        deviceId,
        lastSeenAt: FieldValue.serverTimestamp(),
        deviceType: FieldValue.delete(),
        platform: FieldValue.delete(),
        appVersion: FieldValue.delete(),
        deviceModel: FieldValue.delete(),
        capabilities: FieldValue.delete(),
        enrolledAt: FieldValue.delete(),
        updatedAt: FieldValue.delete(),
        activeRequestExpiresAt: FieldValue.delete(),
      },
      { merge: true },
    );
    if (appVersion) {
      batch.set(
        this.db.collection("deviceMetadata").doc(deviceId),
        { deviceId, appVersion, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
    await batch.commit();
  }

  async getTargetPublicState(deviceId: string): Promise<TargetPublicState> {
    const snap = await this.db.collection("devices").doc(deviceId).get();
    const data = snap.data();
    const lastSeenAt = asDate(data?.lastSeenAt);
    const ageMs = lastSeenAt ? this.now().getTime() - lastSeenAt.getTime() : null;
    const health: TargetPublicState["health"] =
      ageMs === null
        ? "never_seen"
        : ageMs < 5 * 60_000
          ? "likely_online"
          : ageMs <= 15 * 60_000
            ? "unknown"
            : "possibly_offline";
    return {
      deviceId,
      displayName: stringOrNull(data?.displayName) ?? TARGET_DISPLAY_NAME,
      active: Boolean(data?.active),
      availability: data?.availability === "busy" ? "busy" : "idle",
      health,
      lastSeenAt: lastSeenAt?.toISOString() ?? null,
    };
  }

  private async transition(
    requestId: string,
    status: PhoneRequestStatus,
    fields: (now: Date) => DocumentData,
  ): Promise<PhoneRequestRecord> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.db.collection("phoneRequests").doc(requestId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw errors.requestNotFound();
      const request = requestFromSnapshot(snap);
      if (request.status === status) return request;
      if (status === "sent" && (request.status === "delivered" || request.status === "acknowledged")) {
        if (!request.sentAt) tx.update(ref, { sentAt: Timestamp.fromDate(this.now()) });
        return request;
      }
      if (status === "sent" && (request.status === "cancelled" || request.status === "expired" || request.status === "failed")) {
        return request;
      }
      assertTransition(request.status, status);
      const now = this.now();
      tx.update(ref, { status, ...fields(now) });
      return { ...request, status, ...(status === "sent" ? { sentAt: now } : {}) };
    });
  }
}

function deterministicRequestId(uid: string, clientRequestId: string): string {
  return `req_${createHash("sha256").update(`${uid}:${clientRequestId}`).digest("hex").slice(0, 32)}`;
}

function requestToFirestore(request: PhoneRequestRecord): DocumentData {
  return {
    ...request,
    createdAt: Timestamp.fromDate(request.createdAt),
    sentAt: null,
    deliveredAt: null,
    acknowledgedAt: null,
    cancelledAt: null,
    expiresAt: Timestamp.fromDate(request.expiresAt),
    deleteAt: Timestamp.fromDate(new Date(request.createdAt.getTime() + 90 * 24 * 60 * 60 * 1_000)),
  };
}

function requestFromSnapshot(snapshot: DocumentSnapshot): PhoneRequestRecord {
  const data = snapshot.data();
  if (!data) throw errors.requestNotFound();
  return {
    requestId: String(data.requestId ?? snapshot.id),
    clientRequestId: String(data.clientRequestId),
    targetDeviceId: String(data.targetDeviceId),
    requestedBy: { uid: String(data.requestedBy?.uid), name: String(data.requestedBy?.name) },
    status: data.status as PhoneRequestStatus,
    createdAt: requiredDate(data.createdAt, "createdAt"),
    sentAt: asDate(data.sentAt),
    deliveredAt: asDate(data.deliveredAt),
    acknowledgedAt: asDate(data.acknowledgedAt),
    cancelledAt: asDate(data.cancelledAt),
    expiresAt: requiredDate(data.expiresAt, "expiresAt"),
    failureCode: stringOrNull(data.failureCode),
    failureMessage: stringOrNull(data.failureMessage),
  };
}

function deviceFromSnapshots(
  snapshot: DocumentSnapshot,
  credentials: DocumentSnapshot,
  deviceId: string,
): TargetDeviceRecord {
  const data = snapshot.data();
  const privateData = credentials.data();
  return {
    deviceId,
    displayName: stringOrNull(data?.displayName) ?? TARGET_DISPLAY_NAME,
    active: snapshot.exists && data?.active === true,
    fcmToken: stringOrNull(privateData?.fcmToken) ?? "",
    lastSeenAt: asDate(data?.lastSeenAt),
  };
}

function emptyDevice(deviceId: string): TargetDeviceRecord {
  return { deviceId, displayName: TARGET_DISPLAY_NAME, active: false, fcmToken: "", lastSeenAt: null };
}

function configFromData(data: DocumentData | undefined): SharedPhoneConfig {
  return {
    targetDeviceId: TARGET_DEVICE_ID,
    ringDurationSeconds: boundedNumber(data?.ringDurationSeconds, 3, 30, DEFAULT_CONFIG.ringDurationSeconds),
    requestTimeoutSeconds: boundedNumber(data?.requestTimeoutSeconds, 30, 300, DEFAULT_CONFIG.requestTimeoutSeconds),
    targetterCooldownSeconds: boundedNumber(
      data?.targetterCooldownSeconds,
      5,
      300,
      DEFAULT_CONFIG.targetterCooldownSeconds,
    ),
    allowConcurrentRequests: data?.allowConcurrentRequests === true,
    vibrationEnabled: data?.vibrationEnabled !== false,
    ttsEnabled: data?.ttsEnabled === true,
    deliveryTimeoutSeconds: boundedNumber(
      data?.deliveryTimeoutSeconds,
      5,
      60,
      DEFAULT_CONFIG.deliveryTimeoutSeconds,
    ),
  };
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value)
    : fallback;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value instanceof Timestamp) return value.toDate();
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate();
  }
  return null;
}

function requiredDate(value: unknown, field: string): Date {
  const date = asDate(value);
  if (!date) throw new AppError("CORRUPT_REQUEST", `Request has invalid ${field}.`, 500);
  return date;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clearLockIfMatching(
  tx: Transaction,
  lockRef: FirebaseFirestore.DocumentReference,
  lock: DocumentData | undefined,
  requestId: string,
): void {
  if (lock?.activeRequestId === requestId) {
    tx.set(lockRef, { activeRequestId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
}

function writeEvent(
  tx: Transaction,
  db: Firestore,
  requestId: string,
  event: string,
  attributes: Record<string, unknown> = {},
): void {
  const ref = db.collection("requestEvents").doc();
  tx.create(ref, {
    requestId,
    event,
    createdAt: FieldValue.serverTimestamp(),
    deleteAt: Timestamp.fromDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000)),
    ...sanitizeAttributes(attributes),
  });
}

function sanitizeAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key, value]) => !/token|secret|authorization/i.test(key) && value !== undefined,
    ),
  );
}

function assertMatchingDevice(request: PhoneRequestRecord, deviceId: string): void {
  if (request.targetDeviceId !== deviceId) throw errors.forbidden("The request belongs to a different target device.");
}

function setDeviceIdle(
  tx: Transaction,
  deviceRef: FirebaseFirestore.DocumentReference,
  lock: DocumentData | undefined,
  requestId: string,
): void {
  if (lock?.activeRequestId === requestId) {
    tx.set(
      deviceRef,
      {
        availability: "idle",
      },
      { merge: true },
    );
  }
}
