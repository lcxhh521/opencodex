import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildChatgptShimLauncher } from "../../src/chatgpt/desktop-unblock/runtime";
import { rewriteAppServerLine } from "../../src/chatgpt/desktop-unblock/app-server-rewrite";
import { createRpcLineFilter, runAppServerShim } from "../../src/chatgpt/desktop-unblock/app-server-shim";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * The desktop app reads the composer's send gate from the bundled app-server over JSON-RPC, not
 * from Chromium (#6196). The shim sits on that one stdio pipe and opens the plain-quota gate.
 */

const rpcResult = (result: unknown) => JSON.stringify({ id: 2, result });

const EXHAUSTED_RATE_LIMITS = {
  ordinaryUsageAllowed: false,
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790000000 },
    planType: "pro",
    rateLimitReachedType: "rate_limit_reached",
  },
  rateLimitsByLimitId: { codex: { limitId: "codex", rateLimitReachedType: "rate_limit_reached" } },
};

describe("app-server line rewrite", () => {
  test("a plain-quota reached type is cleared and ordinary usage is allowed again", () => {
    const out = JSON.parse(rewriteAppServerLine(rpcResult(EXHAUSTED_RATE_LIMITS))!);
    expect(out.result.ordinaryUsageAllowed).toBe(true);
    expect(out.result.rateLimits.rateLimitReachedType).toBeNull();
    expect(out.result.rateLimitsByLimitId.codex.rateLimitReachedType).toBeNull();
    // Displayed usage is never changed.
    expect(out.result.rateLimits.primary).toEqual(EXHAUSTED_RATE_LIMITS.rateLimits.primary);
    expect(out.result.rateLimits.planType).toBe("pro");
  });

  test("a workspace or credit reached type is left as the server sent it", () => {
    for (const type of ["workspace_owner_usage_limit_reached", "workspace_member_credits_depleted"]) {
      const line = rpcResult({ ...EXHAUSTED_RATE_LIMITS, rateLimits: { ...EXHAUSTED_RATE_LIMITS.rateLimits, rateLimitReachedType: type }, rateLimitsByLimitId: {} });
      expect(rewriteAppServerLine(line)).toBeNull();
    }
  });

  test("a plain quota next to a workspace block keeps ordinary usage closed", () => {
    const line = rpcResult({
      ordinaryUsageAllowed: false,
      rateLimits: { rateLimitReachedType: "rate_limit_reached" },
      rateLimitsByLimitId: { other: { rateLimitReachedType: "workspace_owner_credits_depleted" } },
    });
    const out = JSON.parse(rewriteAppServerLine(line)!);
    expect(out.result.rateLimits.rateLimitReachedType).toBeNull();
    expect(out.result.rateLimitsByLimitId.other.rateLimitReachedType).toBe("workspace_owner_credits_depleted");
    expect(out.result.ordinaryUsageAllowed).toBe(false);
  });

  test("a quota window at 100% opens ordinary usage even when no reached type is sent", () => {
    const line = rpcResult({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080 }, rateLimitReachedType: null } });
    const out = JSON.parse(rewriteAppServerLine(line)!);
    expect(out.result.ordinaryUsageAllowed).toBe(true);
    expect(out.result.rateLimits.primary.usedPercent).toBe(100);
  });

  test("ordinary usage stays closed without quota evidence, or when spend control also blocks", () => {
    // Closed for a reason the payload does not show: not ours to argue with.
    expect(rewriteAppServerLine(rpcResult({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 12 } } }))).toBeNull();
    // Quota is exhausted but a spend control also stands.
    expect(rewriteAppServerLine(rpcResult({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100 }, spendControlReached: { used: 5, limit: 5 } } }))).toBeNull();
  });

  test("notifications carrying the same fields are rewritten too", () => {
    const line = JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { rateLimitReachedType: "rate_limit_reached" } } });
    expect(JSON.parse(rewriteAppServerLine(line)!).params.rateLimits.rateLimitReachedType).toBeNull();
  });

  test("camelCase send blocks and snake_case gate payloads are both handled", () => {
    const blocks = JSON.stringify({ result: { blockedFeatures: [{ name: "send", blockReason: "usage_limit" }, { name: "tpp_send", blockReason: "work_subscription_required" }], limitsProgress: [{ featureName: "send", remaining: 0 }] } });
    const out = JSON.parse(rewriteAppServerLine(blocks)!);
    expect(out.result.blockedFeatures).toEqual([{ name: "tpp_send", blockReason: "work_subscription_required" }]);
    expect(out.result.limitsProgress).toEqual([]);

    const snake = JSON.stringify({ result: { rate_limit: { allowed: false, limit_reached: true } } });
    expect(JSON.parse(rewriteAppServerLine(snake)!).result.rate_limit).toEqual({ allowed: true, limit_reached: false });
  });

  test("lines without gate fields, unparseable lines and already-open gates are not touched", () => {
    expect(rewriteAppServerLine(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hello" } }))).toBeNull();
    expect(rewriteAppServerLine('{"rateLimits": broken')).toBeNull();
    expect(rewriteAppServerLine(rpcResult({ ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null } }))).toBeNull();
  });

  test("a message that only quotes a field name inside text is not modified", () => {
    const line = JSON.stringify({ method: "item/completed", params: { text: "the rateLimitReachedType field is rate_limit_reached" } });
    expect(rewriteAppServerLine(line)).toBeNull();
  });
});

