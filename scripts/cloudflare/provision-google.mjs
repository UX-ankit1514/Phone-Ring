#!/usr/bin/env node

/**
 * Prepare the Google side of the zero-cost Cloudflare Worker deployment.
 *
 * Security invariants:
 * - Reuses the Firebase CLI's cached OAuth session in memory; never prints it.
 * - Never writes a Google service-account private key to disk.
 * - Pipes Worker secrets to Wrangler over stdin and never includes them in argv.
 * - Emits structured status containing identifiers only, never credential values.
 *
 * Node.js 22+ is required. Run `node scripts/cloudflare/provision-google.mjs help`
 * for commands and examples.
 */

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const firebaseAuth = require("firebase-tools/lib/auth");

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const FIREBASERC_PATH = join(REPOSITORY_ROOT, ".firebaserc");

const SERVICE_ACCOUNT_ID = "arnifi-phone-bell-worker";
const SERVICE_ACCOUNT_DISPLAY_NAME = "Arnifi Phone Bell Cloudflare Worker";
const GOOGLE_SERVICE_ACCOUNT_SECRET = "GOOGLE_SERVICE_ACCOUNT_JSON";
const ENROLLMENT_CODE_SECRET = "DEVICE_ENROLLMENT_CODE";

// These APIs do not require a paid Firebase plan merely to be enabled. The
// application uses Firestore, Firebase Auth and FCM within their Spark quotas.
const REQUIRED_SERVICES = Object.freeze([
  "cloudresourcemanager.googleapis.com",
  "fcm.googleapis.com",
  "firebase.googleapis.com",
  "firestore.googleapis.com",
  "iam.googleapis.com",
  "identitytoolkit.googleapis.com",
  "serviceusage.googleapis.com",
]);

// Firestore's IAM method mapping requires datastore.databases.get for
// beginTransaction/rollback; entity permissions cover document reads, queries,
// creates, updates and deletes (including transaction commits).
const CUSTOM_ROLES = Object.freeze([
  {
    roleId: "arnifiPhoneBellFirestoreData",
    title: "Arnifi Phone Bell Firestore Data",
    description:
      "Minimum Firestore document and transaction access for the Phone Bell Worker.",
    includedPermissions: [
      "datastore.databases.get",
      "datastore.entities.create",
      "datastore.entities.delete",
      "datastore.entities.get",
      "datastore.entities.list",
      "datastore.entities.update",
    ],
    stage: "GA",
  },
  {
    roleId: "arnifiPhoneBellAuthDevice",
    title: "Arnifi Phone Bell Device Identity",
    description:
      "Create and stamp custom claims on the single target-device identity during enrollment.",
    includedPermissions: [
      "firebaseauth.users.create",
      "firebaseauth.users.get",
      "firebaseauth.users.update",
    ],
    stage: "GA",
  },
  {
    roleId: "arnifiPhoneBellFcmSender",
    title: "Arnifi Phone Bell FCM Sender",
    description: "Send FCM HTTP v1 messages; no topic or configuration access.",
    includedPermissions: ["cloudmessaging.messages.create"],
    stage: "GA",
  },
]);

const FIREBASE_AUTH_SCOPES = Object.freeze([
  "openid",
  "email",
  "https://www.googleapis.com/auth/cloudplatformprojects.readonly",
  "https://www.googleapis.com/auth/firebase",
  "https://www.googleapis.com/auth/cloud-platform",
]);

const API_ORIGINS = Object.freeze({
  cloudResourceManager: "https://cloudresourcemanager.googleapis.com",
  firebaseManagement: "https://firebase.googleapis.com",
  iam: "https://iam.googleapis.com",
  serviceUsage: "https://serviceusage.googleapis.com",
});

