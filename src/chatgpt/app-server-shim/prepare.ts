import { darwinDefaultExec, darwinDesktopAppAdapter } from "../../codex/desktop-app/darwin";
import type { DesktopAppInstall } from "../../codex/desktop-app/types";
import { untrustedChatgptBundleReason } from "./bundle-trust";
import { resolveChatgptCodexBinary, writeChatgptShimLauncher } from "./launcher";

export type ChatgptShimPreparation =
  | { ok: true; launcher: string; install: DesktopAppInstall; binary: string }
  | { ok: false; reason: string; install: DesktopAppInstall | null };

export interface PrepareChatgptShimDeps {
  discover(): DesktopAppInstall | null;
  resolveBinary(root: string): string | null;
  untrustedReason(root: string, binary: string): string | null;
  write(configDir: string | undefined, binary: string): string;
}

/**
 * The installed app, found and confirmed by bundle identifier (com.openai.codex) the same way the
 * desktop restart adapter does. "ChatGPT" is a display name another app can share.
 */
export function discoverChatgptApp(): DesktopAppInstall | null {
  try {
    return darwinDesktopAppAdapter.discover(darwinDefaultExec);
  } catch {
    return null;
  }
}

const defaultDeps: PrepareChatgptShimDeps = {
  discover: discoverChatgptApp,
  resolveBinary: root => resolveChatgptCodexBinary(root),
  untrustedReason: (root, binary) => untrustedChatgptBundleReason(root, binary),
  write: (configDir, binary) => writeChatgptShimLauncher(configDir, binary),
};

/**
 * The steps `ocx chatgpt launch` takes before it relaunches the app through the shim, shared with
 * the send-unblock runtime so both write the launcher the same way: find the bundle by identity,
 * derive its bundled app-server, refuse a bundle that is not OpenAI-signed or not owned safely, and
 * only then write the launcher (atomically) for that binary. A refusal leaves any existing launcher
 * in place: an app that was started through it may still respawn its app-server from it.
 */
export function prepareChatgptShimLauncher(
  configDir?: string,
  deps: PrepareChatgptShimDeps = defaultDeps,
): ChatgptShimPreparation {
  const install = deps.discover();
  if (!install) return { ok: false, reason: "ChatGPT (com.openai.codex) was not found", install: null };
  const binary = deps.resolveBinary(install.root);
  if (!binary) return { ok: false, reason: `no bundled app-server binary was found in ${install.root}`, install };
  const untrusted = deps.untrustedReason(install.root, binary);
  if (untrusted) return { ok: false, reason: untrusted, install };
  return { ok: true, launcher: deps.write(configDir, binary), install, binary };
}
