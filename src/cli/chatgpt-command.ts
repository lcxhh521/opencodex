import { execFileSync } from "node:child_process";
import { loadConfig } from "../config";
import { findLiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";
import { chatgptUnblockWatcherStatus, installChatgptUnblockWatcher, launchChatgptWithRule, uninstallChatgptUnblockWatcher } from "../chatgpt/desktop-unblock/launch-watcher";
import { CHATGPT_UNBLOCK_PORT_OFFSET, chatgptUnblockResolverRule } from "../chatgpt/desktop-unblock/runtime";

/**
 * `ocx chatgpt` — inspect and operate the ChatGPT desktop send-unblock integration.
 *
 *   ocx chatgpt status                 Feature, listener, watcher and app state
 *   ocx chatgpt install-watcher        Install the launch watcher (Dock/Spotlight launches too)
 *   ocx chatgpt uninstall-watcher      Remove the launch watcher
 *   ocx chatgpt launch                 Launch the app with the resolver rule
 */

function sh(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/** Port the intercept listens on: explicit config, else live proxy + offset, else default + offset. */
export function resolveChatgptUnblockPort(config: OcxConfig, livePort: number | undefined): number {
  const configured = config.chatgptDesktop?.port;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= 65535) return configured;
  const publicPort = livePort ?? (typeof config.port === "number" ? config.port : 10100);
  return publicPort + CHATGPT_UNBLOCK_PORT_OFFSET;
}

export async function handleChatgptCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(`Usage:
  ocx chatgpt status                 Feature, listener, watcher and app state
  ocx chatgpt install-watcher        Install the launch watcher (covers Dock/Spotlight launches)
  ocx chatgpt uninstall-watcher      Remove the launch watcher
  ocx chatgpt launch                 Launch the ChatGPT app with the resolver rule`);
    return sub ? 0 : 64;
  }

  const config = loadConfig();
  const live = await findLiveProxy().catch(() => null);
  const port = resolveChatgptUnblockPort(config, live?.port);
  const rule = chatgptUnblockResolverRule(port);

  if (sub === "status") {
    const enabled = config.chatgptDesktop?.unblockSend === true;
    const listening = sh("lsof", ["-nP", "-iTCP", `:${port}`, "-sTCP:LISTEN"]);
    const watcher = chatgptUnblockWatcherStatus(port);
    const appRunning = sh("pgrep", ["-f", "ChatGPT.app/Contents/MacOS/ChatGPT"]);
    const appFlagged = sh("pgrep", ["-f", `MacOS/ChatGPT ${rule}`]);
    console.log(`ChatGPT send-unblock:
  feature enabled:     ${enabled ? "yes" : "no (set chatgptDesktop.unblockSend: true)"}
  listener port:       ${port}${listening ? " (listening)" : " (not listening)"}
  resolver rule:       ${rule}
  watcher script:      ${watcher.scriptInstalled ? (watcher.scriptUpToDate ? "installed" : "installed (outdated; reinstall)") : "not installed"}
  watcher agent:       ${watcher.agentLoaded ? "loaded" : watcher.plistInstalled ? "installed but not loaded" : "not installed"}
  app:                 ${appRunning ? (appFlagged ? "running with rule" : "running WITHOUT rule (composer will lock)") : "not running"}`);
    return 0;
  }

  if (sub === "install-watcher") {
    if (config.chatgptDesktop?.unblockSend !== true) {
      console.error("chatgptDesktop.unblockSend is not enabled; add it to ~/.opencodex/config.json first:");
      console.error('  { "chatgptDesktop": { "unblockSend": true } }');
      return 1;
    }
    installChatgptUnblockWatcher({ port });
    console.log(`🛰 Launch watcher installed for port ${port}.`);
    console.log("   Normal Dock/Spotlight launches of the ChatGPT app are now corrected automatically.");
    return 0;
  }

  if (sub === "uninstall-watcher") {
    uninstallChatgptUnblockWatcher();
    console.log("Launch watcher removed.");
    return 0;
  }

  if (sub === "launch") {
    launchChatgptWithRule(port);
    console.log(`Launched the ChatGPT app with ${rule}`);
    return 0;
  }

  console.error(`unknown subcommand: ${sub}`);
  return 64;
}
