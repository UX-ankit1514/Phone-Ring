import {
  TARGET_DISPLAY_NAME,
  type PhoneRequestStatus,
  type TargetPublicState,
} from "@arnifi/contracts";
import { sha256 } from "./crypto";
import { AppError, errors } from "./errors";
import type { Data, FirestoreRest, TransactionResult } from "./firestore";
import { ACTIVE_STATUSES, assertTransition } from "./stateMachine";
import type { FirestoreWrite } from "./types";
import type {
  CreateCommand,
  PhoneRequestRecord,
  RegisteredDevice,
  ReservedRequest,
  SharedPhoneConfig,
  TargetDeviceRecord,
} from "./types";
import { normalizeDisplayName } from "./validation";

const DAY_MS = 24 * 60 * 60 * 1_000;
const REQUEST_RETENTION_MS = 90 * DAY_MS;
const EVENT_RETENTION_MS = 30 * DAY_MS;
const IDEMPOTENCY_RETENTION_MS = DAY_MS;

const DISPATCH_TIMEOUT_CODE = "DISPATCH_TIMEOUT";
const DISPATCH_TIMEOUT_MESSAGE = "Request dispatch did not complete.";

/**
 * Fields written by earlier deployments. They are stripped from every write to
 * `devices/{id}` so that document stays the narrow public status projection the
 * Firestore rules allow employees to read.
 */
const DEVICE_LEGACY_FIELDS = [
  "deviceType",
  "platform",
  "appVersion",
  "deviceModel",
  "capabilities",
  "enrolledAt",
  "updatedAt",
  "activeRequestExpiresAt",
];

export const DEFAULT_CONFIG: Omit<SharedPhoneConfig, "targetDeviceId"> = {
  ringDurationSeconds: 10,
  requestTimeoutSeconds: 60,
  targetterCooldownSeconds: 20,
  allowConcurrentRequests: false,
  vibrationEnabled: true,
  ttsEnabled: false,
  deliveryTimeoutSeconds: 15,
};

export class PhoneBellRepository {
  constructor(
    private readonly db: FirestoreRest,
    private readonly targetDeviceId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Creates the request, claims the single-device lock and applies the
   * per-employee cooldown in one transaction. The active request id lives in
   * the lock, so it is read first to know which request document the
   * transaction has to include; a lock that moved in between aborts the
   * attempt and the whole thing is retried against the new lock.
   */
  async reserveRequest(command: CreateCommand): Promise<ReservedRequest> {
    const requestId = await deterministicRequestId(command.uid, command.clientRequestId);
    const basePaths = [
      `phoneRequests/${requestId}`,
      `users/${command.uid}`,
      `devices/${this.targetDeviceId}`,
      `deviceCredentials/${this.targetDeviceId}`,
      "config/sharedPhone",
      `deviceRequestLocks/${this.targetDeviceId}`,
      `userRequestLimits/${command.uid}`,
    ];

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lock = await this.db.get(`deviceRequestLocks/${this.targetDeviceId}`);
      const activeRequestId = stringOrNull(lock?.activeRequestId);
      const paths =
        activeRequestId && activeRequestId !== requestId
          ? [...basePaths, `phoneRequests/${activeRequestId}`]
          : basePaths;
      try {
        return await this.db.runTransaction(
          paths,
          (documents) => this.reserve(command, requestId, activeRequestId, documents),
          1,
        );
      } catch (error) {
        lastError = error;
        if (!isContention(error)) throw error;
      }
    }
    throw lastError;
  }

  markSent(requestId: string): Promise<PhoneRequestRecord> {
    return this.db.runTransaction(this.transitionPaths(requestId), (documents) => {
      const request = this.loadRequest(documents, requestId);
      if (request.status === "sent") return value(request);
      if (request.status === "delivered" || request.status === "acknowledged") {
        if (request.sentAt) return value(request);
        const now = this.now();
        return {
          value: { ...request, sentAt: now },
          writes: [this.db.mergeWrite(`phoneRequests/${requestId}`, { sentAt: now })],
        };
      }
      if (request.status === "cancelled" || request.status === "expired" || request.status === "failed") {
        return value(request);
      }

      const now = this.now();
      if (request.expiresAt.getTime() <= now.getTime()) {
        // A slow FCM call must not resurrect a request after its deadline.
        // Android also rejects an already-expired payload, so leave the
        // request terminal and release the single-device lock.
        assertTransition(request.status, "failed");
        return {
          value: {
            ...request,
            status: "failed" as const,
            failureCode: DISPATCH_TIMEOUT_CODE,
            failureMessage: "Request dispatch did not complete before expiry.",
          },
          writes: [
            this.db.mergeWrite(`phoneRequests/${requestId}`, {
              status: "failed",
              failureCode: DISPATCH_TIMEOUT_CODE,
              failureMessage: "Request dispatch did not complete before expiry.",
            }),
            ...this.releaseWrites(documents, requestId),
            this.eventWrite(requestId, "FCM_SEND_FAILED", {
              source: "sent_transition_expired",
              failureCode: DISPATCH_TIMEOUT_CODE,
            }),
          ],
        };
      }

      assertTransition(request.status, "sent");
      return {
        value: { ...request, status: "sent" as const, sentAt: now },
        writes: [this.db.mergeWrite(`phoneRequests/${requestId}`, { status: "sent", sentAt: now })],
      };
    });
  }

