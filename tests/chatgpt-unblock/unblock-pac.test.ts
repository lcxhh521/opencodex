import { describe, expect, test } from "bun:test";
import { buildChatgptUnblockPac, parseScutilOutput, systemProxyChain } from "../../src/chatgpt/desktop-unblock/pac";

/** A scutil stand-in built from the same `Key : value` lines the real command prints. */
function scutilOf(lines: Record<string, string>): ReturnType<typeof systemProxyChain> extends never ? never : Parameters<typeof systemProxyChain>[0] {
  const map = new Map(Object.entries(lines));
  return { get: key => map.get(key) ?? null };
}

describe("chatgpt unblock scutil parsing", () => {
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
  test("an HTTP(S) system proxy becomes the PROXY entry, DIRECT last", () => {
    const chain = systemProxyChain(scutilOf({
      HTTPSEnable: "1", HTTPSProxy: "127.0.0.1", HTTPSPort: "7892",
      HTTPEnable: "1", HTTPProxy: "127.0.0.1", HTTPPort: "7890",
      SOCKSEnable: "0", SOCKSProxy: "", SOCKSPort: "0",
    }));
    expect(chain.entries).toEqual(["PROXY 127.0.0.1:7892", "PROXY 127.0.0.1:7890"]);
    const pac = buildChatgptUnblockPac(10301, chain);
    expect(pac).toContain(`if (host == "chatgpt.com") return "PROXY 127.0.0.1:10301; PROXY 127.0.0.1:7892; PROXY 127.0.0.1:7890; DIRECT"`);
    expect(pac).toContain(`return "PROXY 127.0.0.1:7892; PROXY 127.0.0.1:7890; DIRECT"`);
  });

  test("SOCKS-only VPNs map to a SOCKS5 entry", () => {
    const chain = systemProxyChain(scutilOf({
      HTTPSEnable: "0", HTTPEnable: "0", SOCKSEnable: "1", SOCKSProxy: "10.0.0.1", SOCKSPort: "1080",
    }));
    expect(chain.entries).toEqual(["SOCKS5 10.0.0.1:1080"]);
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

  test("a missing scutil answer behaves like no proxy, never like an error", () => {
    expect(systemProxyChain(null).entries).toEqual([]);
  });

  test("a system-level PAC file is detected but contributes no entries", () => {
    const chain = systemProxyChain(scutilOf({ ProxyAutoConfigEnable: "1", ProxyAutoConfigURLString: "http://pac/vpn.pac" }));
    expect(chain.autoConfig).toBe(true);
    expect(chain.entries).toEqual([]);
  });

  test("placeholder hosts macOS prints as (null) are skipped", () => {
    const chain = systemProxyChain(scutilOf({
      HTTPSEnable: "1", HTTPSProxy: "(null)", HTTPSPort: "0",
      HTTPEnable: "1", HTTPProxy: "", HTTPPort: "0",
      SOCKSEnable: "0",
    }));
    expect(chain.entries).toEqual([]);
  });
});
