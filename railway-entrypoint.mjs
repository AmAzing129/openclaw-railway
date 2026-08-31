#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chown,
  chmod,
  lchown,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP_DIR = "/app";
const APP_ENTRYPOINT = path.join(APP_DIR, "openclaw.mjs");
const DEFAULT_DATA_DIR = "/data";
const DEFAULT_STATE_DIR = "/data/.openclaw";
const DEFAULT_WORKSPACE_DIR = "/data/workspace";
const DEFAULT_CONFIG_PATH = "/data/.openclaw/openclaw.json";
const DEFAULT_GATEWAY_PORT = 8080;
const OPENCLAW_UID = 1000;
const OPENCLAW_GID = 1000;
const OWNERSHIP_MARKER = ".openclaw-railway-owned-v1";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, key) {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`OpenClaw config key ${key} must be an object.`);
  }
  return value;
}

function requireAbsolutePath(value, name) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

function requireInsideDataDir(value, name, dataDir) {
  const resolved = requireAbsolutePath(value, name);
  if (resolved !== dataDir && !resolved.startsWith(`${dataDir}${path.sep}`)) {
    throw new Error(`${name} must be located under ${dataDir}.`);
  }
  return resolved;
}

export function resolveRuntimePaths(env = process.env) {
  const dataDir = requireAbsolutePath(DEFAULT_DATA_DIR, "data directory");
  const stateDir = requireInsideDataDir(
    env.OPENCLAW_STATE_DIR?.trim() || DEFAULT_STATE_DIR,
    "OPENCLAW_STATE_DIR",
    dataDir,
  );
  const workspaceDir = requireInsideDataDir(
    env.OPENCLAW_WORKSPACE_DIR?.trim() || DEFAULT_WORKSPACE_DIR,
    "OPENCLAW_WORKSPACE_DIR",
    dataDir,
  );
  const configPath = requireInsideDataDir(
    env.OPENCLAW_CONFIG_PATH?.trim() || DEFAULT_CONFIG_PATH,
    "OPENCLAW_CONFIG_PATH",
    dataDir,
  );

  return { dataDir, stateDir, workspaceDir, configPath };
}

export function resolveGatewayPort(env = process.env) {
  const raw = env.OPENCLAW_GATEWAY_PORT?.trim() || String(DEFAULT_GATEWAY_PORT);
  if (!/^\d+$/.test(raw)) {
    throw new Error("OPENCLAW_GATEWAY_PORT must be an integer between 1 and 65535.");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("OPENCLAW_GATEWAY_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

export function resolveTelegramAllowedUserIds(env = process.env) {
  const raw = env.TELEGRAM_ALLOWED_USER_IDS;
  if (typeof raw !== "string" || raw.trim() === "") {
    return undefined;
  }

  const ids = raw.split(",").map((value) => value.trim());
  if (ids.some((id) => !/^[1-9]\d*$/.test(id))) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of numeric Telegram user IDs.",
    );
  }
  return [...new Set(ids)];
}

function requireGatewayToken(env = process.env) {
  const token = env.OPENCLAW_GATEWAY_TOKEN;
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(
      "OPENCLAW_GATEWAY_TOKEN is required.\nSet it as a Railway secret before starting the service.",
    );
  }
  return token;
}

export function normalizeHttpsOrigin(rawValue, variableName) {
  if (typeof rawValue !== "string" || rawValue === "" || rawValue !== rawValue.trim()) {
    throw new Error(`${variableName} must be an exact HTTPS origin without surrounding spaces.`);
  }
  if (rawValue.endsWith("/")) {
    throw new Error(`${variableName} must not have a trailing slash.`);
  }

  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error(`${variableName} must be a valid HTTPS origin.`);
  }

  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.hostname.includes("*") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${variableName} must contain only an HTTPS scheme and host (for example, https://claw.example.com).`,
    );
  }

  return url.origin;
}