  markFailed(requestId: string, code: string, message: string): Promise<PhoneRequestRecord> {
    const failureMessage = message.slice(0, 500);
    return this.db.runTransaction(this.transitionPaths(requestId), (documents) => {
      const request = this.loadRequest(documents, requestId);
      if (request.status === "failed") return value(request);
      if (["delivered", "acknowledged", "cancelled", "expired"].includes(request.status)) {
        return value(request);
      }
      assertTransition(request.status, "failed");
      return {
        value: { ...request, status: "failed" as const, failureCode: code, failureMessage },
        writes: [
          this.db.mergeWrite(`phoneRequests/${requestId}`, {
            status: "failed",
            failureCode: code,
            failureMessage,
          }),
          ...this.releaseWrites(documents, requestId),
        ],
      };
    });
  }

  async markDelivered(requestId: string, deviceId: string): Promise<PhoneRequestRecord> {
    const result = await this.db.runTransaction(this.transitionPaths(requestId), (documents) => {
      const request = this.loadRequest(documents, requestId);
      assertMatchingDevice(request, deviceId);
      if (request.status === "delivered" || request.status === "acknowledged") {
        return value({ request, expired: false });
      }

      const now = this.now();
      if (request.expiresAt.getTime() <= now.getTime()) {
        return this.terminateExpired(documents, request, "delivered_callback");
      }

      assertTransition(request.status, "delivered");
      const writes = [
        this.db.mergeWrite(`phoneRequests/${requestId}`, {
          status: "delivered",
          deliveredAt: now,
          ...(request.sentAt ? {} : { sentAt: now }),
        }),
      ];
      if (request.status === "created") {
        writes.push(
          this.eventWrite(requestId, "FCM_SEND_SUCCEEDED", { source: "device_receipt_recovery" }),
        );
      }
      writes.push(this.eventWrite(requestId, "FCM_RECEIVED", { deviceId }));
      return {
        value: {
          request: {
            ...request,
            status: "delivered" as const,
            sentAt: request.sentAt ?? now,
            deliveredAt: now,
          },
          expired: false,
        },
        writes,
      };
    });
    if (result.expired) throw errors.requestExpired();
    return result.request;
  }

  async acknowledge(requestId: string, deviceId: string): Promise<PhoneRequestRecord> {
    const result = await this.db.runTransaction(this.transitionPaths(requestId), (documents) => {
      const request = this.loadRequest(documents, requestId);
      assertMatchingDevice(request, deviceId);
      if (request.status === "acknowledged") return value({ request, expired: false });
      if (request.status === "cancelled" || request.status === "expired" || request.status === "failed") {
        return value({ request, expired: request.status === "expired" });
      }

      const now = this.now();
      if (request.expiresAt.getTime() <= now.getTime()) {
        return this.terminateExpired(documents, request, "acknowledge_callback");
      }

      assertTransition(request.status, "acknowledged");
      const writes = [
        this.db.mergeWrite(`phoneRequests/${requestId}`, {
          status: "acknowledged",
          sentAt: request.sentAt ?? now,
          deliveredAt: request.deliveredAt ?? now,
          acknowledgedAt: now,
        }),
        ...this.releaseWrites(documents, requestId),
      ];
      if (!request.deliveredAt) {
        writes.push(this.eventWrite(requestId, "FCM_RECEIVED", { deviceId, source: "ack_recovery" }));
      }
      writes.push(this.eventWrite(requestId, "REQUEST_ACKNOWLEDGED", { deviceId }));
      return {
        value: {
          request: {
            ...request,
            status: "acknowledged" as const,
            sentAt: request.sentAt ?? now,
            deliveredAt: request.deliveredAt ?? now,
            acknowledgedAt: now,
          },
          expired: false,
        },
        writes,
      };
    });
    if (result.expired) throw errors.requestExpired();
    return result.request;
  }

