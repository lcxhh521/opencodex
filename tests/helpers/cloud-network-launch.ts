import { mock } from "bun:test";
import childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempHome } from "./temp-home";

const scenario = process.argv[2];
const home = createTempHome("ocn-launch-");
mkdirSync(home.codexHome);
const calls: string[] = [];
const cloud = scenario !== "existing-shim";
const shim = scenario === "existing-shim" || scenario === "cloud-and-shim";
writeFileSync(home.path("config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai",
  chatgptDesktop: { cloudNetwork: cloud, appServerShim: shim, unblockSend: false } }));
mock.module("../../src/cli/runtime-api", () => ({ runtimeRequest: async () => {
  calls.push("cloud-status"); return { network: { state: scenario === "inactive" ? "unavailable" : "active" } };
} }));
mock.module("../../src/cli/chatgpt-network-command", () => ({ handleChatgptNetworkCommand: async () => {
  calls.push("cloud-recover"); return scenario === "recovery-fails" ? 1 : 0;
} }));
mock.module("../../src/chatgpt/app-server-shim/prepare", () => ({
  discoverChatgptApp: () => ({ root: "/fixture/ChatGPT.app", id: "com.openai.codex" }),
  prepareChatgptShimLauncher: () => { calls.push("prepare-shim"); return { ok: true }; },
}));
mock.module("../../src/chatgpt/app-server-shim/launcher", () => ({
  chatgptShimLauncherPath: () => join(home.root, "launcher"),
  resolveChatgptCodexBinary: () => "/fixture/ChatGPT.app/Contents/Resources/codex",
}));
mock.module("../../src/chatgpt/app-server-shim/bundle-trust", () => ({
  untrustedChatgptBundleReason: () => { calls.push("verify-bundle"); return scenario === "untrusted" ? "untrusted fixture" : null; },
}));
mock.module("node:child_process", () => ({ ...childProcess, spawnSync: (command: string, args: string[]) => {
  if (command === "pgrep") return { status: 1, stdout: "", stderr: "" };
  if (command === "/usr/bin/open") { calls.push(args.includes("--env") ? "open-with-shim" : "open-native"); return { status: 0 }; }
  throw new Error(`Unexpected fixture command: ${command}`);
} }));
try {
  const { handleChatgptCommand } = await import("../../src/cli/chatgpt-command");
  const code = await handleChatgptCommand([scenario === "recovery-fails" ? "restore" : "launch"], "darwin");
  console.log(JSON.stringify({ code, calls }));
} finally { home.remove(); }
