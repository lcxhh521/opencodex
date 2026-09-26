import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_UNBLOCK_ENTRY_PORT_OFFSET,
  chatgptPacFallbackEnabled,
  chatgptUnblockEntryPort,
  chatgptUnblockPacArg,
  chatgptUnblockPacPath,
  chatgptUnblockPort,
  startChatgptUnblock,
} from "../../src/chatgpt/desktop-unblock/runtime";
import { CHATGPT_INTERCEPT_HOST } from "../../src/chatgpt/desktop-unblock/listener";
import type { OcxConfig } from "../../src/types";

function config(overrides: Partial<NonNullable<OcxConfig["chatgptDesktop"]>> = {}): OcxConfig {
  return { chatgptDesktop: { unblockSend: true, ...overrides } } as OcxConfig;
}

describe("chatgpt unblock runtime ports and mode", () => {
  test("the entry port is one after the origin port", () => {
    expect(chatgptUnblockPort(config(), 10100)).toBe(10300);
    expect(chatgptUnblockEntryPort(config(), 10100)).toBe(10300 + CHATGPT_UNBLOCK_ENTRY_PORT_OFFSET);
  });

  test("an origin port at 65535 wraps the entry port to 65534 instead of leaving the range", () => {
    expect(chatgptUnblockPort(config({ port: 65535 }), 10100)).toBe(65535);
    expect(chatgptUnblockEntryPort(config({ port: 65535 }), 10100)).toBe(65534);
  });

  test("pacFallback implies unblockSend and is off by default", () => {
    expect(chatgptPacFallbackEnabled(config())).toBe(false);
    expect(chatgptPacFallbackEnabled(config({ pacFallback: true }))).toBe(true);
    expect(chatgptPacFallbackEnabled({ chatgptDesktop: { pacFallback: true } } as OcxConfig)).toBe(false);
    expect(chatgptPacFallbackEnabled({ chatgptDesktop: { unblockSend: true, pacFallback: true }, runtimeRole: "client" } as OcxConfig)).toBe(false);
  });

  test("the PAC argument names a file:// URL inside the config dir", () => {
    expect(chatgptUnblockPacArg("/Users/x/.opencodex")).toBe("--proxy-pac-url=file:///Users/x/.opencodex/chatgpt-unblock.pac");
    expect(chatgptUnblockPacPath("/cfg")).toBe(join("/cfg", "chatgpt-unblock.pac"));
  });
});

describe("chatgpt unblock PAC-mode startup", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-chatgpt-pac-runtime-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("resolver-rule mode starts no entry proxy and writes no PAC", async () => {
    const handle = await startChatgptUnblock({ config: config({ port: 19300 }), publicPort: 0, configDir: dir });
    expect(handle).not.toBeNull();
    expect(handle!.entryProxy).toBeUndefined();
    expect(existsSync(chatgptUnblockPacPath(dir))).toBe(false);
    await handle!.stop();
  });

  test("PAC mode binds the entry listener and writes a PAC pointing chatgpt.com at it", async () => {
    const handle = await startChatgptUnblock({ config: config({ pacFallback: true, port: 19300 }), publicPort: 0, configDir: dir });
    expect(handle).not.toBeNull();
    expect(handle!.entryProxy).toBeDefined();
    expect(handle!.entryProxy!.port).toBe(19301);
    const pac = readFileSync(chatgptUnblockPacPath(dir), "utf8");
    expect(pac).toContain(`if (host == "${CHATGPT_INTERCEPT_HOST}")`);
    expect(pac).toContain(`PROXY 127.0.0.1:${handle!.entryProxy!.port}`);
    expect(pac.trimEnd().endsWith("}")).toBe(true);
    // The entry actually accepts a TCP connection while the handle lives.
    const conn = await new Promise<boolean>(resolve => {
      const socket = Bun.connect({ hostname: "127.0.0.1", port: handle!.entryProxy!.port, socket: { data() {}, close() {}, error() {} } })
        .then(() => true).catch(() => false);
      void socket;
      Bun.connect({
        hostname: "127.0.0.1",
        port: handle!.entryProxy!.port,
        socket: { data() {}, close() { resolve(true); }, error() { resolve(false); } },
      }).then(sock => { setTimeout(() => { sock.end(); }, 20); }).catch(() => resolve(false));
    });
    expect(conn).toBe(true);
    await handle!.stop();
  });

  test("an entry bind failure fails the start instead of serving an unroutable PAC", async () => {
    // Occupy the entry port first: origin 10300, entry 10301.
    const blocker = Bun.listen({ hostname: "127.0.0.1", port: 10301, socket: { data() {}, close() {}, error() {} } });
    try {
      await expect(startChatgptUnblock({ config: config({ pacFallback: true, port: 10300 }), publicPort: 0, configDir: dir })).rejects.toThrow();
    } finally {
      blocker.stop(true);
    }
  });
});