describe("app-server line filter", () => {
  const collect = (chunks: Uint8Array[], filter = createRpcLineFilter()) => {
    const parts: Uint8Array[] = [];
    for (const chunk of chunks) parts.push(...filter.push(chunk));
    parts.push(...filter.flush());
    return new TextDecoder().decode(Buffer.concat(parts));
  };
  const enc = (s: string) => new TextEncoder().encode(s);

  test("untouched lines come back byte for byte, including multibyte text and odd line endings", () => {
    const text = `${JSON.stringify({ method: "x", params: { t: "你好 🌏 é" } })}\n\r\n${JSON.stringify({ a: 1 })}\r\n`;
    expect(collect([enc(text)])).toBe(text);
  });

  test("a gate line is rewritten wherever the chunk boundaries fall", () => {
    const gate = rpcResult(EXHAUSTED_RATE_LIMITS);
    const stream = `${JSON.stringify({ method: "a", params: { t: "你好" } })}\n${gate}\n${JSON.stringify({ method: "b" })}\n`;
    const bytes = enc(stream);
    for (const size of [1, 2, 3, 7, 64, bytes.length]) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
      const out = collect(chunks).split("\n");
      expect(out[0]).toBe(JSON.stringify({ method: "a", params: { t: "你好" } }));
      expect(JSON.parse(out[1]!).result.rateLimits.rateLimitReachedType).toBeNull();
      expect(out[2]).toBe(JSON.stringify({ method: "b" }));
      expect(out[3]).toBe("");
    }
  });

  test("a final line without a newline is flushed, and rewritten when it needs it", () => {
    expect(collect([enc('{"method":"tail"}')])).toBe('{"method":"tail"}');
    const out = collect([enc(rpcResult(EXHAUSTED_RATE_LIMITS))]);
    expect(out.endsWith("\n")).toBe(false);
    expect(JSON.parse(out).result.ordinaryUsageAllowed).toBe(true);
  });
});

describe("app-server shim process", () => {
  function stubCodex(dir: string, body: string): string {
    const path = join(dir, "codex-stub.sh");
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }
  const run = async (stub: string, argv: string[]) => {
    const written: Uint8Array[] = [];
    const code = await runAppServerShim(argv, { ...process.env, OCX_REAL_CODEX: stub }, bytes => void written.push(bytes));
    return { code, out: new TextDecoder().decode(Buffer.concat(written)) };
  };

  test("runs the real binary with the same arguments, rewrites its gate output and returns its exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-"));
    try {
      const gate = rpcResult(EXHAUSTED_RATE_LIMITS).replace(/'/g, "'\\''");
      const stub = stubCodex(dir, `echo "ARGS:$*"\necho '${gate}'\necho '{"method":"done"}'\nexit 7`);
      const { code, out } = await run(stub, ["app-server", "--analytics-default-enabled"]);
      const lines = out.trim().split("\n");
      expect(code).toBe(7);
      expect(lines[0]).toBe("ARGS:app-server --analytics-default-enabled");
      expect(JSON.parse(lines[1]!).result.rateLimits.rateLimitReachedType).toBeNull();
      expect(lines[2]).toBe('{"method":"done"}');
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("the real binary's path is not leaked into its own environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-env-"));
    try {
      const stub = stubCodex(dir, 'echo "REAL=${OCX_REAL_CODEX:-unset}"');
      expect((await run(stub, [])).out.trim()).toBe("REAL=unset");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("a missing real binary fails loudly with 127 instead of hanging the app", async () => {
    const written: Uint8Array[] = [];
    const code = await runAppServerShim([], { ...process.env, OCX_REAL_CODEX: "/nonexistent/codex" }, bytes => void written.push(bytes));
    expect(code).toBe(127);
    expect(written).toHaveLength(0);
  });
});

describe("app-server shim launcher", () => {
  const scriptIn = (dir: string, text: string) => {
    const path = join(dir, "launcher.sh");
    writeFileSync(path, text);
    chmodSync(path, 0o755);
    return path;
  };

  test("fails open: with the shim's runtime gone it executes the real binary directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-launcher-"));
    try {
      const real = join(dir, "real.sh");
      writeFileSync(real, '#!/bin/bash\necho "REAL:$*"\n');
      chmodSync(real, 0o755);
      const launcher = scriptIn(dir, buildChatgptShimLauncher("/nonexistent/bun", "/nonexistent/shim.ts", real));
      const out = spawnSync(launcher, ["app-server", "--flag"], { encoding: "utf8" });
      expect(out.stdout.trim()).toBe("REAL:app-server --flag");
      expect(out.status).toBe(0);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("with the runtime present it goes through the shim and hands the real path over", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-launcher-ok-"));
    try {
      const real = join(dir, "real with space.sh");
      writeFileSync(real, `#!/bin/bash\necho '${rpcResult(EXHAUSTED_RATE_LIMITS)}'\n`);
      chmodSync(real, 0o755);
      const entry = join(import.meta.dir, "../../src/chatgpt/desktop-unblock/app-server-shim.ts");
      const launcher = scriptIn(dir, buildChatgptShimLauncher(process.execPath, entry, real));
      const out = spawnSync(launcher, ["app-server"], { encoding: "utf8" });
      expect(JSON.parse(out.stdout).result.rateLimits.rateLimitReachedType).toBeNull();
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});
