import { FirestoreRest, decodeValue, encodeData } from "../firestore";
import type { GoogleClient } from "../google";
import type { Env, FirestoreDocument, FirestoreValue, FirestoreWrite } from "../types";

export const TEST_ENV: Env = {
  APP_ENVIRONMENT: "dev",
  FIREBASE_PROJECT_ID: "arnifi-phone-bell-test",
  GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
  DEVICE_ENROLLMENT_CODE: "enrollment-code-for-tests",
  ALLOWED_WORKSPACE_DOMAIN: "arnifi.com",
  TARGET_DEVICE_ID: "uae-phone-01",
};

const ROOT = `projects/${TEST_ENV.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

interface StructuredQuery {
  from?: Array<{ collectionId?: string }>;
  where?: {
    fieldFilter?: FieldFilter;
    compositeFilter?: { filters?: Array<{ fieldFilter?: FieldFilter }> };
  };
  limit?: number;
}

interface FieldFilter {
  field?: { fieldPath?: string };
  op?: string;
  value?: FirestoreValue;
}

/**
 * An in-memory stand-in for the Firestore REST API. It implements enough of
 * `get`, `batchGet`, `commit` (including update masks and precondition
 * checks), `runQuery` and the transaction endpoints for the repository to run
 * against its real serialization and transaction code.
 */
export class FakeFirestore {
  readonly documents = new Map<string, Record<string, FirestoreValue>>();
  /** Committed write batches, in order, for assertions about contention. */
  readonly commits: FirestoreWrite[][] = [];
  private transactionCounter = 0;
  private readonly openTransactions = new Set<string>();
  /** Runs before a commit is applied, to simulate a concurrent writer. */
  onBeforeCommit?: () => void;

  seed(path: string, data: Record<string, unknown>): void {
    this.documents.set(path, encodeData(data));
  }

  read(path: string): Record<string, unknown> | null {
    const fields = this.documents.get(path);
    if (!fields) return null;
    return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
  }

  client(): FirestoreRest {
    const google = { accessToken: async () => "test-access-token" } as unknown as GoogleClient;
    return new FirestoreRest(TEST_ENV, google, this.fetch);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (url.endsWith(":beginTransaction")) {
      this.transactionCounter += 1;
      const transaction = `tx-${this.transactionCounter}`;
      this.openTransactions.add(transaction);
      return Response.json({ transaction });
    }

    if (url.endsWith(":rollback")) {
      this.openTransactions.delete(String(body.transaction));
      return Response.json({});
    }

    if (url.endsWith(":batchGet")) {
      const names = (body.documents as string[]) ?? [];
      return Response.json(
        names.map((name) => {
          const fields = this.documents.get(pathOf(name));
          return fields ? { found: { name, fields } } : { missing: name };
        }),
      );
    }

    if (url.endsWith(":commit")) {
      this.onBeforeCommit?.();
      const writes = (body.writes as FirestoreWrite[]) ?? [];
      const failure = this.apply(writes);
      this.openTransactions.delete(String(body.transaction));
      if (failure) return failure;
      this.commits.push(writes);
      return Response.json({ writeResults: writes.map(() => ({})) });
    }

    if (url.endsWith(":runQuery")) {
      return Response.json(this.runQuery(body.structuredQuery as StructuredQuery));
    }

    if (init?.method === "GET" || init?.method === undefined) {
      const path = pathOf(url.slice(url.indexOf("/v1/") + 4));
      const fields = this.documents.get(path);
      if (!fields) {
        return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      }
      return Response.json({ name: `${ROOT}/${path}`, fields } satisfies FirestoreDocument);
    }

    return Response.json({ error: { status: "UNIMPLEMENTED" } }, { status: 501 });
  };

  private apply(writes: FirestoreWrite[]): Response | null {
    const staged = new Map(this.documents);
    for (const write of writes) {
      if (write.delete) {
        staged.delete(pathOf(write.delete));
        continue;
      }
      if (!write.update) continue;
      const path = pathOf(write.update.name);
      const exists = staged.has(path);
      if (write.currentDocument?.exists === false && exists) {
        return Response.json({ error: { status: "ALREADY_EXISTS" } }, { status: 409 });
      }
      if (write.currentDocument?.exists === true && !exists) {
        return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
      }
      const incoming = write.update.fields ?? {};
      if (!write.updateMask) {
        staged.set(path, { ...incoming });
        continue;
      }
      const merged = { ...(staged.get(path) ?? {}) };
      for (const field of write.updateMask.fieldPaths) {
        const value = incoming[field];
        if (value === undefined) delete merged[field];
        else merged[field] = value;
      }
      staged.set(path, merged);
    }
    this.documents.clear();
    for (const [path, fields] of staged) this.documents.set(path, fields);
    return null;
  }

  private runQuery(query: StructuredQuery): Array<{ document: FirestoreDocument }> {
    const collectionId = query.from?.[0]?.collectionId ?? "";
    const filters = query.where?.compositeFilter?.filters?.map((entry) => entry.fieldFilter) ??
      (query.where?.fieldFilter ? [query.where.fieldFilter] : []);
    const matches: Array<{ document: FirestoreDocument }> = [];
    for (const [path, fields] of this.documents) {
      const segments = path.split("/");
      if (segments.length !== 2 || segments[0] !== collectionId) continue;
      if (!filters.every((filter) => filter && matchesFilter(fields, filter))) continue;
      matches.push({ document: { name: `${ROOT}/${path}`, fields } });
      if (matches.length >= (query.limit ?? 100)) break;
    }
    return matches;
  }
}

function matchesFilter(fields: Record<string, FirestoreValue>, filter: FieldFilter): boolean {
  const field = filter.field?.fieldPath ?? "";
  const raw = fields[field];
  if (raw === undefined) return false;
  const actual = decodeValue(raw);
  const expected = filter.value ? decodeValue(filter.value) : undefined;
  switch (filter.op) {
    case "EQUAL":
      return comparable(actual) === comparable(expected);
    case "IN":
      return Array.isArray(expected) && expected.some((entry) => comparable(entry) === comparable(actual));
    case "LESS_THAN_OR_EQUAL":
      return actual instanceof Date && expected instanceof Date
        ? actual.getTime() <= expected.getTime()
        : Number(actual) <= Number(expected);
    default:
      return false;
  }
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function pathOf(name: string): string {
  const marker = "/documents/";
  const index = name.indexOf(marker);
  const relative = index === -1 ? name : name.slice(index + marker.length);
  return decodeURIComponent(relative);
}
