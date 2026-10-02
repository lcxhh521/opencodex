import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config";
import { findLiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import {
  chatgptAppCommandLine,
  chatgptAppHasShim,
  chatgptCommandLineHasRule,
  chatgptUnblockWatcherStatus,
  installChatgptUnblockWatcher,
  launchChatgptWithRule,
  probeChatgptUnblockListener,
  restoreChatgptNative,
  uninstallChatgptUnblockWatcher,
} from "../chatgpt/desktop-unblock/launch-watcher";
import { chatgptAppServerShimEnabled, chatgptUnblockEnabled, chatgptPacFallbackEnabled, chatgptUnblockEntryPort, chatgptUnblockPacArg, chatgptUnblockPort, chatgptUnblockResolverArg } from "../chatgpt/desktop-unblock/runtime";
import { chatgptCommandLineHasPac } from "../chatgpt/desktop-unblock/launch-watcher";
import { chatgptCaTrustCommand, inspectChatgptCaTrust } from "../chatgpt/desktop-unblock/ca-trust";
import { claudeInterceptCaCertPath } from "../claude/intercept/local-ca";
import { getConfigDir } from "../config/paths";
import { interactiveConfirm } from "./interactive-confirm";
import { chatgptShimLauncherPath } from "../chatgpt/app-server-shim/launcher";
import { discoverChatgptApp, prepareChatgptShimLauncher } from "../chatgpt/app-server-shim/prepare";
import type { DesktopAppInstall } from "../codex/desktop-app/types";

/**
 * `ocx chatgpt` — the ChatGPT desktop integrations (macOS): the send-unblock intercept and the
 * maintainer's experimental app-server shim (#6361). With `chatgptDesktop.unblockSend` off,
 * `launch|restore|status` are the shim on its own; with it on, they also carry the intercept's
 * launch switches and the shim rides along when `appServerShim` is set.
 *
 *   ocx chatgpt status                   Feature, listener, trust, watcher, shim and app state
 *   ocx chatgpt install-watcher [--yes]  Install the launch watcher (Dock/Spotlight launches too)
 *   ocx chatgpt uninstall-watcher        Remove the launch watcher
 *   ocx chatgpt launch                   Relaunch the app with the configured switches and/or shim
 *   ocx chatgpt restore                  Relaunch with native networking, without the shim
 */

const USAGE = `Usage (macOS):
  ocx chatgpt status                   Feature, listener, certificate trust, watcher, shim and app state
  ocx chatgpt install-watcher [--yes]  Install the launch watcher (covers Dock/Spotlight launches; needs unblockSend)
  ocx chatgpt uninstall-watcher        Remove the launch watcher
  ocx chatgpt launch                   Relaunch ChatGPT with the intercept switches and/or the experimental app-server shim
  ocx chatgpt restore                  Relaunch ChatGPT with native networking and without the shim; removes the shim launcher`;

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/**
 * Only inspect the verified bundle's own process; never print the environment being inspected.
 * `-a` keeps ancestors in the match: when ocx runs inside a ChatGPT/Codex session the app is
 * one of this process's ancestors, and plain `pgrep -x` would report it as not running.
 */
function appState(install: DesktopAppInstall, launcher: string): { running: boolean; shim: boolean } {
  const shell = join(install.root, "Contents", "MacOS", "ChatGPT");
  // Only this user's processes: another account's ChatGPT can neither be quit nor relaunched here.
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const pids = run("pgrep", [...(uid === undefined ? [] : ["-U", String(uid)]), "-a", "-x", "ChatGPT"]);
  if (!pids.ok) return { running: false, shim: false };
  for (const pid of pids.output.split(/\s+/).filter(value => /^\d+$/.test(value))) {
    const command = run("ps", ["eww", "-o", "command=", "-p", pid]);
    if (command.ok && (command.output === shell || command.output.startsWith(`${shell} `))) {
      const marker = `CODEX_CLI_PATH=${launcher}`;
      const start = command.output.indexOf(marker);
      return { running: true, shim: start >= 0 && (start === 0 || command.output[start - 1] === " ")
        && (start + marker.length === command.output.length || command.output[start + marker.length] === " ") };
    }
  }
  return { running: false, shim: false };
}

/** Adapted from #5947: open ignores new launch settings until the previous app exits. */
async function quitApp(install: DesktopAppInstall, launcher: string): Promise<boolean> {
  if (!appState(install, launcher).running) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    run("/usr/bin/osascript", ["-e", `quit app id "${install.id}"`]);
    for (let poll = 0; poll < 20; poll++) {
      if (!appState(install, launcher).running) return true;
      await Bun.sleep(250);
    }
  }
  return !appState(install, launcher).running;
}