const HELP = `
Arnifi Phone Bell Google/Cloudflare provisioning

Usage:
  node scripts/cloudflare/provision-google.mjs <command> [options]

Commands:
  status             Read-only status for the selected Firebase project(s).
  apply              Enable APIs, create/update custom roles and the dedicated
                     service account, and grant its least-privilege roles.
  install-secrets    Run apply, create a new service-account key in memory, fetch
                     the Firebase Web API key, create/read an enrollment code,
                     and pipe all three directly to Wrangler secret bulk.
  delete-key         Delete one exact user-managed service-account key.
  help               Show this help.

Options:
  --project <dev|prod|all|project-id>  Default: all
  --worker-dir <path>                  Default: worker
  --wrangler-env <name>                Defaults to dev/prod for aliases; omit
                                       only with --no-wrangler-env.
  --no-wrangler-env                    Use the top-level Wrangler environment.
  --enrollment-code-file <path>        Read an existing code (24-256 chars).
                                       Otherwise a new code is written to a
                                       mode-0600 file in a mode-0700 temp dir.
  --retire-old-keys                    After Wrangler accepts the new secrets,
                                       revoke older user-managed keys belonging
                                       to this dedicated service account.
  --key-id <id>                        Required by delete-key.
  --confirm-delete <id>                Required by delete-key and must exactly
                                       match --key-id.

Examples:
  node scripts/cloudflare/provision-google.mjs status --project all
  node scripts/cloudflare/provision-google.mjs apply --project all
  node scripts/cloudflare/provision-google.mjs install-secrets --project dev
  node scripts/cloudflare/provision-google.mjs install-secrets --project prod --retire-old-keys
  node scripts/cloudflare/provision-google.mjs delete-key --project dev --key-id KEY_ID --confirm-delete KEY_ID
`;

class SafeError extends Error {
  constructor(message, code = "PROVISIONING_ERROR", status = undefined) {
    super(message);
    this.name = "SafeError";
    this.code = code;
    this.status = status;
  }
}

function assertNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new SafeError("Node.js 22 or newer is required.", "UNSUPPORTED_NODE");
  }
}

function parseArguments(argv) {
  const command = argv[0] ?? "help";
  const options = {
    project: "all",
    workerDir: join(REPOSITORY_ROOT, "worker"),
    wranglerEnv: undefined,
    useWranglerEnv: true,
    enrollmentCodeFile: undefined,
    retireOldKeys: false,
    keyId: undefined,
    confirmDelete: undefined,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      const value = argv[index];
      if (!value || value.startsWith("--")) {
        throw new SafeError(`Missing value for ${argument}.`, "INVALID_ARGUMENT");
      }
      return value;
    };

    switch (argument) {
      case "--project":
        options.project = next();
        break;
      case "--worker-dir": {
        const workerDir = next();
        options.workerDir = isAbsolute(workerDir)
          ? workerDir
          : resolve(REPOSITORY_ROOT, workerDir);
        break;
      }
      case "--wrangler-env":
        options.wranglerEnv = next();
        break;
      case "--no-wrangler-env":
        options.useWranglerEnv = false;
        break;
      case "--enrollment-code-file": {
        const codeFile = next();
        options.enrollmentCodeFile = isAbsolute(codeFile)
          ? codeFile
          : resolve(process.cwd(), codeFile);
        break;
      }
      case "--retire-old-keys":
        options.retireOldKeys = true;
        break;
      case "--key-id":
        options.keyId = next();
        break;
      case "--confirm-delete":
        options.confirmDelete = next();
        break;
      default:
        throw new SafeError(`Unknown argument: ${argument}.`, "INVALID_ARGUMENT");
    }
  }

  if (!["status", "apply", "install-secrets", "delete-key", "help"].includes(command)) {
    throw new SafeError(`Unknown command: ${command}.`, "INVALID_ARGUMENT");
  }
  if (options.retireOldKeys && command !== "install-secrets") {
    throw new SafeError(
      "--retire-old-keys is only valid with install-secrets.",
      "INVALID_ARGUMENT",
    );
  }
  return { command, options };
}

async function loadProjectAliases() {
  let data;
  try {
    data = JSON.parse(await readFile(FIREBASERC_PATH, "utf8"));
  } catch (error) {
    throw new SafeError(
      `Unable to read Firebase project aliases from ${FIREBASERC_PATH}.`,
      "FIREBASERC_UNAVAILABLE",
    );
  }

  const projects = data?.projects;
  if (!projects?.dev || !projects?.prod) {
    throw new SafeError(
      ".firebaserc must contain both dev and prod project aliases.",
      "FIREBASERC_INVALID",
    );
  }
  return { dev: String(projects.dev), prod: String(projects.prod) };
}

