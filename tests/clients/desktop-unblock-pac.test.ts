import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { buildChatgptUnblockPac, loadSystemPac, parseScutilOutput, systemProxyChain } from "../../src/chatgpt/desktop-unblock/pac";
import { repoPath } from "../helpers/repo-root";

/** Evaluate a generated PAC the way Chromium does: run the script, then call the global. */
function evaluatePac(pac: string, host: string): string {
  const sandbox: Record<string, unknown> = {
    shExpMatch: (text: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(text),
    dnsDomainIs: (h: string, domain: string) => h.endsWith(domain),
  };
  runInNewContext(pac, sandbox);
  return (sandbox.FindProxyForURL as (url: string, host: string) => string)(`https://${host}/`, host);
}

/** A scutil stand-in built from the same `Key : value` lines the real command prints. */
function scutilOf(lines: Record<string, string>): ReturnType<typeof systemProxyChain> extends never ? never : Parameters<typeof systemProxyChain>[0] {
  const map = new Map(Object.entries(lines));
  return { get: key => map.get(key) ?? null };
}

describe("chatgpt unblock scutil parsing", () => {
  test.skipIf(process.platform === "win32")("command failure, empty output and malformed output cannot become a direct route", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-scutil-failure-"));
    try {
      const source = `import { systemProxyChain } from ${JSON.stringify(repoPath("src", "chatgpt", "desktop-unblock", "pac.ts"))}; systemProxyChain();`;
      for (const body of ['printf "<dictionary> {\\n}\\n"; exit 1', "exit 0", 'printf "unparseable output\\n"']) {
        writeFileSync(join(dir, "scutil"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        const result = spawnSync(process.execPath, ["-e", source], { env: { ...process.env, PATH: dir }, encoding: "utf8" });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Cannot read the system proxy configuration");
      }
      writeFileSync(join(dir, "scutil"), '#!/bin/sh\nprintf "<dictionary> {\\n}\\n"\n', { mode: 0o755 });
      expect(spawnSync(process.execPath, ["-e", source], { env: { ...process.env, PATH: dir } }).status).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the parser reads the colon-separated lines scutil actually prints", () => {
    const raw = "<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7892\n}";
    const chain = systemProxyChain(parseScutilOutput(raw));
    expect(chain.entries).toEqual(["PROXY 127.0.0.1:7892"]);
  });

  test("an equals-style line also parses, and non-key lines are ignored", () => {
    const raw = "<dictionary> {\n  HTTPEnable = 1\n  HTTPProxy = 10.0.0.9\n  HTTPPort = 7890\n  ExceptionsList : <array> {\n}";
    const chain = systemProxyChain(parseScutilOutput(raw));
    expect(chain.entries).toEqual(["PROXY 10.0.0.9:7890"]);
  });
});

describe("chatgpt unblock PAC generation", () => {
  test("an HTTP(S) system proxy has no synthetic DIRECT fallback", () => {
    const chain = systemProxyChain(scutilOf({
      HTTPSEnable: "1", HTTPSProxy: "127.0.0.1", HTTPSPort: "7892",
      HTTPEnable: "1", HTTPProxy: "127.0.0.1", HTTPPort: "7890",
      SOCKSEnable: "0", SOCKSProxy: "", SOCKSPort: "0",
    }));
    expect(chain.entries).toEqual(["PROXY 127.0.0.1:7892", "PROXY 127.0.0.1:7890"]);
    const pac = buildChatgptUnblockPac(10301, chain);
    expect(pac).toContain(`if (host == "chatgpt.com") return "PROXY 127.0.0.1:10301; PROXY 127.0.0.1:7892; PROXY 127.0.0.1:7890"`);
    expect(pac).toContain(`return "PROXY 127.0.0.1:7892; PROXY 127.0.0.1:7890"`);
    expect(pac).not.toContain("DIRECT");
  });

  test("SOCKS-only VPNs map to a SOCKS5 entry", () => {
    const chain = systemProxyChain(scutilOf({
      HTTPSEnable: "0", HTTPEnable: "0", SOCKSEnable: "1", SOCKSProxy: "10.0.0.1", SOCKSPort: "1080",
    }));
    expect(chain.entries).toEqual(["SOCKS5 10.0.0.1:1080"]);
    expect(evaluatePac(buildChatgptUnblockPac(10301, chain), "auth.openai.com")).toBe("SOCKS5 10.0.0.1:1080");
  });

  test("TUN mode (no system proxy) degrades to DIRECT only", () => {
    const chain = systemProxyChain(scutilOf({
      HTTPSEnable: "0", HTTPEnable: "0", SOCKSEnable: "0",
    }));
    expect(chain.entries).toEqual([]);
    const pac = buildChatgptUnblockPac(10301, chain);
    expect(pac).toContain(`"PROXY 127.0.0.1:10301; DIRECT"`);
    expect(pac).toContain(`return "DIRECT"`);
  });

  test("an unreadable scutil answer fails closed instead of claiming no proxy", () => {
    expect(() => systemProxyChain(null)).toThrow("Cannot read the system proxy configuration");
  });

  test("a system-level PAC file is detected and its URL captured", () => {
    const chain = systemProxyChain(scutilOf({ ProxyAutoConfigEnable: "1", ProxyAutoConfigURLString: "http://127.0.0.1:1089/proxy.pac" }));
    expect(chain.autoConfig).toBe(true);
    expect(chain.autoConfigUrl).toBe("http://127.0.0.1:1089/proxy.pac");
    expect(chain.entries).toEqual([]);
    expect(systemProxyChain(scutilOf({ ProxyAutoConfigEnable: "0", ProxyAutoConfigURLString: "http://x/p.pac" })).autoConfigUrl).toBeNull();
  });

  test("the same proxy set for HTTPS and HTTP appears once", () => {
    const chain = systemProxyChain(scutilOf({
      HTTPSEnable: "1", HTTPSProxy: "127.0.0.1", HTTPSPort: "7892",
      HTTPEnable: "1", HTTPProxy: "127.0.0.1", HTTPPort: "7892",
      SOCKSEnable: "1", SOCKSProxy: "127.0.0.1", SOCKSPort: "7892",
    }));
    expect(chain.entries).toEqual(["PROXY 127.0.0.1:7892", "SOCKS5 127.0.0.1:7892"]);
  });

  test("the generated chain PAC routes as it reads when evaluated", () => {
    const pac = buildChatgptUnblockPac(10301, { entries: ["PROXY 127.0.0.1:7892"], autoConfig: false, autoConfigUrl: null });
    expect(evaluatePac(pac, "chatgpt.com")).toBe("PROXY 127.0.0.1:10301; PROXY 127.0.0.1:7892");
    expect(evaluatePac(pac, "auth.openai.com")).toBe("PROXY 127.0.0.1:7892");
  });

  test("an enabled proxy with a missing address fails closed", () => {
    expect(() => systemProxyChain(scutilOf({
      HTTPSEnable: "1", HTTPSProxy: "(null)", HTTPSPort: "0",
      HTTPEnable: "1", HTTPProxy: "", HTTPPort: "0",
      SOCKSEnable: "0",
    }))).toThrow("An enabled system proxy has an invalid address");
  });

  test("malformed enabled proxy routes never produce an empty proxy chain", () => {
    for (const [host, port] of [["127.0.0.1", "0"], ["proxy.test", "65536"], ["proxy.test", "abc"], ["proxy.test; DIRECT", "80"], ["proxy.test/path", "80"], ["user@proxy.test", "80"]]) {
      expect(() => systemProxyChain(scutilOf({ HTTPEnable: "1", HTTPProxy: host!, HTTPPort: port! }))).toThrow("An enabled system proxy has an invalid address");
    }
    expect(() => systemProxyChain(scutilOf({ HTTPEnable: "unknown" }))).toThrow("malformed");
    expect(() => systemProxyChain(scutilOf({ ProxyAutoDiscoveryEnable: "1" }))).toThrow("Automatic proxy discovery");
  });

  test("raw and percent-encoded delimiters cannot escape the canonical proxy hostname", () => {
    for (const host of ['foo"bar', "foo%22bar", "a;b", "a%3bb", "a%3Bb", "foo..bar", "-proxy.test"]) {
      expect(() => systemProxyChain(scutilOf({ HTTPEnable: "1", HTTPProxy: host, HTTPPort: "80" }))).toThrow("An enabled system proxy has an invalid address");
    }
    expect(systemProxyChain(scutilOf({ HTTPEnable: "1", HTTPProxy: "Proxy.Example.test.", HTTPPort: "80" })).entries).toEqual(["PROXY proxy.example.test.:80"]);
  });

  test("generated chain values are JavaScript string literals even for unexpected quotes", () => {
    const value = 'PROXY unexpected"quote:80';
    const pac = buildChatgptUnblockPac(10301, { entries: [value], autoConfig: false, autoConfigUrl: null });
    expect(pac).toContain(JSON.stringify(value));
    expect(evaluatePac(pac, "auth.openai.com")).toBe(value);
  });

  test("IPv6 proxies remain valid bracketed PAC destinations", () => {
    const chain = systemProxyChain(scutilOf({ SOCKSEnable: "1", SOCKSProxy: "::1", SOCKSPort: "1080" }));
    expect(chain.entries).toEqual(["SOCKS5 [::1]:1080"]);
    expect(evaluatePac(buildChatgptUnblockPac(10301, chain), "auth.openai.com")).toBe("SOCKS5 [::1]:1080");
  });

  test("a configured PAC may not silently use the static chain when its source is missing", () => {
    expect(() => buildChatgptUnblockPac(10301, { entries: ["PROXY 127.0.0.1:7892"], autoConfig: true, autoConfigUrl: null })).toThrow("The configured system PAC could not be read");
  });
});

describe("chatgpt unblock PAC with an embedded system PAC", () => {
  const chain = { entries: [], autoConfig: true, autoConfigUrl: "http://127.0.0.1:1089/proxy.pac" };
  const systemStyles: Record<string, string> = {
    declaration: `function FindProxyForURL(url, host) {
  if (shExpMatch(host, "*.cn")) return "DIRECT";
  return "SOCKS5 127.0.0.1:1086; DIRECT";
}`,
    "var assignment": `var FindProxyForURL = function (url, host) {
  if (shExpMatch(host, "*.cn")) return "DIRECT";
  return "SOCKS5 127.0.0.1:1086; DIRECT";
};`,
    "bare global assignment and a trailing line comment": `FindProxyForURL = function (url, host) {
  if (shExpMatch(host, "*.cn")) return "DIRECT";
  return "SOCKS5 127.0.0.1:1086; DIRECT";
}
// end of gfwlist`,
  };

  for (const [style, systemPac] of Object.entries(systemStyles)) {
    test(`chatgpt.com goes to the entry then the system PAC's answer (${style})`, () => {
      const pac = buildChatgptUnblockPac(10301, chain, systemPac);
      expect(evaluatePac(pac, "chatgpt.com")).toBe("PROXY 127.0.0.1:10301; SOCKS5 127.0.0.1:1086; DIRECT");
      expect(evaluatePac(pac, "auth.openai.com")).toBe("SOCKS5 127.0.0.1:1086; DIRECT");
      expect(evaluatePac(pac, "www.example.cn")).toBe("DIRECT");
    });
  }

  test("an embedded PAC that answers nothing degrades to DIRECT", () => {
    const pac = buildChatgptUnblockPac(10301, chain, "function FindProxyForURL(url, host) { return undefined; }");
    expect(evaluatePac(pac, "chatgpt.com")).toBe("PROXY 127.0.0.1:10301; DIRECT");
  });
});

describe("chatgpt unblock system PAC loading", () => {
  const PAC = 'function FindProxyForURL(url, host) { return "PROXY 10.0.0.1:3128; DIRECT"; }';
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ocx-system-pac-"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/proxy.pac") return new Response(PAC, { headers: { "content-type": "application/x-ns-proxy-autoconfig" } });
        if (path === "/html") return new Response("<html>captive portal</html>");
        return new Response("missing", { status: 404 });
      },
    });
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a file:// PAC is read from disk", async () => {
    const path = join(dir, "vpn.pac");
    writeFileSync(path, PAC);
    expect(await loadSystemPac(pathToFileURL(path).href)).toBe(PAC);
  });

  test("an http:// PAC on loopback is fetched directly, even with a dead HTTP_PROXY in the environment", async () => {
    const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy };
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.http_proxy = "http://127.0.0.1:1";
    try {
      expect(await loadSystemPac(`http://127.0.0.1:${server.port}/proxy.pac`)).toBe(PAC);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("unreadable, non-PAC, oversized or unsupported sources give null", async () => {
    expect(await loadSystemPac(`http://127.0.0.1:${server.port}/missing`)).toBeNull();
    expect(await loadSystemPac(`http://127.0.0.1:${server.port}/html`)).toBeNull();
    expect(await loadSystemPac("http://127.0.0.1:1/proxy.pac")).toBeNull();
    expect(await loadSystemPac(pathToFileURL(join(dir, "absent.pac")).href)).toBeNull();
    const big = join(dir, "big.pac");
    writeFileSync(big, `${PAC}\n//${"x".repeat(5 * 1024 * 1024)}`);
    expect(await loadSystemPac(pathToFileURL(big).href)).toBeNull();
    mkdirSync(join(dir, "folder.pac"));
    expect(await loadSystemPac(pathToFileURL(join(dir, "folder.pac")).href)).toBeNull();
    expect(await loadSystemPac("ftp://127.0.0.1/proxy.pac")).toBeNull();
    expect(await loadSystemPac("not a url")).toBeNull();
  });
});