  cancel(
    requestId: string,
    uid: string,
  ): Promise<{ request: PhoneRequestRecord; deviceToken: string | null }> {
    return this.db.runTransaction<{ request: PhoneRequestRecord; deviceToken: string | null }>(
      this.transitionPaths(requestId, [`deviceCredentials/${this.targetDeviceId}`]),
      (documents) => {
        const request = this.loadRequest(documents, requestId);
        if (request.requestedBy.uid !== uid) {
          throw errors.forbidden("Only the requester can cancel this request.");
        }
        if (request.status === "cancelled") return value({ request, deviceToken: null });
        assertTransition(request.status, "cancelled");
        const now = this.now();
        const credentials = documents.get(`deviceCredentials/${this.targetDeviceId}`) ?? null;
        return {
          value: {
            request: { ...request, status: "cancelled" as const, cancelledAt: now },
            deviceToken: stringOrNull(credentials?.fcmToken),
          },
          writes: [
            this.db.mergeWrite(`phoneRequests/${requestId}`, { status: "cancelled", cancelledAt: now }),
            ...this.releaseWrites(documents, requestId),
            this.eventWrite(requestId, "REQUEST_CANCELLED", { uid }),
          ],
        };
      },
    );
  }

  expire(requestId: string): Promise<PhoneRequestRecord | null> {
    return this.db.runTransaction(this.transitionPaths(requestId), (documents) => {
      const data = documents.get(`phoneRequests/${requestId}`);
      if (!data) return value(null);
      const request = requestFromData(data, requestId);
      if (!ACTIVE_STATUSES.has(request.status)) return value(request);
      if (request.expiresAt.getTime() > this.now().getTime()) return value(request);
      const result = this.terminateExpired(documents, request, "expiry");
      return { value: result.value.request, writes: result.writes };
    });
  }

  async sweepExpired(limit: number): Promise<number> {
    const expiring = await this.db.query(
      "phoneRequests",
      [
        { field: "status", op: "IN", value: ["created", "sent", "delivered"] },
        { field: "expiresAt", op: "LESS_THAN_OR_EQUAL", value: this.now() },
      ],
      limit,
    );
    let terminated = 0;
    for (const entry of expiring) {
      const requestId = entry.path.split("/").pop() as string;
      const result = await this.expire(requestId);
      if (result && (result.status === "expired" || result.status === "failed")) terminated += 1;
    }
    return terminated;
  }

  /**
   * Deletes documents past their retention date. Firestore TTL policies do the
   * same thing but need a billing account, so the scheduled Worker sweeps them
   * instead. Retention is stamped on each document as `deleteAt`.
   */
  async purgeExpiredDocuments(limitPerCollection: number): Promise<number> {
    const now = this.now();
    let deleted = 0;
    for (const collection of ["idempotencyKeys", "requestEvents", "phoneRequests"]) {
      const stale = await this.db.query(
        collection,
        [{ field: "deleteAt", op: "LESS_THAN_OR_EQUAL", value: now }],
        limitPerCollection,
      );
      if (stale.length === 0) continue;
      await this.db.commit(stale.map((entry) => this.db.deleteWrite(entry.path)));
      deleted += stale.length;
    }
    return deleted;
  }

  async recordEvent(
    requestId: string,
    event: string,
    attributes: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.commit([this.eventWrite(requestId, event, attributes)]);
  }

  registerDevice(device: RegisteredDevice): Promise<void> {
    return this.db.runTransaction([`deviceRequestLocks/${device.deviceId}`], (documents) => {
      const now = this.now();
      const lock = documents.get(`deviceRequestLocks/${device.deviceId}`) ?? null;
      const lockExpiry = asDate(lock?.expiresAt);
      const busy = Boolean(
        stringOrNull(lock?.activeRequestId) && lockExpiry && lockExpiry.getTime() > now.getTime(),
      );
      return {
        value: undefined,
        writes: [
          this.db.mergeWrite(
            `devices/${device.deviceId}`,
            {
              deviceId: device.deviceId,
              displayName: TARGET_DISPLAY_NAME,
              active: true,
              availability: busy ? "busy" : "idle",
              lastSeenAt: now,
            },
            DEVICE_LEGACY_FIELDS,
          ),
          this.db.mergeWrite(`deviceMetadata/${device.deviceId}`, {
            deviceId: device.deviceId,
            deviceType: "target",
            platform: "android",
            appVersion: device.appVersion,
            deviceModel: device.deviceModel,
            capabilities: device.capabilities ?? { ring: true, vibration: true, tts: false },
            updatedAt: now,
          }),
          this.db.mergeWrite(`deviceCredentials/${device.deviceId}`, {
            deviceId: device.deviceId,
            fcmToken: device.fcmToken,
            lastTokenRefreshAt: now,
            updatedAt: now,
          }),
        ],
      };
    });
  }