function selectProjects(selection, aliases) {
  if (selection === "all") {
    return [
      { environment: "dev", projectId: aliases.dev },
      { environment: "prod", projectId: aliases.prod },
    ];
  }
  if (selection === "dev" || selection === "prod") {
    return [{ environment: selection, projectId: aliases[selection] }];
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(selection)) {
    throw new SafeError("Invalid Firebase project ID.", "INVALID_PROJECT");
  }
  const knownEnvironment = Object.entries(aliases).find(([, id]) => id === selection)?.[0];
  return [{ environment: knownEnvironment ?? "custom", projectId: selection }];
}

async function getGoogleAccessToken() {
  const account =
    firebaseAuth.getProjectDefaultAccount(REPOSITORY_ROOT) ??
    firebaseAuth.getGlobalDefaultAccount();
  const refreshToken = account?.tokens?.refresh_token;
  if (!refreshToken) {
    throw new SafeError(
      "No Firebase CLI session was found. Run `npx firebase login --reauth` locally and retry.",
      "FIREBASE_LOGIN_REQUIRED",
    );
  }

  try {
    const tokens = await firebaseAuth.getAccessToken(
      refreshToken,
      [...FIREBASE_AUTH_SCOPES],
    );
    if (!tokens?.access_token) {
      throw new Error("Access token missing");
    }
    return tokens.access_token;
  } catch {
    throw new SafeError(
      "The Firebase CLI session cannot authorize Google Cloud provisioning. Run `npx firebase login --reauth` and retry.",
      "FIREBASE_REAUTH_REQUIRED",
    );
  }
}

function safeApiMessage(body, fallback) {
  const message = body?.error?.message;
  if (typeof message !== "string") return fallback;
  return redact(message).slice(0, 600);
}

function redact(value) {
  return String(value)
    .replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/("(?:private_key|access_token|refresh_token|id_token)"\s*:\s*")[^"]+/gi, "$1[REDACTED]")
    .replace(/(?:ya29\.|1\/\/|4\/)[A-Za-z0-9._\/-]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]");
}

async function apiRequest(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const text = await response.text();
  let body;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  if (!response.ok && !options.allowedStatuses?.includes(response.status)) {
    throw new SafeError(
      safeApiMessage(body, `Google API request failed with HTTP ${response.status}.`),
      "GOOGLE_API_ERROR",
      response.status,
    );
  }
  return { status: response.status, body, headers: response.headers };
}