/**
 * The maintainer's experimental shim on its own (#6361), used while the send-unblock intercept is
 * off: it installs no listener, CA, PAC or watcher, and explicit launches are its only activation.
 */
async function handleShimOnly(sub: "launch" | "restore" | "status", config: OcxConfig): Promise<number> {
  try {
    const launcher = chatgptShimLauncherPath();
    const install = discoverChatgptApp();
    if (sub === "status") {
      const app = install ? appState(install, launcher) : { running: false, shim: false };
      console.log(`app-server shim (experimental): ${config.chatgptDesktop?.appServerShim === true ? "on" : "off"}
launcher: ${existsSync(launcher) ? "present" : "absent"}
app: ${install ? (app.running ? "running" : "not running") : "not installed"}
CODEX_CLI_PATH launcher: ${app.shim ? "yes" : "no"}
send-unblock intercept: off (chatgptDesktop.unblockSend)`);
      return 0;
    }
    if (!install) {
      if (sub === "restore") rmSync(launcher, { force: true });
      console.error("ChatGPT (com.openai.codex) was not found; install or open it once, then retry.");
      return 1;
    }
    if (sub === "launch") {
      if (config.chatgptDesktop?.appServerShim !== true) {
        console.error("Experimental shim disabled; set chatgptDesktop.appServerShim: true before launching.");
        return 1;
      }
      const prepared = prepareChatgptShimLauncher();
      if (!prepared.ok) {
        console.error(`Refusing to launch the shim: ${prepared.reason}.`);
        return 1;
      }
    }
    if (!(await quitApp(install, launcher))) {
      console.error("ChatGPT did not quit; quit it manually and retry.");
      return 1;
    }
    // Remove an inherited override too: restore must launch without CODEX_CLI_PATH.
    const env = { ...process.env };
    delete env.CODEX_CLI_PATH;
    // Open the verified bundle by path, so the relaunch is the same app that was quit.
    const result = spawnSync("/usr/bin/open", ["-a", install.root, ...(sub === "launch" ? ["--env", `CODEX_CLI_PATH=${launcher}`] : [])], {
      encoding: "utf8", env, timeout: 10000,
    });
    if (result.status !== 0) throw new Error(result.error?.message ?? (result.stderr?.trim() || "open failed"));
    if (sub === "restore") rmSync(launcher, { force: true });
    console.log(`ChatGPT relaunched ${sub === "launch" ? "with" : "without"} the experimental app-server shim.`);
    return 0;
  } catch (error) {
    console.error(`ChatGPT shim (experimental): ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Port the intercept listens on: explicit config, else live proxy + offset, else default + offset. */
export function resolveChatgptUnblockPort(config: OcxConfig, livePort: number | undefined): number {
  return chatgptUnblockPort(config, livePort ?? (typeof config.port === "number" ? config.port : 10100));
}

const WATCHER_CONSENT = `The launch watcher runs each time the ChatGPT app starts, and again when opencodex
starts. If the app was opened normally (Dock, Spotlight), it quits the app right after launch
and reopens it with the opencodex route. It only restarts an app that started in the last
five minutes, and does nothing while opencodex is not running. Remove it any time with
'ocx chatgpt uninstall-watcher'.`;

export async function handleChatgptCommand(args: string[], platform: NodeJS.Platform = process.platform): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 64;
  }
  if (!["status", "install-watcher", "uninstall-watcher", "launch", "restore"].includes(sub)) {
    console.error(`unknown subcommand: ${sub}`);
    return 64;
  }
  if (platform !== "darwin") {
    // lsof/pgrep/launchd do not exist elsewhere; answering "not running" would be a false report.
    console.error("The ChatGPT desktop send-unblock integration is only supported on macOS.");
    return 1;
  }

  // uninstall-watcher must work even when the port cannot be resolved: the operator may need
  // to remove the watcher precisely because the configuration no longer resolves.
  if (sub === "uninstall-watcher") {
    try {
      uninstallChatgptUnblockWatcher();
    } catch (error) {
      console.error(`Launch watcher not removed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    console.log("Launch watcher removed.");
    return 0;
  }

  const config = loadConfig();
  // Without the intercept, launch/restore/status are the experimental shim on its own.
  if (!chatgptUnblockEnabled(config) && (sub === "launch" || sub === "restore" || sub === "status")) {
    return await handleShimOnly(sub, config);
  }
  const live = await findLiveProxy().catch(() => null);
  let port: number;
  try {
    port = resolveChatgptUnblockPort(config, live?.port);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (sub === "status") return await printStatus(config, port, live?.port);

  if (sub === "install-watcher") {
    if (config.chatgptDesktop?.unblockSend !== true) {
      console.error("chatgptDesktop.unblockSend is not enabled; add it to ~/.opencodex/config.json first:");
      console.error('  { "chatgptDesktop": { "unblockSend": true } }');
      return 1;
    }
    console.log(WATCHER_CONSENT);
    if (!args.includes("--yes")) {
      if (!process.stdin.isTTY) {
        console.error("Re-run with --yes to confirm installing the launch watcher.");
        return 1;
      }
      if (!(await interactiveConfirm({ question: "Install the launch watcher?", defaultYes: false }))) {
        console.log("Launch watcher not installed.");
        return 1;
      }
    }
    try {
      const pacMode = chatgptPacFallbackEnabled(config);
      installChatgptUnblockWatcher({
        port,
        ...(pacMode ? { entryPort: chatgptUnblockEntryPort(config, live?.port ?? (typeof config.port === "number" ? config.port : 10100)) } : {}),
        shimMode: chatgptAppServerShimEnabled(config),
      });
    } catch (error) {
      console.error(`Launch watcher not installed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    console.log(`🛰 Launch watcher installed for port ${port}.`);
    return 0;
  }

  const pacMode = chatgptPacFallbackEnabled(config);
  const entryPort = pacMode ? chatgptUnblockEntryPort(config, live?.port ?? (typeof config.port === "number" ? config.port : 10100)) : undefined;

  const shimMode = chatgptAppServerShimEnabled(config);
  // The launcher normally comes from the running server; prepare it here too, through the same
  // identity and OpenAI-signature checks, so a launch never points the app at an unchecked binary
  // or a script that does not exist yet.
  if (sub === "launch" && shimMode) {
    try {
      const prepared = prepareChatgptShimLauncher(getConfigDir());
      if (!prepared.ok) {
        console.error(`Refusing to launch the shim: ${prepared.reason}.`);
        return 1;
      }
    } catch (error) {
      console.error(`ChatGPT not launched: could not write the app-server launcher: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (sub === "launch") return report(launchChatgptWithRule(port, undefined, pacMode, entryPort, shimMode));

  // restore: the watcher would put the switches straight back on the relaunch while opencodex runs.
  const watcher = chatgptUnblockWatcherStatus(port, undefined, pacMode, entryPort, shimMode);
  if (watcher.agentLoaded && (await probeChatgptUnblockListener(port)).state === "ours") {
    console.error("The launch watcher would re-apply the opencodex route on relaunch while opencodex is running.");
    console.error("Run 'ocx chatgpt uninstall-watcher' first, or stop opencodex, then 'ocx chatgpt restore'.");
    return 1;
  }
  const restored = restoreChatgptNative(port, undefined, pacMode, entryPort, shimMode);
  // As the shim's own restore does: the launcher goes once the app is back on its own binary.
  if (restored.ok) rmSync(chatgptShimLauncherPath(getConfigDir()), { force: true });
  return report(restored);
}

function report(result: { ok: boolean; output: string }): number {
  if (result.output) (result.ok ? console.log : console.error)(result.output);
  return result.ok ? 0 : 1;
}

async function printStatus(config: OcxConfig, port: number, livePort: number | undefined): Promise<number> {
  const enabled = config.chatgptDesktop?.unblockSend === true;
  const pacMode = chatgptPacFallbackEnabled(config);
  const configDir = getConfigDir();
  const entryPort = pacMode ? chatgptUnblockEntryPort(config, livePort ?? (typeof config.port === "number" ? config.port : 10100)) : undefined;
  const listener = await probeChatgptUnblockListener(port);
  const watcher = chatgptUnblockWatcherStatus(port, configDir, pacMode, entryPort, chatgptAppServerShimEnabled(config));
  const appCommandLine = chatgptAppCommandLine();
  const appRunning = appCommandLine !== null;
  const appFlagged = appRunning
    && (pacMode ? chatgptCommandLineHasPac(appCommandLine, configDir) : chatgptCommandLineHasRule(appCommandLine, port));
  const caPath = claudeInterceptCaCertPath(configDir);
  const trust = await inspectChatgptCaTrust(caPath);
  const listenerLine = {
    ours: "listening",
    foreign: "held by ANOTHER process (not opencodex); set chatgptDesktop.port to a free port",
    down: "not listening",
  }[listener.state];
  const trustLine = {
    trusted: "trusted",
    untrusted: "NOT trusted (account, usage and settings pages will fail to load)",
    missing: "not created yet (start opencodex with the feature enabled)",
    unknown: "could not be checked",
    unsupported: "not applicable on this platform",
  }[trust];
  const launchSwitch = pacMode ? chatgptUnblockPacArg(configDir) : chatgptUnblockResolverArg(port);
  const shimOn = chatgptAppServerShimEnabled(config);
  const shimLine = !shimOn
    ? "off (chatgptDesktop.appServerShim)"
    : !appRunning ? "on"
    : chatgptAppHasShim(configDir) ? "on (app started through it)" : "on, but the app was started WITHOUT it (run ocx chatgpt launch)";
  console.log(`ChatGPT send-unblock:
  feature enabled:     ${enabled ? "yes" : "no (set chatgptDesktop.unblockSend: true)"}${pacMode ? "\n  PAC fallback:        on (auto-fallback to the VPN chain / direct when opencodex is down)" : ""}
  listener port:       ${port} (${listenerLine})${pacMode && entryPort ? `\n  entry port:          ${entryPort}` : ""}
  launch switch:       ${launchSwitch}
  app-server shim:     ${shimLine}${shimOn ? `\n  shim launcher:       ${existsSync(chatgptShimLauncherPath(configDir)) ? "present" : "absent (start opencodex or run ocx chatgpt launch)"}` : ""}
  CA trust:            ${trustLine}
  watcher script:      ${watcher.scriptInstalled ? (watcher.scriptUpToDate ? "installed" : "installed (outdated; reinstall)") : "not installed"}
  watcher agent:       ${watcher.agentLoaded ? "loaded" : watcher.plistInstalled ? "installed but not loaded" : "not installed"}
  app:                 ${appRunning ? (appFlagged ? "running with switches" : "running WITHOUT switches (composer will lock)") : "not running"}`);
  if (trust === "untrusted") console.log(`  restore trust with:  ${chatgptCaTrustCommand(caPath)}`);
  if (listener.state === "ours" && listener.preservedSendBlocks.length > 0) {
    // Non-quota send blocks are deliberately left in place; name them so a locked composer has a cause.
    console.log("  send blocks kept:    (not usage quota, so not lifted)");
    for (const block of listener.preservedSendBlocks) console.log(`    - ${block.name}: ${block.reason} (last seen ${block.lastSeen})`);
  }
  if (appFlagged && listener.state !== "ours") {
    console.log(pacMode ? `
  ⚠ The app is routed through opencodex's PAC, but the listener is not answering. ChatGPT
    falls back to the system chain automatically; until the PAC is refreshed it may bypass
    opencodex on the next launches. Run 'ocx chatgpt restore' for clean native networking.` : `
  ⚠ The app is routed to port ${port}, but opencodex's listener is not answering there.
    Every chatgpt.com request from the app fails until opencodex runs again, or run
    'ocx chatgpt restore' to relaunch the app with native networking.`);
  }
  return 0;
}
