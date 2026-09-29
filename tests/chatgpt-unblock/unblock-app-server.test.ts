import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startChatgptUnblockListener } from "../../src/chatgpt/desktop-unblock/listener";
import {
  chatgptAppServerBaseUrl,
  chatgptUnblockAppServerPort,
  chatgptUnblockEntryPort,
  chatgptUnblockPort,
} from "../../src/chatgpt/desktop-unblock/runtime";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

/**
 * The bundled `codex app-server` issues the composer's account-gate reads (wham/usage,
 * conversation init) with its own HTTP client, so neither `--host-resolver-rules` nor a PAC
 * file reaches them (#6196). It does honor the root `chatgpt_base_url`, so the send-unblock
 * additionally injects that key, pointing at a plain-HTTP listener that shares the TLS
 * listener's relay and rewrite. Everything here is additive to the existing launch modes.
 */

function config(overrides: Partial<NonNullable<OcxConfig["chatgptDesktop"]>> = {}, extra: Partial<OcxConfig> = {}): OcxConfig {
  return { chatgptDesktop: { unblockSend: true, ...overrides }, ...extra } as OcxConfig;
}

describe("app-server listener port and URL", () => {
  test("the URL is two ports after the origin and carries the backend-api prefix", () => {
    expect(chatgptUnblockAppServerPort(config(), 10100)).toBe(10302);
    expect(chatgptAppServerBaseUrl(config(), 10100)).toBe("http://127.0.0.1:10302/backend-api");
  });

  test("no URL when the feature is off or this install is a client", () => {
    expect(chatgptAppServerBaseUrl({} as OcxConfig, 10100)).toBeNull();
    expect(chatgptAppServerBaseUrl({ chatgptDesktop: { unblockSend: false } } as OcxConfig, 10100)).toBeNull();
    expect(chatgptAppServerBaseUrl(config({}, { runtimeRole: "client" }), 10100)).toBeNull();
  });

  test("an unusable derived port yields no URL instead of throwing", () => {
    expect(chatgptAppServerBaseUrl(config(), 65500)).toBeNull();
  });

  test("near the top of the range the three ports never collide", () => {
    for (const port of [65533, 65534, 65535]) {
      const c = config({ port });
      const ports = [chatgptUnblockPort(c, 10100), chatgptUnblockEntryPort(c, 10100), chatgptUnblockAppServerPort(c, 10100)];
      expect(new Set(ports).size).toBe(3);
      for (const p of ports) expect(p >= 1 && p <= 65535).toBe(true);
    }
  });
});

describe("plain-HTTP app-server listener", () => {
  const stops: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (stops.length) await stops.pop()!();
  });

  test("serves without TLS, relays to the upstream, and opens the usage gate", async () => {
    const targets: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      targets.push(String(input));
      return new Response(JSON.stringify({ rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const server = startChatgptUnblockListener({ fetchImpl, upstreamBase: "https://chatgpt.example" });
    stops.push(() => server.stop(true));

    const res = await fetch(`http://127.0.0.1:${server.port}/backend-api/wham/usage`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 100 } } });
    expect(targets).toEqual(["https://chatgpt.example/backend-api/wham/usage"]);
  });

  test("account reads unrelated to the gate pass through byte-identical", async () => {
    const body = '{"plugins":[{"id":"a","rate_limit":{"allowed":false,"limit_reached":true}}]}';
    const fetchImpl = (async () => new Response(body, { headers: { "content-type": "application/json" } })) as typeof fetch;
    const server = startChatgptUnblockListener({ fetchImpl, upstreamBase: "https://chatgpt.example" });
    stops.push(() => server.stop(true));

    const res = await fetch(`http://127.0.0.1:${server.port}/backend-api/ps/plugins/installed`);
    expect(await res.text()).toBe(body);
  });
});

const INJECT_CYCLE = [
  'const fs = require("fs");',
  'const path = require("path");',
  'const { injectCodexConfig, removeCodexConfig } = require("./src/codex/inject");',
  "(async () => {",
  '  const cfgPath = path.join(process.env.CODEX_HOME, "config.toml");',
  '  const journalPath = path.join(process.env.CODEX_HOME, "opencodex-journal.json");',
  '  const read = () => fs.readFileSync(cfgPath, "utf8");',
  "  const journalUrl = () => fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, \"utf8\")).injectedChatgptBaseUrl ?? null : null;",
  '  const base = { port: 10100, providers: {}, defaultProvider: "openai", injectionModel: "gpt-5.6-sol", injectionEffort: "high" };',
  "  const on = { chatgptDesktop: { unblockSend: true } };",
  "  await injectCodexConfig(10100, { ...base, ...on }, { catalogPath: null });",
  "  const injected = read(); const injectedJournal = journalUrl();",
  "  await injectCodexConfig(10100, { ...base, ...on }, { catalogPath: null });",
  "  const again = read();",
  "  await injectCodexConfig(10100, base, { catalogPath: null });",
  "  const switchedOff = read(); const switchedOffJournal = journalUrl();",
  "  await injectCodexConfig(10100, { ...base, ...on }, { catalogPath: null });",
  "  removeCodexConfig();",
  "  const restored = read();",
  "  console.log(JSON.stringify({ injected, injectedJournal, again, switchedOff, switchedOffJournal, restored }));",
  "})();",
].join(String.fromCharCode(10));