function originFromRailwayDomain(rawValue) {
  if (typeof rawValue !== "string" || rawValue === "" || rawValue !== rawValue.trim()) {
    throw new Error("RAILWAY_PUBLIC_DOMAIN must be a hostname without surrounding spaces.");
  }
  if (rawValue.includes("://") || /[/?#@]/.test(rawValue)) {
    throw new Error("RAILWAY_PUBLIC_DOMAIN must be a hostname, not a URL or path.");
  }
  return normalizeHttpsOrigin(`https://${rawValue}`, "RAILWAY_PUBLIC_DOMAIN");
}

export function resolvePublicOrigins(env = process.env) {
  const origins = [];
  const customOrigin = env.RAILWAY_OPENCLAW_PUBLIC_ORIGIN;
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN;

  if (typeof customOrigin === "string" && customOrigin.trim() !== "") {
    origins.push(normalizeHttpsOrigin(customOrigin, "RAILWAY_OPENCLAW_PUBLIC_ORIGIN"));
  }
  if (typeof railwayDomain === "string" && railwayDomain.trim() !== "") {
    origins.push(originFromRailwayDomain(railwayDomain));
  }

  return [...new Set(origins)];
}

export function collectStartupErrors(env = process.env) {
  const errors = [];

  if (
    typeof env.OPENCLAW_GATEWAY_TOKEN !== "string" ||
    env.OPENCLAW_GATEWAY_TOKEN.trim() === ""
  ) {
    errors.push({
      label: "OPENCLAW_GATEWAY_TOKEN",
      message: "Gateway authentication token is missing.",
      hint: "Generate one with `openssl rand -hex 32` and add it in Railway \u2192 Variables.",
    });
  }

  const hasCustomOrigin =
    typeof env.RAILWAY_OPENCLAW_PUBLIC_ORIGIN === "string" &&
    env.RAILWAY_OPENCLAW_PUBLIC_ORIGIN.trim() !== "";
  const hasRailwayDomain =
    typeof env.RAILWAY_PUBLIC_DOMAIN === "string" &&
    env.RAILWAY_PUBLIC_DOMAIN.trim() !== "";

  if (!hasCustomOrigin && !hasRailwayDomain) {
    errors.push({
      label: "Public domain",
      message: "No public origin is configured.",
      hint:
        "Generate a Railway domain in Settings \u2192 Networking \u2192 Generate Domain (port 8080),\n" +
        "         or set RAILWAY_OPENCLAW_PUBLIC_ORIGIN to a custom HTTPS origin (e.g. https://claw.example.com).",
    });
  } else {
    try {
      resolvePublicOrigins(env);
    } catch (error) {
      errors.push({ label: "Public domain", message: error.message, hint: "" });
    }
  }

  try {
    resolveGatewayPort(env);
  } catch (error) {
    errors.push({ label: "OPENCLAW_GATEWAY_PORT", message: error.message, hint: "" });
  }

  try {
    resolveRuntimePaths(env);
  } catch (error) {
    errors.push({ label: "Runtime paths", message: error.message, hint: "" });
  }

  try {
    resolveTelegramAllowedUserIds(env);
  } catch (error) {
    errors.push({
      label: "TELEGRAM_ALLOWED_USER_IDS",
      message: error.message,
      hint: "Use numeric user IDs separated by commas, for example 123456789,987654321.",
    });
  }

  return errors;
}

export function formatStartupErrors(errors) {
  const lines = [
    "==========================================================",
    "  OpenClaw Railway deployment cannot start.",
    `  ${errors.length} configuration ${errors.length === 1 ? "issue" : "issues"} must be fixed:`,
    "",
  ];
  for (const error of errors) {
    lines.push(`  \u2717 ${error.label}`);
    if (error.message) {
      lines.push(`    ${error.message}`);
    }
    if (error.hint) {
      lines.push(`    \u2192 ${error.hint}`);
    }
    lines.push("");
  }
  lines.push("  Fix the issue(s) above, then redeploy.");
  lines.push("==========================================================");
  return lines.join("\n");
}

export function mergeOpenClawConfig(config, { origins, workspaceDir, telegramAllowedUserIds }) {
  if (!isRecord(config)) {
    throw new Error("OpenClaw config root must be an object.");
  }

  const next = structuredClone(config);
  const gateway = requireRecord(next.gateway, "gateway");
  const controlUi = requireRecord(gateway.controlUi, "gateway.controlUi");
  const agents = requireRecord(next.agents, "agents");
  const agentDefaults = requireRecord(agents.defaults, "agents.defaults");

  const existingOrigins = controlUi.allowedOrigins;
  if (
    existingOrigins !== undefined &&
    (!Array.isArray(existingOrigins) || existingOrigins.some((origin) => typeof origin !== "string"))
  ) {
    throw new Error("OpenClaw config key gateway.controlUi.allowedOrigins must be a string array.");
  }
  const existingTrustedProxies = gateway.trustedProxies;
  if (
    existingTrustedProxies !== undefined &&
    (!Array.isArray(existingTrustedProxies) ||
      existingTrustedProxies.some((proxy) => typeof proxy !== "string"))
  ) {
    throw new Error("OpenClaw config key gateway.trustedProxies must be a string array.");
  }

  const allowedOrigins = [...(existingOrigins ?? [])];
  for (const origin of origins) {
    if (!allowedOrigins.includes(origin)) {
      allowedOrigins.push(origin);
    }
  }
  const replacedRailwayProxies = new Set(["100.64.0.3", "100.64.0.4", "100.64.0.5"]);
  const trustedProxies = (existingTrustedProxies ?? []).filter(
    (proxy) => !replacedRailwayProxies.has(proxy),
  );
  // Railway Hikari peers varied from 100.64.0.3 through 100.64.0.6 in the
  // same service subnet. Trust the smallest covering CIDR, not the full CGNAT range.
  if (!trustedProxies.includes("100.64.0.0/29")) {
    trustedProxies.push("100.64.0.0/29");
  }

  const nextControlUi = {
    ...controlUi,
    enabled: true,
    allowedOrigins,
  };
  delete nextControlUi.basePath;

  next.gateway = {
    ...gateway,
    mode: "local",
    bind: "lan",
    trustedProxies,
    controlUi: nextControlUi,
  };
  next.agents = {
    ...agents,
    defaults: {
      ...agentDefaults,
      workspace: workspaceDir,
    },
  };

  if (telegramAllowedUserIds !== undefined) {
    const channels = requireRecord(next.channels, "channels");
    const telegram = requireRecord(channels.telegram, "channels.telegram");
    next.channels = {
      ...channels,
      telegram: {
        ...telegram,
        enabled: true,
        dmPolicy: "allowlist",
        allowFrom: telegramAllowedUserIds,
      },
    };
  }

  return next;
}

function resolveJson5Parser(appDir = APP_DIR) {
  try {
    const appRequire = createRequire(path.join(appDir, "package.json"));
    const json5 = appRequire("json5");
    const parser = json5?.parse ?? json5?.default?.parse;
    if (typeof parser === "function") {
      return parser;
    }
  } catch {
    // A strict JSON config does not need the optional fallback parser.
  }
  return undefined;
}

export async function readOpenClawConfig(
  configPath,
  { appDir = APP_DIR, parseJson5 = resolveJson5Parser(appDir) } = {},
) {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { config: {}, exists: false };
    }
    throw error;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (jsonError) {
    if (!parseJson5) {
      throw new Error(
        `Could not parse ${configPath} as JSON, and this OpenClaw image does not expose its JSON5 parser: ${jsonError.message}`,
      );
    }
    try {
      config = parseJson5(raw);
    } catch (json5Error) {
      throw new Error(`Could not parse ${configPath}: ${json5Error.message}`);
    }
  }

  if (!isRecord(config)) {
    throw new Error("OpenClaw config root must be an object.");
  }
  return { config, exists: true };
}

