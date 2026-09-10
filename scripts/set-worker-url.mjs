#!/usr/bin/env node
// Points the web app and the Android app at a deployed Cloudflare Worker.
//
//   node scripts/set-worker-url.mjs dev  https://arnifi-phone-bell-dev.<subdomain>.workers.dev
//   node scripts/set-worker-url.mjs prod https://arnifi-phone-bell-prod.<subdomain>.workers.dev
//
// Both target files hold real client configuration and are gitignored.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = {
  dev: { env: "web/.env.dev.local", androidKey: "ARNIFI_DEV_API_BASE_URL" },
  prod: { env: "web/.env.production.local", androidKey: "ARNIFI_PROD_API_BASE_URL" },
};

const [environment, rawUrl] = process.argv.slice(2);
const target = TARGETS[environment];

if (!target || !rawUrl) {
  console.error("usage: node scripts/set-worker-url.mjs <dev|prod> <worker-origin>");
  process.exit(2);
}

let origin;
try {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") throw new Error("the worker must be reached over https");
  origin = parsed.origin;
} catch (error) {
  console.error(`invalid worker URL: ${error.message}`);
  process.exit(2);
}

setEnvValue(path.join(REPO, target.env), "VITE_API_BASE_URL", `${origin}/api/v1`);
setPropertyValue(path.join(REPO, "android/firebase.properties"), target.androidKey, `${origin}/api/v1/`);

function setEnvValue(file, key, value) {
  update(file, key, value, (k, v) => `${k}=${v}`);
}

function setPropertyValue(file, key, value) {
  update(file, key, value, (k, v) => `${k}=${v}`);
}

function update(file, key, value, format) {
  if (!fs.existsSync(file)) {
    console.error(`missing ${path.relative(REPO, file)} - copy it from the matching .example first`);
    process.exit(1);
  }
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let replaced = false;
  const next = lines.map((line) => {
    if (!line.startsWith(`${key}=`)) return line;
    replaced = true;
    return format(key, value);
  });
  if (!replaced) next.push(format(key, value));
  fs.writeFileSync(file, next.join("\n"));
  console.log(`${path.relative(REPO, file)}: ${key}=${value}`);
}