const INJECT_OVER_USER_KEY = [
  'const fs = require("fs");',
  'const path = require("path");',
  'const { injectCodexConfig, removeCodexConfig } = require("./src/codex/inject");',
  "(async () => {",
  '  const cfgPath = path.join(process.env.CODEX_HOME, "config.toml");',
  '  const journalPath = path.join(process.env.CODEX_HOME, "opencodex-journal.json");',
  '  const base = { port: 10100, providers: {}, defaultProvider: "openai", injectionModel: "gpt-5.6-sol", injectionEffort: "high", chatgptDesktop: { unblockSend: true } };',
  "  await injectCodexConfig(10100, base, { catalogPath: null });",
  '  const injected = fs.readFileSync(cfgPath, "utf8");',
  '  const journalUrl = JSON.parse(fs.readFileSync(journalPath, "utf8")).injectedChatgptBaseUrl ?? null;',
  "  removeCodexConfig();",
  '  const restored = fs.readFileSync(cfgPath, "utf8");',
  "  console.log(JSON.stringify({ injected, journalUrl, restored }));",
  "})();",
].join(String.fromCharCode(10));

const INJECT_PROVIDER_TABLE = [
  'const fs = require("fs");',
  'const path = require("path");',
  'const { injectCodexConfig, removeCodexConfig } = require("./src/codex/inject");',
  "(async () => {",
  '  const cfgPath = path.join(process.env.CODEX_HOME, "config.toml");',
  '  const base = { port: 10100, providers: {}, defaultProvider: "openai", injectionModel: "gpt-5.6-sol", injectionEffort: "high", codexClientCompaction: true, chatgptDesktop: { unblockSend: true } };',
  "  await injectCodexConfig(10100, base, { catalogPath: null });",
  '  const injected = fs.readFileSync(cfgPath, "utf8");',
  "  await injectCodexConfig(10100, { ...base, chatgptDesktop: { unblockSend: false } }, { catalogPath: null });",
  '  const switchedOff = fs.readFileSync(cfgPath, "utf8");',
  "  console.log(JSON.stringify({ injected, switchedOff }));",
  "})();",
].join(String.fromCharCode(10));

function runChild(codexHome: string, script: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot(),
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS,
    killSignal: "SIGKILL",
  });
  return { stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "", status: result.status ?? 1 };
}

const RELAY_URL = 'chatgpt_base_url = "http://127.0.0.1:10302/backend-api"';

describe("chatgpt_base_url injection", () => {
  test("is written while the switch is on, dropped when it goes off, and restored away", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-chatgpt-base-url-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    try {
      const r = runChild(home, INJECT_CYCLE);
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
      const out = JSON.parse(r.stdout) as Record<string, string | null>;

      expect(out.injected).toContain(RELAY_URL);
      expect(out.injectedJournal).toBe("http://127.0.0.1:10302/backend-api");
      // Idempotent: a second pass neither duplicates the line nor accumulates markers.
      expect(out.again!.split(RELAY_URL).length - 1).toBe(1);
      // The routing override the feature is additive to is untouched.
      expect(out.injected).toContain("openai_base_url");
      // Switching the feature off removes exactly our line and clears the journal record.
      expect(out.switchedOff).not.toContain("chatgpt_base_url");
      expect(out.switchedOffJournal).toBeNull();
      expect(out.switchedOff).toContain("openai_base_url");
      // ocx restore leaves nothing of it behind, and the user's own key survives.
      expect(out.restored).not.toContain("chatgpt_base_url");
      expect(out.restored).toContain('model = "gpt-5.5"');
    } finally {
      removeTreeWithRetry(home);
    }
  }, 2 * SPAWN_BUDGET_MS);

  test("a user-owned chatgpt_base_url is kept, never journaled, and survives restore", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-chatgpt-base-url-user-"));
    mkdirSync(home, { recursive: true });
    const userLine = 'chatgpt_base_url = "https://gateway.example/backend-api"';
    writeFileSync(join(home, "config.toml"), `model = "gpt-5.5"\n${userLine}\n`, "utf8");
    try {
      const r = runChild(home, INJECT_OVER_USER_KEY);
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
      const out = JSON.parse(r.stdout) as { injected: string; journalUrl: string | null; restored: string };

      expect(out.injected).toContain(userLine);
      expect(out.injected).not.toContain(RELAY_URL);
      expect(out.journalUrl).toBeNull();
      expect(out.restored).toContain(userLine);
    } finally {
      removeTreeWithRetry(home);
    }
  }, 2 * SPAWN_BUDGET_MS);

  test("is written in provider-table routing mode too, ahead of the first table", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-chatgpt-base-url-table-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    try {
      const r = runChild(home, INJECT_PROVIDER_TABLE);
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
      const out = JSON.parse(r.stdout) as { injected: string; switchedOff: string };

      expect(out.injected).toContain("[model_providers.opencodex]");
      expect(out.injected).toContain(RELAY_URL);
      // A root key: it must sit before the first table header or Codex would read it as part of it.
      expect(out.injected.indexOf(RELAY_URL)).toBeLessThan(out.injected.indexOf("[model_providers.opencodex]"));
      expect(out.switchedOff).not.toContain("chatgpt_base_url");
      expect(out.switchedOff).toContain("[model_providers.opencodex]");
    } finally {
      removeTreeWithRetry(home);
    }
  }, 2 * SPAWN_BUDGET_MS);
});