async function waitForOperation(token, origin, operationName) {
  if (!operationName) return;
  const deadline = Date.now() + 120_000;
  const encodedName = operationName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  while (Date.now() < deadline) {
    const { body } = await apiRequest(token, `${origin}/v1/${encodedName}`);
    if (body?.done) {
      if (body.error) {
        throw new SafeError(
          safeApiMessage({ error: body.error }, "Google operation failed."),
          "GOOGLE_OPERATION_ERROR",
          body.error.code,
        );
      }
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new SafeError("Timed out waiting for a Google API operation.", "OPERATION_TIMEOUT");
}

async function getServiceStates(token, projectId) {
  return Promise.all(
    REQUIRED_SERVICES.map(async (service) => {
      const { status, body } = await apiRequest(
        token,
        `${API_ORIGINS.serviceUsage}/v1/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(service)}`,
        { allowedStatuses: [404] },
      );
      return {
        service,
        enabled: status === 200 && body?.state === "ENABLED",
      };
    }),
  );
}

async function enableRequiredServices(token, projectId) {
  const { body } = await apiRequest(
    token,
    `${API_ORIGINS.serviceUsage}/v1/projects/${encodeURIComponent(projectId)}/services:batchEnable`,
    {
      method: "POST",
      body: JSON.stringify({ serviceIds: REQUIRED_SERVICES }),
    },
  );
  await waitForOperation(token, API_ORIGINS.serviceUsage, body?.name);
}

function serviceAccountEmail(projectId) {
  return `${SERVICE_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
}

function serviceAccountResource(projectId) {
  return `projects/${projectId}/serviceAccounts/${serviceAccountEmail(projectId)}`;
}

async function getServiceAccount(token, projectId) {
  const email = serviceAccountEmail(projectId);
  const { status, body } = await apiRequest(
    token,
    `${API_ORIGINS.iam}/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts/${encodeURIComponent(email)}`,
    { allowedStatuses: [404] },
  );
  return status === 200 ? body : undefined;
}

async function ensureServiceAccount(token, projectId) {
  const existing = await getServiceAccount(token, projectId);
  if (existing) return { account: existing, changed: false };

  const { body } = await apiRequest(
    token,
    `${API_ORIGINS.iam}/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts`,
    {
      method: "POST",
      body: JSON.stringify({
        accountId: SERVICE_ACCOUNT_ID,
        serviceAccount: {
          displayName: SERVICE_ACCOUNT_DISPLAY_NAME,
          description:
            "Dedicated non-human identity for the Arnifi Phone Bell Cloudflare Worker.",
        },
      }),
    },
  );
  return { account: body, changed: true };
}

function customRoleName(projectId, roleId) {
  return `projects/${projectId}/roles/${roleId}`;
}

async function getCustomRole(token, projectId, roleId) {
  const name = customRoleName(projectId, roleId);
  const { status, body } = await apiRequest(
    token,
    `${API_ORIGINS.iam}/v1/${name}`,
    { allowedStatuses: [404] },
  );
  return status === 200 ? body : undefined;
}

function roleMatches(actual, expected) {
  if (!actual || actual.deleted) return false;
  const actualPermissions = [...(actual.includedPermissions ?? [])].sort();
  const expectedPermissions = [...expected.includedPermissions].sort();
  return (
    actual.title === expected.title &&
    actual.description === expected.description &&
    actual.stage === expected.stage &&
    JSON.stringify(actualPermissions) === JSON.stringify(expectedPermissions)
  );
}

async function ensureCustomRole(token, projectId, definition) {
  const existing = await getCustomRole(token, projectId, definition.roleId);
  if (!existing) {
    const { body } = await apiRequest(
      token,
      `${API_ORIGINS.iam}/v1/projects/${encodeURIComponent(projectId)}/roles`,
      {
        method: "POST",
        body: JSON.stringify({
          roleId: definition.roleId,
          role: {
            title: definition.title,
            description: definition.description,
            includedPermissions: definition.includedPermissions,
            stage: definition.stage,
          },
        }),
      },
    );
    return { role: body, changed: true };
  }
  if (roleMatches(existing, definition)) {
    return { role: existing, changed: false };
  }

  const name = customRoleName(projectId, definition.roleId);
  const { body } = await apiRequest(
    token,
    `${API_ORIGINS.iam}/v1/${name}?updateMask=title,description,includedPermissions,stage`,
    {
      method: "PATCH",
      body: JSON.stringify({
        name,
        etag: existing.etag,
        title: definition.title,
        description: definition.description,
        includedPermissions: definition.includedPermissions,
        stage: definition.stage,
      }),
    },
  );
  return { role: body, changed: true };
}

async function getProjectIamPolicy(token, projectId) {
  const { body } = await apiRequest(
    token,
    `${API_ORIGINS.cloudResourceManager}/v1/projects/${encodeURIComponent(projectId)}:getIamPolicy`,
    {
      method: "POST",
      body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
    },
  );
  return body;
}

function hasRoleBinding(policy, role, member) {
  return (policy?.bindings ?? []).some(
    (binding) =>
      binding.role === role &&
      !binding.condition &&
      (binding.members ?? []).includes(member),
  );
}

async function ensureRoleBindings(token, projectId, roleNames, email) {
  const member = `serviceAccount:${email}`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const policy = await getProjectIamPolicy(token, projectId);
    const missing = roleNames.filter((role) => !hasRoleBinding(policy, role, member));
    if (missing.length === 0) return { changed: false, addedRoles: [] };

    const bindings = [...(policy.bindings ?? [])];
    for (const role of missing) {
      const unconditioned = bindings.find(
        (binding) => binding.role === role && !binding.condition,
      );
      if (unconditioned) {
        unconditioned.members = [...new Set([...(unconditioned.members ?? []), member])];
      } else {
        bindings.push({ role, members: [member] });
      }
    }

    try {
      await apiRequest(
        token,
        `${API_ORIGINS.cloudResourceManager}/v1/projects/${encodeURIComponent(projectId)}:setIamPolicy`,
        {
          method: "POST",
          body: JSON.stringify({
            policy: {
              ...policy,
              version: Math.max(3, policy.version ?? 0),
              bindings,
            },
            updateMask: "bindings,etag,version",
          }),
        },
      );
      return { changed: true, addedRoles: missing };
    } catch (error) {
      if (
        error instanceof SafeError &&
        [409, 412].includes(error.status) &&
        attempt < 4
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new SafeError("Unable to update IAM policy after retries.", "IAM_CONFLICT");
}

async function listUserManagedKeys(token, projectId) {
  const resource = serviceAccountResource(projectId);
  const { body } = await apiRequest(
    token,
    `${API_ORIGINS.iam}/v1/${resource}/keys?keyTypes=USER_MANAGED`,
  );
  return (body?.keys ?? []).map((key) => ({
    name: key.name,
    keyId: key.name?.split("/").at(-1),
    validAfterTime: key.validAfterTime,
    validBeforeTime: key.validBeforeTime,
    keyAlgorithm: key.keyAlgorithm,
  }));
}

async function createServiceAccountKey(token, projectId) {
  const resource = serviceAccountResource(projectId);
  const { body } = await apiRequest(
    token,
    `${API_ORIGINS.iam}/v1/${resource}/keys`,
    {
      method: "POST",
      body: JSON.stringify({
        privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
        keyAlgorithm: "KEY_ALG_RSA_2048",
      }),
    },
  );
  if (!body?.name || !body?.privateKeyData) {
    throw new SafeError("Google did not return a usable service-account key.", "KEY_CREATE_FAILED");
  }

  let keyJson;
  try {
    keyJson = Buffer.from(body.privateKeyData, "base64").toString("utf8");
    const parsed = JSON.parse(keyJson);
    if (
      parsed.type !== "service_account" ||
      parsed.project_id !== projectId ||
      parsed.client_email !== serviceAccountEmail(projectId) ||
      typeof parsed.private_key !== "string"
    ) {
      throw new Error("Unexpected key shape");
    }
  } catch {
    throw new SafeError("The generated service-account key failed validation.", "KEY_INVALID");
  }

  return {
    name: body.name,
    keyId: body.name.split("/").at(-1),
    json: keyJson,
  };
}

async function deleteServiceAccountKey(token, keyName) {
  await apiRequest(token, `${API_ORIGINS.iam}/v1/${keyName}`, {
    method: "DELETE",
  });
}

function validateEnrollmentCode(value) {
  const code = value.trim();
  if (code.length < 24 || code.length > 256 || /\s/.test(code)) {
    throw new SafeError(
      "The enrollment code must be 24-256 non-whitespace characters.",
      "ENROLLMENT_CODE_INVALID",
    );
  }
  return code;
}

async function obtainEnrollmentCode(existingFile, environment) {
  if (existingFile) {
    const fileInfo = await stat(existingFile);
    if (!fileInfo.isFile()) {
      throw new SafeError("The enrollment-code path is not a file.", "ENROLLMENT_CODE_INVALID");
    }
    if ((fileInfo.mode & 0o077) !== 0) {
      throw new SafeError(
        "The enrollment-code file must not be accessible by group or other users; run chmod 600 on it.",
        "ENROLLMENT_CODE_PERMISSIONS",
      );
    }
    return {
      code: validateEnrollmentCode(await readFile(existingFile, "utf8")),
      handoffFile: existingFile,
      generated: false,
    };
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), `arnifi-phone-bell-${environment}-`));
  await chmod(temporaryDirectory, 0o700);
  const handoffFile = join(temporaryDirectory, "device-enrollment-code.txt");
  const code = randomBytes(32).toString("base64url");
  await writeFile(handoffFile, `${code}\n`, { mode: 0o600, flag: "wx" });
  await chmod(handoffFile, 0o600);
  return { code, handoffFile, generated: true };
}

async function assertWorkerDirectory(workerDirectory) {
  let info;
  try {
    info = await stat(workerDirectory);
  } catch {
    throw new SafeError(
      `Worker directory does not exist: ${workerDirectory}.`,
      "WORKER_DIRECTORY_MISSING",
    );
  }
  if (!info.isDirectory()) {
    throw new SafeError("--worker-dir must point to a directory.", "WORKER_DIRECTORY_INVALID");
  }
}

async function pipeSecretsToWrangler(workerDirectory, wranglerEnvironment, secrets) {
  await assertWorkerDirectory(workerDirectory);
  const args = ["--no-install", "wrangler", "secret", "bulk"];
  if (wranglerEnvironment) args.push("--env", wranglerEnvironment);

  return new Promise((resolveChild, rejectChild) => {
    const child = spawn("npx", args, {
      cwd: workerDirectory,
      env: {
        ...process.env,
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-4_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.on("error", () => {
      rejectChild(
        new SafeError(
          "Unable to start Wrangler. Install worker dependencies and authenticate with `npx wrangler login`.",
          "WRANGLER_START_FAILED",
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolveChild();
        return;
      }
      const detail = redact(stderr || stdout).trim().slice(-800);
      rejectChild(
        new SafeError(
          detail
            ? `Wrangler rejected the secret upload: ${detail}`
            : `Wrangler exited with code ${code}.`,
          "WRANGLER_SECRET_UPLOAD_FAILED",
        ),
      );
    });

    child.stdin.on("error", () => {
      // The close handler supplies the safe, actionable error.
    });
    child.stdin.end(JSON.stringify(secrets));
  });
}

async function collectProjectStatus(token, project) {
  const { environment, projectId } = project;
  const services = await getServiceStates(token, projectId);
  const account = await getServiceAccount(token, projectId);
  const roles = await Promise.all(
    CUSTOM_ROLES.map(async (definition) => {
      const role = await getCustomRole(token, projectId, definition.roleId);
      return {
        name: customRoleName(projectId, definition.roleId),
        exists: Boolean(role),
        matchesDefinition: roleMatches(role, definition),
      };
    }),
  );
  const policy = await getProjectIamPolicy(token, projectId);
  const member = `serviceAccount:${serviceAccountEmail(projectId)}`;
  const roleBindings = roles.map((role) => ({
    role: role.name,
    granted: hasRoleBinding(policy, role.name, member),
  }));
  const keys = account ? await listUserManagedKeys(token, projectId) : [];

  return {
    environment,
    projectId,
    requiredServices: services,
    serviceAccount: {
      email: serviceAccountEmail(projectId),
      exists: Boolean(account),
      disabled: account?.disabled ?? false,
      userManagedKeys: keys.map(({ name: _name, ...key }) => key),
    },
    customRoles: roles,
    roleBindings,
    readyForSecretInstallation:
      services.every((service) => service.enabled) &&
      Boolean(account) &&
      roles.every((role) => role.matchesDefinition) &&
      roleBindings.every((binding) => binding.granted),
  };
}

async function applyProject(token, project) {
  const { environment, projectId } = project;
  await enableRequiredServices(token, projectId);
  const serviceAccount = await ensureServiceAccount(token, projectId);
  const roleResults = [];
  for (const definition of CUSTOM_ROLES) {
    const result = await ensureCustomRole(token, projectId, definition);
    roleResults.push({
      name: customRoleName(projectId, definition.roleId),
      changed: result.changed,
    });
  }
  const bindings = await ensureRoleBindings(
    token,
    projectId,
    roleResults.map((role) => role.name),
    serviceAccountEmail(projectId),
  );

  return {
    environment,
    projectId,
    requiredServicesEnabled: true,
    serviceAccount: {
      email: serviceAccountEmail(projectId),
      created: serviceAccount.changed,
    },
    customRoles: roleResults,
    roleBindingsChanged: bindings.changed,
    rolesAddedToServiceAccount: bindings.addedRoles,
  };
}

async function installProjectSecrets(token, project, options) {
  const applyResult = await applyProject(token, project);
  const previousKeys = await listUserManagedKeys(token, project.projectId);
  const enrollment = await obtainEnrollmentCode(
    options.enrollmentCodeFile,
    project.environment,
  );
  let generatedKey;
  let uploadSucceeded = false;

  try {
    generatedKey = await createServiceAccountKey(token, project.projectId);
    const wranglerEnvironment = options.useWranglerEnv
      ? options.wranglerEnv ??
        (project.environment === "custom" ? undefined : project.environment)
      : undefined;
    await pipeSecretsToWrangler(options.workerDir, wranglerEnvironment, {
      [GOOGLE_SERVICE_ACCOUNT_SECRET]: generatedKey.json,
      [ENROLLMENT_CODE_SECRET]: enrollment.code,
    });
    uploadSucceeded = true;

    const retiredKeyIds = [];
    if (options.retireOldKeys) {
      for (const oldKey of previousKeys) {
        if (oldKey.name && oldKey.keyId !== generatedKey.keyId) {
          await deleteServiceAccountKey(token, oldKey.name);
          retiredKeyIds.push(oldKey.keyId);
        }
      }
    }

    return {
      ...applyResult,
      worker: {
        directory: options.workerDir,
        environment: wranglerEnvironment ?? "top-level",
        installedSecretNames: [
          GOOGLE_SERVICE_ACCOUNT_SECRET,
          ENROLLMENT_CODE_SECRET,
        ],
      },
      googleKey: {
        keyId: generatedKey.keyId,
        privateKeyWrittenToDisk: false,
        previousUserManagedKeyCount: previousKeys.length,
        retiredKeyIds,
      },
      enrollmentCodeHandoff: {
        path: enrollment.handoffFile,
        generated: enrollment.generated,
        fileMode: "0600",
        containsSecret: true,
        deleteAfterEnrollment: true,
      },
    };
  } finally {
    if (!uploadSucceeded && generatedKey?.name) {
      try {
        await deleteServiceAccountKey(token, generatedKey.name);
      } catch {
        // A later status run reveals any orphan by non-secret key ID.
      }
    }
    if (!uploadSucceeded && enrollment.generated) {
      await rm(dirname(enrollment.handoffFile), { recursive: true, force: true });
    }
    if (generatedKey) generatedKey.json = undefined;
    enrollment.code = undefined;
  }
}

async function deleteExactKey(token, project, options) {
  if (!options.keyId || options.confirmDelete !== options.keyId) {
    throw new SafeError(
      "delete-key requires matching --key-id and --confirm-delete values.",
      "DELETE_CONFIRMATION_REQUIRED",
    );
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(options.keyId)) {
    throw new SafeError("Invalid service-account key ID.", "INVALID_KEY_ID");
  }
  const keys = await listUserManagedKeys(token, project.projectId);
  const target = keys.find((key) => key.keyId === options.keyId);
  if (!target?.name) {
    return {
      environment: project.environment,
      projectId: project.projectId,
      keyId: options.keyId,
      deleted: false,
      reason: "not-found",
    };
  }
  await deleteServiceAccountKey(token, target.name);
  return {
    environment: project.environment,
    projectId: project.projectId,
    keyId: options.keyId,
    deleted: true,
  };
}

async function main() {
  assertNodeVersion();
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "help") {
    process.stdout.write(HELP.trimStart());
    return;
  }

  const aliases = await loadProjectAliases();
  const projects = selectProjects(options.project, aliases);
  if ((command === "install-secrets" || command === "delete-key") && projects.length !== 1) {
    throw new SafeError(
      `${command} operates on exactly one project; select --project dev or --project prod.`,
      "SINGLE_PROJECT_REQUIRED",
    );
  }
  const token = await getGoogleAccessToken();

  let results;
  if (command === "status") {
    results = [];
    for (const project of projects) {
      results.push(await collectProjectStatus(token, project));
    }
  } else if (command === "apply") {
    results = [];
    for (const project of projects) {
      results.push(await applyProject(token, project));
    }
  } else if (command === "install-secrets") {
    results = [await installProjectSecrets(token, projects[0], options)];
  } else {
    results = [await deleteExactKey(token, projects[0], options)];
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        command,
        credentialValuesPrinted: false,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  const safeError =
    error instanceof SafeError
      ? error
      : new SafeError("Unexpected provisioning failure.", "UNEXPECTED_ERROR");
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: {
          code: safeError.code,
          message: redact(safeError.message),
          ...(safeError.status ? { status: safeError.status } : {}),
        },
        credentialValuesPrinted: false,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
});