  async heartbeat(deviceId: string, appVersion?: string): Promise<void> {
    const now = this.now();
    const writes = [
      this.db.mergeWrite(`devices/${deviceId}`, { deviceId, lastSeenAt: now }, DEVICE_LEGACY_FIELDS),
    ];
    if (appVersion) {
      writes.push(
        this.db.mergeWrite(`deviceMetadata/${deviceId}`, { deviceId, appVersion, updatedAt: now }),
      );
    }
    await this.db.commit(writes);
  }

  async getTargetPublicState(deviceId: string): Promise<TargetPublicState> {
    const data = await this.db.get(`devices/${deviceId}`);
    const lastSeenAt = asDate(data?.lastSeenAt);
    const ageMs = lastSeenAt ? this.now().getTime() - lastSeenAt.getTime() : null;
    return {
      deviceId,
      displayName: stringOrNull(data?.displayName) ?? TARGET_DISPLAY_NAME,
      active: data?.active === true,
      availability: data?.availability === "busy" ? "busy" : "idle",
      health:
        ageMs === null
          ? "never_seen"
          : ageMs < 5 * 60_000
            ? "likely_online"
            : ageMs <= 15 * 60_000
              ? "unknown"
              : "possibly_offline",
      lastSeenAt: lastSeenAt?.toISOString() ?? null,
    };
  }

  async readConfig(): Promise<SharedPhoneConfig> {
    return this.configFrom(await this.db.get("config/sharedPhone"));
  }

