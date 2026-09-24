import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../config/paths";
import { CHATGPT_INTERCEPT_HOST } from "./listener";
import { chatgptUnblockResolverRule } from "./runtime";

/**
 * Launch integration for the ChatGPT desktop send-unblock intercept.
 *
 * The Chromium resolver rule only applies when the app is launched with it, so a normal
 * Dock/Spotlight start reaches the real chatgpt.com and the composer locks again. This module
 * installs a launchd agent that watches the app's Electron `SingletonLock` -- written on every
 * launch -- and, exactly once per launch, restarts the app with the resolver rule if it was
 * started without one. There is no resident polling process: launchd wakes the script on the
 * lock event and the script exits after one check.
 *
 * The watcher only acts when the opencodex intercept listener is actually listening, so with
 * the feature off the app is left completely native.
 */

export const CHATGPT_APP_PATH = "/Applications/ChatGPT.app";
/** The desktop app is `openai-codex-electron` internally: its Electron userData dir is `Codex`. */
export const CHATGPT_SINGLETON_LOCK_PATH = "Library/Application Support/Codex/SingletonLock";
export const CHATGPT_UNBLOCK_WATCHER_LABEL = "com.opencodex.chatgpt-unblock-watcher";

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

export interface ChatgptUnblockWatcherPaths {
  scriptPath: string;
  plistPath: string;
  errPath: string;
  lockPath: string;
}

export function chatgptUnblockWatcherPaths(configDir?: string): ChatgptUnblockWatcherPaths {
  const dir = configDir ?? getConfigDir();
  return {
    scriptPath: join(dir, "chatgpt-unblock-watcher.sh"),
    plistPath: expandHome(`~/Library/LaunchAgents/${CHATGPT_UNBLOCK_WATCHER_LABEL}.plist`),
    errPath: join(dir, "chatgpt-unblock-watcher.err"),
    lockPath: expandHome(`~/${CHATGPT_SINGLETON_LOCK_PATH}`),
  };
}

/** The one-shot launchd script: restart the app with the rule if this launch lacked it. */
export function buildChatgptUnblockWatcherScript(port: number): string {
  const rule = chatgptUnblockResolverRule(port);
  return `#!/bin/bash
# opencodex ChatGPT send-unblock launch watcher (one-shot, launchd-triggered).
# Fires when the ChatGPT desktop app creates its Electron SingletonLock (i.e. on every
# launch). If the app was started WITHOUT the host-resolver rule that points ${CHATGPT_INTERCEPT_HOST} at
# the opencodex TLS listener (normal Dock/Spotlight launch), it is restarted once with the
# rule. Correctly-launched instances and an absent intercept are left alone.

PORT=${port}
RULE='${rule}'
LOG="$HOME/.opencodex/chatgpt-unblock-watcher.log"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# Intercept must be listening; otherwise leave the app alone.
if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  exit 0
fi
# App running?
if ! pgrep -f "ChatGPT.app/Contents/MacOS/ChatGPT" >/dev/null 2>&1; then
  exit 0
fi
# Already launched with the rule?
if pgrep -f "MacOS/ChatGPT $RULE" >/dev/null 2>&1; then
  exit 0
fi
log "unflagged ChatGPT detected; restarting with resolver rule"
osascript -e 'quit app "ChatGPT"' >/dev/null 2>&1
sleep 3
open -a ChatGPT --args "$RULE"
log "relaunched with rule"
`;
}

/** One-shot launchd agent: wake on the app's SingletonLock event, run the script, exit. */
export function buildChatgptUnblockWatcherPlist(scriptPath: string, watchPath: string, errPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CHATGPT_UNBLOCK_WATCHER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${scriptPath}</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>${watchPath}</string>
  </array>
  <key>StandardErrorPath</key>
  <string>${errPath}</string>
</dict>
</plist>
`;
}

function sh(command: string, args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() };
  }
}

export interface InstallChatgptUnblockWatcherOptions {
  port: number;
  configDir?: string;
  /** Test seam: skip the macOS / app-presence guards. */
  assumeSupported?: boolean;
}

/** Install the launch watcher: write script + agent plist and load it with launchd. */
export function installChatgptUnblockWatcher(options: InstallChatgptUnblockWatcherOptions): void {
  if (process.platform !== "darwin" && !options.assumeSupported) {
    throw new Error("the ChatGPT launch watcher is only supported on macOS");
  }
  if (!options.assumeSupported && !existsSync(CHATGPT_APP_PATH)) {
    throw new Error(`${CHATGPT_APP_PATH} not found; install the ChatGPT desktop app first`);
  }
  const paths = chatgptUnblockWatcherPaths(options.configDir);
  mkdirSync(expandHome("~/Library/LaunchAgents"), { recursive: true });
  writeFileSync(paths.scriptPath, buildChatgptUnblockWatcherScript(options.port), { mode: 0o700 });
  writeFileSync(paths.plistPath, buildChatgptUnblockWatcherPlist(paths.scriptPath, paths.lockPath, paths.errPath));
  // Idempotent load: boot out any previous generation first.
  sh("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${CHATGPT_UNBLOCK_WATCHER_LABEL}`]);
  sh("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, paths.plistPath]);
}

/** Remove the launch watcher: unload the agent and delete its files. */
export function uninstallChatgptUnblockWatcher(configDir?: string): void {
  const paths = chatgptUnblockWatcherPaths(configDir);
  sh("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${CHATGPT_UNBLOCK_WATCHER_LABEL}`]);
  for (const path of [paths.plistPath, paths.scriptPath]) {
    try {
      rmSync(path);
    } catch {
      /* already gone */
    }
  }
}

export interface ChatgptUnblockWatcherStatus {
  scriptInstalled: boolean;
  plistInstalled: boolean;
  agentLoaded: boolean;
  scriptUpToDate: boolean;
  plistUpToDate: boolean;
}

export function chatgptUnblockWatcherStatus(port: number, configDir?: string): ChatgptUnblockWatcherStatus {
  const paths = chatgptUnblockWatcherPaths(configDir);
  const scriptInstalled = existsSync(paths.scriptPath);
  const plistInstalled = existsSync(paths.plistPath);
  const agentLoaded = sh("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${CHATGPT_UNBLOCK_WATCHER_LABEL}`]).ok;
  const scriptUpToDate = scriptInstalled
    && readFileSync(paths.scriptPath, "utf8") === buildChatgptUnblockWatcherScript(port);
  const plistUpToDate = plistInstalled
    && readFileSync(paths.plistPath, "utf8") === buildChatgptUnblockWatcherPlist(paths.scriptPath, paths.lockPath, paths.errPath);
  return { scriptInstalled, plistInstalled, agentLoaded, scriptUpToDate, plistUpToDate };
}

/** Launch the ChatGPT desktop app with the resolver rule (macOS). */
export function launchChatgptWithRule(port: number): void {
  if (process.platform !== "darwin") {
    throw new Error("launching the ChatGPT desktop app is only supported on macOS");
  }
  execFileSync("open", ["-a", "ChatGPT", "--args", chatgptUnblockResolverRule(port)], { stdio: "ignore" });
}