async function writeConfigAtomically(configPath, config, uid = OPENCLAW_UID, gid = OPENCLAW_GID) {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let handle;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      await chown(temporaryPath, uid, gid);
    }
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function updateOpenClawConfig({
  configPath,
  workspaceDir,
  origins,
  telegramAllowedUserIds,
  appDir = APP_DIR,
  parseJson5,
}) {
  const readOptions = { appDir };
  if (parseJson5 !== undefined) {
    readOptions.parseJson5 = parseJson5;
  }
  const { config } = await readOpenClawConfig(configPath, readOptions);
  const next = mergeOpenClawConfig(config, {
    origins,
    workspaceDir,
    telegramAllowedUserIds,
  });

  if (JSON.stringify(config) === JSON.stringify(next)) {
    return false;
  }
  await writeConfigAtomically(configPath, next);
  return true;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function chownTree(rootPath, uid, gid) {
  const rootStat = await lstat(rootPath);
  await lchown(rootPath, uid, gid);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return;
  }

  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    const directory = await opendir(current);
    for await (const entry of directory) {
      const entryPath = path.join(current, entry.name);
      await lchown(entryPath, uid, gid);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(entryPath);
      }
    }
  }
}

async function preparePersistentData({ dataDir, stateDir, workspaceDir }) {
  await mkdir(dataDir, { recursive: true, mode: 0o755 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(workspaceDir, { recursive: true, mode: 0o700 });

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (isRoot) {
    const markerPath = path.join(dataDir, OWNERSHIP_MARKER);
    if (!(await pathExists(markerPath))) {
      console.error("[openclaw-railway] Preparing persistent volume ownership...");
      await chownTree(dataDir, OPENCLAW_UID, OPENCLAW_GID);
      await writeFile(markerPath, "1\n", { mode: 0o600 });
      await chown(markerPath, OPENCLAW_UID, OPENCLAW_GID);
    } else {
      await chown(dataDir, OPENCLAW_UID, OPENCLAW_GID);
      await chown(stateDir, OPENCLAW_UID, OPENCLAW_GID);
      await chown(workspaceDir, OPENCLAW_UID, OPENCLAW_GID);
    }
  }

  await access(stateDir, fsConstants.R_OK | fsConstants.W_OK);
  await access(workspaceDir, fsConstants.R_OK | fsConstants.W_OK);
}

function dropPrivileges() {
  if (typeof process.getuid !== "function") {
    return;
  }
  const uid = process.getuid();
  if (uid === OPENCLAW_UID) {
    return;
  }
  if (uid !== 0) {
    throw new Error(`Expected to run as root or UID ${OPENCLAW_UID}, but current UID is ${uid}.`);
  }

  process.setgroups([]);
  process.setgid(OPENCLAW_GID);
  process.setuid(OPENCLAW_UID);
  if (process.getuid() !== OPENCLAW_UID || process.getgid() !== OPENCLAW_GID) {
    throw new Error(`Failed to drop privileges to UID/GID ${OPENCLAW_UID}:${OPENCLAW_GID}.`);
  }
}

function signalExitCode(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  return 128 + (numbers[signal] ?? 0);
}

async function spawnWithSignalForwarding(command, args, options) {
  const child = spawn(command, args, options);
  const signals = ["SIGHUP", "SIGINT", "SIGTERM"];
  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  for (const [signal, handler] of handlers) {
    process.off(signal, handler);
  }
  process.exit(result.signal ? signalExitCode(result.signal) : (result.code ?? 1));
}

async function execOpenClaw(args, env = process.env) {
  dropPrivileges();
  process.chdir(APP_DIR);
  const execArgs = [process.execPath, APP_ENTRYPOINT, ...args];
  if (typeof process.execve === "function") {
    process.execve(process.execPath, execArgs, env);
    return;
  }
  await spawnWithSignalForwarding(process.execPath, execArgs.slice(1), {
    cwd: APP_DIR,
    env,
    stdio: "inherit",
  });
}

function runOpenClaw(args, env = process.env) {
  return spawnSync(process.execPath, [APP_ENTRYPOINT, ...args], {
    cwd: APP_DIR,
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function printOwnerUrl(env = process.env) {
  const errors = collectStartupErrors(env);
  if (errors.length > 0) {
    process.stderr.write(`${formatStartupErrors(errors)}\n`);
    process.exitCode = 1;
    return;
  }

  requireGatewayToken(env);
  const origins = resolvePublicOrigins(env);
  const publicOrigin = origins[0];
  dropPrivileges();

  const result = runOpenClaw(["dashboard", "--json", "--no-open"], env);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown OpenClaw error").trim();
    if (/does not recognize option|unknown option/i.test(detail)) {
      throw new Error(
        "This OpenClaw image cannot issue automatic Owner pairing URLs.\n" +
          "Remove the OPENCLAW_IMAGE_TAG override or select an image whose dashboard JSON includes browserUrl, then redeploy.",
      );
    }
    throw new Error(
      `Could not issue an Owner bootstrap URL:\n${detail}`,
    );
  }
  console.log(rewriteBootstrapUrl(ownerBootstrapUrlFromJson(result.stdout), publicOrigin));
}

function parseJsonOutput(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("OpenClaw dashboard --json did not return a JSON object.");
  }
}

export function ownerBootstrapUrlFromJson(output) {
  const payload = parseJsonOutput(output);
  if (typeof payload.browserUrl !== "string") {
    throw new Error(
      "This OpenClaw image does not support automatic Owner pairing.\n" +
        "Remove the OPENCLAW_IMAGE_TAG override or select an image whose dashboard JSON includes browserUrl, then redeploy.",
    );
  }
  return payload.browserUrl;
}

export function rewriteBootstrapUrl(browserUrl, publicOrigin) {
  let url;
  try {
    url = new URL(browserUrl);
  } catch {
    throw new Error("OpenClaw dashboard --json returned an invalid browserUrl.");
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (!fragment.get("bootstrapToken") || fragment.get("bootstrapProfile") !== "owner") {
    throw new Error("OpenClaw dashboard --json did not return an Owner bootstrap URL.");
  }

  const origin = new URL(publicOrigin);
  url.protocol = origin.protocol;
  url.hostname = origin.hostname;
  url.port = origin.port;
  url.username = "";
  url.password = "";
  return url.toString();
}

async function start(env = process.env) {
  requireGatewayToken(env);
  const paths = resolveRuntimePaths(env);
  const origins = resolvePublicOrigins(env);
  const telegramAllowedUserIds = resolveTelegramAllowedUserIds(env);
  if (origins.length === 0) {
    throw new Error(
      "A public origin is required. Enable a Railway generated domain or set RAILWAY_OPENCLAW_PUBLIC_ORIGIN.",
    );
  }

  await preparePersistentData(paths);
  const changed = await updateOpenClawConfig({
    configPath: paths.configPath,
    workspaceDir: paths.workspaceDir,
    origins,
    telegramAllowedUserIds,
  });
  if (changed) {
    console.error("[openclaw-railway] OpenClaw configuration initialized or updated.");
  }

  const port = resolveGatewayPort(env);
  await execOpenClaw(["gateway", "--bind", "lan", "--port", String(port)], env);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command = "start", ...rest] = argv;
  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}`);
  }
  if (command === "start") {
    await start(env);
    return;
  }
  if (command === "preflight") {
    const errors = collectStartupErrors(env);
    if (errors.length > 0) {
      process.stderr.write(`${formatStartupErrors(errors)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write("[openclaw-railway] Pre-deploy checks passed.\n");
    return;
  }
  if (command === "owner-url") {
    await printOwnerUrl(env);
    return;
  }
  throw new Error("Usage: openclaw-railway <start|preflight|owner-url>");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
const invokedName = process.argv[1] ? path.basename(process.argv[1]) : "";
// The Docker image aliases `openclaw` to this file because Railway Console
// sessions run as root. Forward every official CLI command through
// execOpenClaw so config writes remain owned by the UID 1000 Gateway process.
const invocation =
  invokedName === "openclaw"
    ? execOpenClaw(process.argv.slice(2))
    : import.meta.url === invokedPath
      ? main()
      : undefined;
if (invocation) {
  invocation.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