  private reserve(
    command: CreateCommand,
    requestId: string,
    expectedActiveRequestId: string | null,
    documents: ReadonlyMap<string, Data | null>,
  ): TransactionResult<ReservedRequest> {
    const deviceId = command.targetDeviceId;
    const existing = documents.get(`phoneRequests/${requestId}`);
    if (existing) {
      const request = requestFromData(existing, requestId);
      if (
        request.clientRequestId !== command.clientRequestId ||
        request.requestedBy.uid !== command.uid
      ) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key conflicts with another request.",
          409,
        );
      }
      return value({
        request,
        config: this.configFrom(documents.get("config/sharedPhone") ?? null),
        device: emptyDevice(deviceId),
        idempotentReplay: true,
      });
    }

    const now = this.now();
    const config = this.configFrom(documents.get("config/sharedPhone") ?? null);
    const displayName = normalizeDisplayName(documents.get(`users/${command.uid}`)?.displayName);
    if (!displayName) throw errors.profileMissing();

    const device = deviceFrom(
      documents.get(`devices/${deviceId}`) ?? null,
      documents.get(`deviceCredentials/${deviceId}`) ?? null,
      deviceId,
    );
    if (!device.active || !device.fcmToken) throw errors.targetUnavailable();

    const lastCreatedAt = asDate(documents.get(`userRequestLimits/${command.uid}`)?.lastCreatedAt);
    if (lastCreatedAt) {
      const retryMs =
        config.targetterCooldownSeconds * 1_000 - (now.getTime() - lastCreatedAt.getTime());
      if (retryMs > 0) throw errors.cooldown(Math.ceil(retryMs / 1_000));
    }

    const lock = documents.get(`deviceRequestLocks/${deviceId}`) ?? null;
    const activeRequestId = stringOrNull(lock?.activeRequestId);
    if (activeRequestId !== expectedActiveRequestId) throw errors.aborted();

    const writes: FirestoreWrite[] = [];
    if (!config.allowConcurrentRequests && activeRequestId && activeRequestId !== requestId) {
      const activeData = documents.get(`phoneRequests/${activeRequestId}`);
      if (activeData) {
        const active = requestFromData(activeData, activeRequestId);
        // The request is the source of truth for expiry. The lock's expiry is
        // a recovery hint and can be stale after a partial write, so a still
        // valid request is never expired just because that hint looks old.
        if (ACTIVE_STATUSES.has(active.status)) {
          if (active.expiresAt.getTime() > now.getTime()) throw errors.activeRequest(activeRequestId);
          const staleStatus: PhoneRequestStatus = active.status === "created" ? "failed" : "expired";
          writes.push(
            this.db.mergeWrite(`phoneRequests/${activeRequestId}`, {
              status: staleStatus,
              failureCode: staleStatus === "failed" ? DISPATCH_TIMEOUT_CODE : null,
              failureMessage: staleStatus === "failed" ? DISPATCH_TIMEOUT_MESSAGE : null,
            }),
            this.eventWrite(
              activeRequestId,
              staleStatus === "failed" ? "FCM_SEND_FAILED" : "REQUEST_EXPIRED",
              { recoveredByRequestId: requestId },
            ),
          );
        }
      }
    }

    const expiresAt = new Date(now.getTime() + config.requestTimeoutSeconds * 1_000);
    const request: PhoneRequestRecord = {
      requestId,
      clientRequestId: command.clientRequestId,
      targetDeviceId: deviceId,
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

    writes.push(
      this.db.setWrite(`phoneRequests/${requestId}`, requestToData(request), true),
      this.db.setWrite(
        `idempotencyKeys/${requestId}`,
        {
          uid: command.uid,
          clientRequestId: command.clientRequestId,
          requestId,
          createdAt: now,
          deleteAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
        },
        true,
      ),
      this.db.setWrite(`deviceRequestLocks/${deviceId}`, {
        targetDeviceId: deviceId,
        activeRequestId: requestId,
        expiresAt,
        updatedAt: now,
      }),
      this.db.mergeWrite(`devices/${deviceId}`, { availability: "busy" }, DEVICE_LEGACY_FIELDS),
      this.db.setWrite(`userRequestLimits/${command.uid}`, {
        uid: command.uid,
        lastCreatedAt: now,
        lastRequestId: requestId,
      }),
      this.eventWrite(requestId, "REQUEST_CREATED", {
        uid: command.uid,
        targetDeviceId: deviceId,
      }),
    );

    return { value: { request, config, device, idempotentReplay: false }, writes };
  }

  /**
   * Moves a request that outlived its deadline to a terminal state and frees
   * the shared phone. A request that never reached `sent` failed to dispatch,
   * so it is recorded as failed rather than expired.
   */
  private terminateExpired(
    documents: ReadonlyMap<string, Data | null>,
    request: PhoneRequestRecord,
    source: string,
  ): TransactionResult<{ request: PhoneRequestRecord; expired: true }> {
    const status: PhoneRequestStatus = request.status === "created" ? "failed" : "expired";
    const failure =
      status === "failed"
        ? { failureCode: DISPATCH_TIMEOUT_CODE, failureMessage: DISPATCH_TIMEOUT_MESSAGE }
        : {};
    return {
      value: { request: { ...request, status, ...failure }, expired: true },
      writes: [
        this.db.mergeWrite(`phoneRequests/${request.requestId}`, { status, ...failure }),
        ...this.releaseWrites(documents, request.requestId),
        this.eventWrite(
          request.requestId,
          status === "failed" ? "FCM_SEND_FAILED" : "REQUEST_EXPIRED",
          { source },
        ),
      ],
    };
  }

  /** Frees the single-device lock and marks the phone idle, if this request holds it. */
  private releaseWrites(
    documents: ReadonlyMap<string, Data | null>,
    requestId: string,
  ): FirestoreWrite[] {
    const lockPath = `deviceRequestLocks/${this.targetDeviceId}`;
    const lock = documents.get(lockPath) ?? null;
    if (stringOrNull(lock?.activeRequestId) !== requestId) return [];
    return [
      this.db.mergeWrite(lockPath, { updatedAt: this.now() }, ["activeRequestId", "expiresAt"]),
      this.db.mergeWrite(`devices/${this.targetDeviceId}`, { availability: "idle" }),
    ];
  }

  private transitionPaths(requestId: string, extra: string[] = []): string[] {
    return [
      `phoneRequests/${requestId}`,
      `deviceRequestLocks/${this.targetDeviceId}`,
      ...extra,
    ];
  }

  private loadRequest(
    documents: ReadonlyMap<string, Data | null>,
    requestId: string,
  ): PhoneRequestRecord {
    const data = documents.get(`phoneRequests/${requestId}`);
    if (!data) throw errors.requestNotFound();
    return requestFromData(data, requestId);
  }

  private eventWrite(
    requestId: string,
    event: string,
    attributes: Record<string, unknown> = {},
  ): FirestoreWrite {
    const now = this.now();
    return this.db.setWrite(
      `requestEvents/evt_${crypto.randomUUID().replace(/-/gu, "")}`,
      {
        requestId,
        event,
        createdAt: now,
        deleteAt: new Date(now.getTime() + EVENT_RETENTION_MS),
        ...sanitizeAttributes(attributes),
      },
      true,
    );
  }

  private configFrom(data: Data | null): SharedPhoneConfig {
    return {
      targetDeviceId: this.targetDeviceId,
      ringDurationSeconds: bounded(data?.ringDurationSeconds, 3, 30, DEFAULT_CONFIG.ringDurationSeconds),
      requestTimeoutSeconds: bounded(
        data?.requestTimeoutSeconds,
        30,
        300,
        DEFAULT_CONFIG.requestTimeoutSeconds,
      ),
      targetterCooldownSeconds: bounded(
        data?.targetterCooldownSeconds,
        5,
        300,
        DEFAULT_CONFIG.targetterCooldownSeconds,
      ),
      allowConcurrentRequests: data?.allowConcurrentRequests === true,
      vibrationEnabled: data?.vibrationEnabled !== false,
      ttsEnabled: data?.ttsEnabled === true,
      deliveryTimeoutSeconds: bounded(
        data?.deliveryTimeoutSeconds,
        5,
        60,
        DEFAULT_CONFIG.deliveryTimeoutSeconds,
      ),
    };
  }
}

