import { AppError } from "./errors";
import type { Env, FirestoreDocument, FirestoreValue, FirestoreWrite } from "./types";
import { GoogleClient } from "./google";

type Fetch = typeof fetch;
export type Data = Record<string, unknown>;

export interface TransactionResult<T> {
  value: T;
  writes: FirestoreWrite[];
}

export class FirestoreRest {
  readonly root: string;

  constructor(
    private readonly env: Env,
    private readonly google: GoogleClient,
    private readonly fetcher: Fetch = fetch,
  ) {
    this.root = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  }

  name(path: string): string {
    return `${this.root}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }

  path(name: string): string {
    const marker = "/documents/";
    return decodeURIComponent(name.slice(name.indexOf(marker) + marker.length));
  }

  async get(path: string): Promise<Data | null> {
    const response = await this.request(`https://firestore.googleapis.com/v1/${this.name(path)}`, { method: "GET" }, true);
    if (response.status === 404) return null;
    if (!response.ok) await throwFirestore(response);
    return decodeDocument(await response.json() as FirestoreDocument);
  }

  async runTransaction<T>(
    paths: string[],
    operation: (documents: ReadonlyMap<string, Data | null>) => Promise<TransactionResult<T>> | TransactionResult<T>,
    maxAttempts = 5,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const transaction = await this.beginTransaction();
      try {
        const documents = await this.batchGet(paths, transaction);
        const result = await operation(documents);
        await this.commit(result.writes, transaction);
        return result.value;
      } catch (error) {
        lastError = error;
        void this.rollback(transaction);
        if (!isRetryableTransactionError(error) || attempt === maxAttempts - 1) throw error;
      }
    }
    throw lastError;
  }

  async commit(writes: FirestoreWrite[], transaction?: string): Promise<void> {
    // An open transaction must always be committed or rolled back, so a
    // read-only transaction still round-trips with an empty write list.
    if (writes.length === 0 && !transaction) return;
    const response = await this.request(
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.env.FIREBASE_PROJECT_ID)}/databases/(default)/documents:commit`,
      { method: "POST", body: JSON.stringify({ writes, ...(transaction ? { transaction } : {}) }) },
    );
    if (!response.ok) await throwFirestore(response);
  }

  /** Replaces the whole document. Fields absent from `data` are removed. */
  setWrite(path: string, data: Data, createOnly = false): FirestoreWrite {
    return {
      update: { name: this.name(path), fields: encodeData(data) },
      ...(createOnly ? { currentDocument: { exists: false } } : {}),
    };
  }

  /**
   * Merges `data` into the document, leaving unlisted fields untouched.
   * `removeFields` are added to the update mask without a value, which is how
   * the REST API deletes a field, and is used to strip fields written by an
   * older deployment so `devices/{id}` stays a safe public projection.
   */
  mergeWrite(path: string, data: Data, removeFields: string[] = []): FirestoreWrite {
    const fields = encodeData(data);
    // Firestore rejects a mask that repeats a field path.
    const fieldPaths = [...new Set([...Object.keys(fields), ...removeFields])];
    return {
      update: { name: this.name(path), fields },
      updateMask: { fieldPaths },
    };
  }

  deleteWrite(path: string): FirestoreWrite {
    return { delete: this.name(path) };
  }

  async query(collectionId: string, filters: QueryFilter[], limit: number): Promise<Array<{ path: string; data: Data }>> {
    const where = filters.length === 0
      ? undefined
      : filters.length === 1
        ? { fieldFilter: toFieldFilter(filters[0]!) }
        : { compositeFilter: { op: "AND", filters: filters.map((filter) => ({ fieldFilter: toFieldFilter(filter) })) } };
    const response = await this.request(
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.env.FIREBASE_PROJECT_ID)}/databases/(default)/documents:runQuery`,
      {
        method: "POST",
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId }],
            ...(where ? { where } : {}),
            limit: Math.min(Math.max(limit, 1), 200),
          },
        }),
      },
    );
    if (!response.ok) await throwFirestore(response);
    const results = await responseObjects(await response.text()) as Array<{ document?: FirestoreDocument }>;
    return results.flatMap((entry) => entry.document
      ? [{ path: this.path(entry.document.name), data: decodeDocument(entry.document) }]
      : []);
  }

  private async beginTransaction(): Promise<string> {
    const response = await this.request(
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.env.FIREBASE_PROJECT_ID)}/databases/(default)/documents:beginTransaction`,
      { method: "POST", body: "{}" },
    );
    if (!response.ok) await throwFirestore(response);
    const data = await response.json() as { transaction?: string };
    if (!data.transaction) throw new AppError("FIRESTORE_ERROR", "Firestore did not start a transaction.", 503, true);
    return data.transaction;
  }

  private async batchGet(paths: string[], transaction: string): Promise<Map<string, Data | null>> {
    const unique = [...new Set(paths)];
    if (unique.length === 0) return new Map();
    const response = await this.request(
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.env.FIREBASE_PROJECT_ID)}/databases/(default)/documents:batchGet`,
      { method: "POST", body: JSON.stringify({ documents: unique.map((path) => this.name(path)), transaction }) },
    );
    if (!response.ok) await throwFirestore(response);
    const results = await responseObjects(await response.text()) as Array<{ found?: FirestoreDocument; missing?: string }>;
    const documents = new Map<string, Data | null>(unique.map((path) => [path, null]));
    for (const result of results) {
      if (result.found) documents.set(this.path(result.found.name), decodeDocument(result.found));
      if (result.missing) documents.set(this.path(result.missing), null);
    }
    return documents;
  }

  private async rollback(transaction: string): Promise<void> {
    await this.request(
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.env.FIREBASE_PROJECT_ID)}/databases/(default)/documents:rollback`,
      { method: "POST", body: JSON.stringify({ transaction }) },
    ).catch(() => undefined);
  }

  private async request(url: string, init: RequestInit, allowNotFound = false): Promise<Response> {
    const token = await this.google.accessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await this.fetcher(url, { ...init, headers });
    if (!allowNotFound && response.status === 404) await throwFirestore(response);
    return response;
  }
}

export interface QueryFilter {
  field: string;
  op: "EQUAL" | "LESS_THAN_OR_EQUAL" | "IN";
  value: unknown;
}

function toFieldFilter(filter: QueryFilter): object {
  return { field: { fieldPath: filter.field }, op: filter.op, value: encodeValue(filter.value) };
}

export function encodeData(data: Data): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined).map(([key, value]) => [key, encodeValue(value)]),
  );
}

export function encodeValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value)
    ? { integerValue: String(value) }
    : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === "object") return { mapValue: { fields: encodeData(value as Data) } };
  throw new AppError("FIRESTORE_ENCODING", "A value could not be stored.", 500);
}

export function decodeDocument(document: FirestoreDocument): Data {
  return Object.fromEntries(Object.entries(document.fields ?? {}).map(([key, value]) => [key, decodeValue(value)]));
}

export function decodeValue(value: FirestoreValue): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return new Date(value.timestampValue);
  if ("stringValue" in value) return value.stringValue;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in value) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, child]) => [key, decodeValue(child)]));
  return null;
}

async function responseObjects(text: string): Promise<unknown[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  }
}

async function throwFirestore(response: Response): Promise<never> {
  let status = "";
  try {
    const data = await response.clone().json() as { error?: { status?: string } };
    status = data.error?.status ?? "";
  } catch { /* redact provider payload */ }
  const retryable = response.status === 409 || response.status === 429 || response.status >= 500;
  throw new AppError(status || "FIRESTORE_ERROR", "The data store request failed.", retryable ? 503 : 500, retryable, { providerStatus: response.status });
}

function isRetryableTransactionError(error: unknown): boolean {
  return error instanceof AppError && (error.details?.providerStatus === 409 || error.code === "ABORTED");
}
