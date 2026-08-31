import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectStartupErrors,
  formatStartupErrors,
  mergeOpenClawConfig,
  normalizeHttpsOrigin,
  ownerBootstrapUrlFromJson,
  readOpenClawConfig,
  resolveGatewayPort,
  resolvePublicOrigins,
  resolveTelegramAllowedUserIds,
  rewriteBootstrapUrl,
  updateOpenClawConfig,
} from "../railway-entrypoint.mjs";

test("merges Railway settings without replacing user configuration", () => {
  const input = {
    models: { providers: { example: { baseUrl: "https://models.example" } } },
    gateway: {
      auth: { mode: "token" },
      trustedProxies: ["127.0.0.1"],
      controlUi: {
        basePath: "/openclaw",
        allowedOrigins: ["https://existing.example"],
      },
    },
    agents: { defaults: { model: "example/model" } },
  };

  const result = mergeOpenClawConfig(input, {
    origins: ["https://claw.up.railway.app", "https://existing.example"],
    workspaceDir: "/data/workspace",
  });

  assert.deepEqual(input.gateway.controlUi.allowedOrigins, ["https://existing.example"]);
  assert.deepEqual(input.gateway.trustedProxies, ["127.0.0.1"]);
  assert.equal(result.models.providers.example.baseUrl, "https://models.example");
  assert.equal(result.agents.defaults.model, "example/model");
  assert.equal(result.agents.defaults.workspace, "/data/workspace");
  assert.equal(result.gateway.mode, "local");
  assert.equal(result.gateway.bind, "lan");
  assert.deepEqual(result.gateway.trustedProxies, [
    "127.0.0.1",
    "100.64.0.3",
    "100.64.0.4",
    "100.64.0.5",
  ]);
  assert.equal(result.gateway.controlUi.enabled, true);
  assert.equal(Object.hasOwn(result.gateway.controlUi, "basePath"), false);
  assert.deepEqual(result.gateway.controlUi.allowedOrigins, [
    "https://existing.example",
    "https://claw.up.railway.app",
  ]);
});

test("configures Telegram DM access from an explicit user allowlist", () => {
  const input = {
    channels: {
      telegram: {
        enabled: false,
        dmPolicy: "pairing",
        allowFrom: ["111"],
        streaming: "off",
      },
    },
  };

  const result = mergeOpenClawConfig(input, {
    origins: ["https://claw.up.railway.app"],
    workspaceDir: "/data/workspace",
    telegramAllowedUserIds: ["222", "333"],
  });

  assert.equal(result.channels.telegram.enabled, true);
  assert.equal(result.channels.telegram.dmPolicy, "allowlist");
  assert.deepEqual(result.channels.telegram.allowFrom, ["222", "333"]);
  assert.equal(result.channels.telegram.streaming, "off");
  assert.equal(input.channels.telegram.dmPolicy, "pairing");
});

test("validates and orders custom and generated public origins", () => {
  assert.deepEqual(
    resolvePublicOrigins({
      RAILWAY_OPENCLAW_PUBLIC_ORIGIN: "https://claw.example.com",
      RAILWAY_PUBLIC_DOMAIN: "claw-production.up.railway.app",
    }),
    ["https://claw.example.com", "https://claw-production.up.railway.app"],
  );
  assert.equal(normalizeHttpsOrigin("https://claw.example.com:8443", "TEST"), "https://claw.example.com:8443");
  assert.throws(() => normalizeHttpsOrigin("http://claw.example.com", "TEST"), /HTTPS scheme/);
  assert.throws(() => normalizeHttpsOrigin("https://claw.example.com/", "TEST"), /trailing slash/);
  assert.throws(() => normalizeHttpsOrigin("https://*.example.com", "TEST"), /HTTPS scheme/);
  assert.throws(
    () => resolvePublicOrigins({ RAILWAY_OPENCLAW_PUBLIC_ORIGIN: " https://claw.example.com" }),
    /surrounding spaces/,
  );
  assert.throws(
    () => resolvePublicOrigins({ RAILWAY_PUBLIC_DOMAIN: "https://claw.example.com" }),
    /hostname, not a URL/,
  );
});

test("validates the gateway port", () => {
  assert.equal(resolveGatewayPort({}), 8080);
  assert.equal(resolveGatewayPort({ OPENCLAW_GATEWAY_PORT: "9090" }), 9090);
  assert.throws(() => resolveGatewayPort({ OPENCLAW_GATEWAY_PORT: "0" }), /between 1 and 65535/);
  assert.throws(() => resolveGatewayPort({ OPENCLAW_GATEWAY_PORT: "abc" }), /between 1 and 65535/);
});

test("parses and validates Telegram allowed user IDs", () => {
  assert.equal(resolveTelegramAllowedUserIds({}), undefined);
  assert.equal(resolveTelegramAllowedUserIds({ TELEGRAM_ALLOWED_USER_IDS: "  " }), undefined);
  assert.deepEqual(
    resolveTelegramAllowedUserIds({ TELEGRAM_ALLOWED_USER_IDS: "123456789, 987654321,123456789" }),
    ["123456789", "987654321"],
  );
  assert.throws(
    () => resolveTelegramAllowedUserIds({ TELEGRAM_ALLOWED_USER_IDS: "@alice" }),
    /numeric Telegram user IDs/,
  );
  assert.throws(
    () => resolveTelegramAllowedUserIds({ TELEGRAM_ALLOWED_USER_IDS: "123," }),
    /numeric Telegram user IDs/,
  );
});