export async function deterministicRequestId(
  uid: string,
  clientRequestId: string,
): Promise<string> {
  return `req_${(await sha256(`${uid}:${clientRequestId}`)).slice(0, 32)}`;
}

function value<T>(result: T): TransactionResult<T> {
  return { value: result, writes: [] };
}

function requestToData(request: PhoneRequestRecord): Data {
  return {
    requestId: request.requestId,
    clientRequestId: request.clientRequestId,
    targetDeviceId: request.targetDeviceId,
    requestedBy: request.requestedBy,
    status: request.status,
    createdAt: request.createdAt,
    sentAt: null,
    deliveredAt: null,
    acknowledgedAt: null,
    cancelledAt: null,
    expiresAt: request.expiresAt,
    failureCode: null,
    failureMessage: null,
    deleteAt: new Date(request.createdAt.getTime() + REQUEST_RETENTION_MS),
  };
}

function requestFromData(data: Data, requestId: string): PhoneRequestRecord {
  const requestedBy = (data.requestedBy ?? {}) as { uid?: unknown; name?: unknown };
  return {
    requestId: stringOrNull(data.requestId) ?? requestId,
    clientRequestId: String(data.clientRequestId ?? ""),
    targetDeviceId: String(data.targetDeviceId ?? ""),
    requestedBy: { uid: String(requestedBy.uid ?? ""), name: String(requestedBy.name ?? "") },
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

function deviceFrom(
  device: Data | null,
  credentials: Data | null,
  deviceId: string,
): TargetDeviceRecord {
  return {
    deviceId,
    displayName: stringOrNull(device?.displayName) ?? TARGET_DISPLAY_NAME,
    active: device?.active === true,
    fcmToken: stringOrNull(credentials?.fcmToken) ?? "",
    lastSeenAt: asDate(device?.lastSeenAt),
  };
}

function emptyDevice(deviceId: string): TargetDeviceRecord {
  return { deviceId, displayName: TARGET_DISPLAY_NAME, active: false, fcmToken: "", lastSeenAt: null };
}

function bounded(candidate: unknown, min: number, max: number, fallback: number): number {
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= min && candidate <= max
    ? Math.round(candidate)
    : fallback;
}

function asDate(candidate: unknown): Date | null {
  return candidate instanceof Date ? candidate : null;
}

function requiredDate(candidate: unknown, field: string): Date {
  const date = asDate(candidate);
  if (!date) throw new AppError("CORRUPT_REQUEST", `Request has invalid ${field}.`, 500);
  return date;
}

function stringOrNull(candidate: unknown): string | null {
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function sanitizeAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key, attribute]) => !/token|secret|authorization/iu.test(key) && attribute !== undefined,
    ),
  );
}

function assertMatchingDevice(request: PhoneRequestRecord, deviceId: string): void {
  if (request.targetDeviceId !== deviceId) {
    throw errors.forbidden("The request belongs to a different target device.");
  }
}

function isContention(error: unknown): boolean {
  return (
    error instanceof AppError && (error.code === "ABORTED" || error.details?.providerStatus === 409)
  );
}
