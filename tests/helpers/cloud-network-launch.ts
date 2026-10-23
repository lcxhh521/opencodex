import { mock } from "bun:test";
import childProcess from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTempHome } from "./temp-home";
import * as watcher from "../../src/chatgpt/desktop-unblock/launch-watcher";
import * as runtime from "../../src/chatgpt/desktop-unblock/runtime";

const scenario = process.argv[2];
const home = createTempHome("ocn-launch-");
mkdirSync(home.codexHome);
const calls: string[] = [];
const cloud = scenario !== "existing-shim";
const shim = scenario === "existing-shim" || scenario === "cloud-and-shim";
const intercept = scenario?.startsWith("cloud-intercept") === true;
const pacFallback = scenario === "cloud-intercept-pac";
let launchArgs: string[] = [];
let launchEnv: string[] = [];
let interceptPac: string | null = null;
let interceptCloud: boolean | null = null;
const systemPac = home.path("system.pac");
writeFileSync(systemPac, 'function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:7892"; }');
// A live proxy started before cloud was enabled: either its PAC is stale, or none exists.
if (pacFallback) writeFileSync(home.path("chatgpt-unblock.pac"), 'function FindProxyForURL() { return "PROXY stale.invalid:1"; }');
writeFileSync(home.path("config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai",
  chatgptDesktop: { cloudNetwork: cloud, appServerShim: shim, unblockSend: intercept, pacFallback } }));
mock.module("../../src/chatgpt/desktop-unblock/runtime", () => ({ ...runtime,
  chatgptPacFallbackEnabled: () => pacFallback,
}));
mock.module("../../src/cli/runtime-api", () => ({ runtimeRequest: async () => {
  calls.push("cloud-status"); return { network: { state: scenario === "inactive" ? "unavailable" : "active" } };
} }));
mock.module("../../src/cli/chatgpt-network-command", () => ({ handleChatgptNetworkCommand: async () => {
  calls.push("cloud-recover"); return scenario === "recovery-fails" ? 1 : 0;
} }));
mock.module("../../src/codex/desktop-app/darwin", () => ({
  darwinDefaultExec: () => "",
  darwinDesktopAppAdapter: { discover: () => ({ root: "/fixture/ChatGPT.app", id: "com.openai.codex" }) },
}));
mock.module("../../src/server/proxy-liveness", () => ({ findLiveProxy: async () => null }));
mock.module("../../src/chatgpt/desktop-unblock/launch-watcher", () => ({ ...watcher,
  chatgptUnblockWatcherLoaded: () => false,
  probeChatgptUnblockListener: async () => ({ state: "ours", preservedSendBlocks: [] }),
  launchChatgptWithRule: (_port: number, _dir: string | undefined, _shim: boolean, _pac: unknown, cloudNetwork: boolean) => {
    calls.push("open-intercept");
    interceptCloud = cloudNetwork;
    interceptPac = readFileSync(home.path("chatgpt-unblock.pac"), "utf8");
    return { ok: true, output: "" };
  },
}));
mock.module("../../src/chatgpt/app-server-shim/launcher", () => ({
  chatgptShimLauncherPath: () => join(home.root, "launcher"),
  resolveChatgptCodexBinary: () => "/fixture/ChatGPT.app/Contents/Resources/codex",
  writeChatgptShimLauncher: () => { calls.push("prepare-shim"); },
}));
mock.module("../../src/chatgpt/app-server-shim/bundle-trust", () => ({
  untrustedChatgptBundleReason: () => { calls.push("verify-bundle"); return scenario === "untrusted" ? "untrusted fixture" : null; },
}));
mock.module("node:child_process", () => ({ ...childProcess,
execFileSync: (command: string) => {
  if (command === "scutil") {
    if (scenario === "cloud-pac" || intercept) return `ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : ${pathToFileURL(systemPac).href}\n`;
    if (scenario === "cloud-socks") return "SOCKSEnable : 1\nSOCKSProxy : 127.0.0.1\nSOCKSPort : 7892\n";
    if (scenario === "cloud-no-proxy") return "HTTPSEnable : 0\nHTTPEnable : 0\nSOCKSEnable : 0\n";
    return "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7892\n";
  }
  throw new Error(`Unexpected fixture command: ${command}`);
},
spawnSync: (command: string, args: string[]) => {
  if (command === "pgrep") return { status: 1, stdout: "", stderr: "" };
  if (command === "/usr/bin/open") {
    calls.push(args.includes("--env") ? "open-with-shim" : "open-native");
    launchArgs = args.includes("--args") ? args.slice(args.indexOf("--args") + 1) : [];
    launchEnv = args.includes("--env") ? [args[args.indexOf("--env") + 1]!.replace(home.root, "<home>")] : [];
    return { status: 0 };
  }
  throw new Error(`Unexpected fixture command: ${command}`);
} }));
try {
  const { handleChatgptCommand } = await import("../../src/cli/chatgpt-command");
  const code = await handleChatgptCommand([scenario === "recovery-fails" ? "restore" : "launch"], "darwin");
  console.log(JSON.stringify({ code, calls, launchArgs, launchEnv, interceptPac, interceptCloud }));
} finally { home.remove(); }