test("rewrites a one-time Owner URL without changing its path or fragment", () => {
  const result = rewriteBootstrapUrl(
    "http://127.0.0.1:8080/#bootstrapToken=secret&bootstrapProfile=owner",
    "https://claw.example.com",
  );
  assert.equal(
    result,
    "https://claw.example.com/#bootstrapToken=secret&bootstrapProfile=owner",
  );
  assert.throws(
    () => rewriteBootstrapUrl("http://127.0.0.1:8080/#token=shared", "https://claw.example.com"),
    /Owner bootstrap URL/,
  );
});

test("requires the automatic Owner bootstrap contract from the OpenClaw image", () => {
  assert.equal(
    ownerBootstrapUrlFromJson(
      '{"ok":true,"browserUrl":"http://127.0.0.1:8080/#bootstrapToken=secret&bootstrapProfile=owner"}',
    ),
    "http://127.0.0.1:8080/#bootstrapToken=secret&bootstrapProfile=owner",
  );
  assert.throws(
    () => ownerBootstrapUrlFromJson('{"ok":true,"url":"http://127.0.0.1:8080/#token=shared"}'),
    /does not support automatic Owner pairing/,
  );
});

test("reads JSON5 through the selected OpenClaw image parser", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openclaw-railway-json5-"));
  const configPath = path.join(directory, "openclaw.json");
  try {
    await writeFile(configPath, "{ gateway: { mode: 'local', }, }\n");
    const { config } = await readOpenClawConfig(configPath, {
      parseJson5: (raw) => {
        assert.match(raw, /mode: 'local'/);
        return { gateway: { mode: "local" } };
      },
    });
    assert.equal(config.gateway.mode, "local");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomically updates a config once and does not churn an unchanged file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openclaw-railway-config-"));
  const configPath = path.join(directory, "openclaw.json");
  try {
    await writeFile(configPath, '{"channels":{"telegram":{"enabled":true}}}\n');
    const options = {
      configPath,
      workspaceDir: "/data/workspace",
      origins: ["https://claw.up.railway.app"],
    };
    assert.equal(await updateOpenClawConfig(options), true);
    const firstWrite = await readFile(configPath, "utf8");
    assert.equal(await updateOpenClawConfig(options), false);
    assert.equal(await readFile(configPath, "utf8"), firstWrite);
    const saved = JSON.parse(firstWrite);
    assert.equal(saved.channels.telegram.enabled, true);
    assert.deepEqual(saved.gateway.controlUi.allowedOrigins, ["https://claw.up.railway.app"]);
    assert.deepEqual(saved.gateway.trustedProxies, ["100.64.0.3", "100.64.0.4", "100.64.0.5"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collects all missing configuration issues at once", () => {
  const errors = collectStartupErrors({});
  assert.equal(errors.length, 2);
  assert.equal(errors[0].label, "OPENCLAW_GATEWAY_TOKEN");
  assert.equal(errors[1].label, "Public domain");
});

test("collects only the missing domain when token is present", () => {
  const errors = collectStartupErrors({ OPENCLAW_GATEWAY_TOKEN: "secret" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].label, "Public domain");
});

test("collects only the missing token when domain is present", () => {
  const errors = collectStartupErrors({ RAILWAY_PUBLIC_DOMAIN: "claw.up.railway.app" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].label, "OPENCLAW_GATEWAY_TOKEN");
});

test("returns no errors when all required configuration is present", () => {
  const errors = collectStartupErrors({
    OPENCLAW_GATEWAY_TOKEN: "secret",
    RAILWAY_PUBLIC_DOMAIN: "claw.up.railway.app",
  });
  assert.equal(errors.length, 0);
});

test("collects invalid origin values as configuration errors", () => {
  const errors = collectStartupErrors({
    OPENCLAW_GATEWAY_TOKEN: "secret",
    RAILWAY_OPENCLAW_PUBLIC_ORIGIN: "http://insecure.example.com",
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].label, "Public domain");
  assert.match(errors[0].message, /HTTPS/);
});

test("collects an invalid gateway port as a configuration error", () => {
  const errors = collectStartupErrors({
    OPENCLAW_GATEWAY_TOKEN: "secret",
    RAILWAY_PUBLIC_DOMAIN: "claw.up.railway.app",
    OPENCLAW_GATEWAY_PORT: "abc",
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].label, "OPENCLAW_GATEWAY_PORT");
});

test("collects an invalid Telegram allowlist as a configuration error", () => {
  const errors = collectStartupErrors({
    OPENCLAW_GATEWAY_TOKEN: "secret",
    RAILWAY_PUBLIC_DOMAIN: "claw.up.railway.app",
    TELEGRAM_ALLOWED_USER_IDS: "123,@alice",
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].label, "TELEGRAM_ALLOWED_USER_IDS");
  assert.match(errors[0].hint, /123456789/);
});

test("formatStartupErrors produces a readable multi-issue summary", () => {
  const errors = collectStartupErrors({});
  const formatted = formatStartupErrors(errors);
  assert.match(formatted, /cannot start/);
  assert.match(formatted, /OPENCLAW_GATEWAY_TOKEN/);
  assert.match(formatted, /Public domain/);
  assert.match(formatted, /openssl rand/);
  assert.match(formatted, /Generate Domain/);
});

test("preflight via main() exits non-zero when configuration is missing", async () => {
  const { main } = await import("../railway-entrypoint.mjs");
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(["preflight"], {});
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("preflight via main() succeeds when configuration is valid", async () => {
  const { main } = await import("../railway-entrypoint.mjs");
  await main(["preflight"], {
    OPENCLAW_GATEWAY_TOKEN: "secret",
    RAILWAY_PUBLIC_DOMAIN: "claw.up.railway.app",
  });
});
