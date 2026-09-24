import type { Server } from "bun";
import type { OcxConfig } from "../../types";
import { getConfigDir } from "../../config/paths";
import {
  claudeInterceptCaCertPath,
  ensureLocalInterceptCaForStartup,
  issueLocalInterceptLeaf,
} from "../../claude/intercept/local-ca";
import { CHATGPT_INTERCEPT_HOST, startChatgptUnblockListener } from "./listener";

/**
 * Lifecycle for the ChatGPT desktop send-unblock listener.
 *
 * Opt-in via `chatgptDesktop.unblockSend`. The listener shares the Claude intercept authority
 * (one trusted certificate covers both features) and binds a stable loopback port derived from
 * the public port so the launcher's `--host-resolver-rules` value survives restarts. A bind
 * failure degrades to a warning exactly like the Claude intercept pair: the proxy's other
 * duties never depend on this listener existing.
 */

export const CHATGPT_UNBLOCK_PORT_OFFSET = 200;

export function chatgptUnblockEnabled(config: Pick<OcxConfig, "chatgptDesktop" | "runtimeRole">): boolean {
  if (config.runtimeRole === "client") return false;
  return config.chatgptDesktop?.unblockSend === true;
}

export function chatgptUnblockPort(config: Pick<OcxConfig, "chatgptDesktop">, publicPort: number): number {
  const configured = config.chatgptDesktop?.port;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= 65535) return configured;
  return publicPort + CHATGPT_UNBLOCK_PORT_OFFSET;
}

/** The resolver rule to hand the ChatGPT desktop app at launch. */
export function chatgptUnblockResolverRule(port: number): string {
  return `MAP ${CHATGPT_INTERCEPT_HOST} 127.0.0.1:${port}`;
}

export interface ChatgptUnblockState {
  port: number;
  caCertPath: string;
}

export interface ChatgptUnblockHandle<T = undefined> extends ChatgptUnblockState {
  listener: Server<T>;
  stop(): Promise<void>;
}

export interface StartChatgptUnblockOptions {
  config: OcxConfig;
  /** Bound public port; the derived listener port is offset from it. */
  publicPort: number;
  configDir?: string;
}

/**
 * Bind the listener. Resolves `null` when the feature is disabled. A bind failure is reported
 * by rejecting; callers treat it as a degraded optional integration, never a startup failure.
 */
export async function startChatgptUnblock<T = undefined>(options: StartChatgptUnblockOptions): Promise<ChatgptUnblockHandle<T> | null> {
  if (!chatgptUnblockEnabled(options.config)) return null;
  const configDir = options.configDir ?? getConfigDir();
  const ca = await ensureLocalInterceptCaForStartup(configDir);
  const leaf = issueLocalInterceptLeaf(ca, [CHATGPT_INTERCEPT_HOST]);
  // The port must be the configured one, not ephemeral: the launcher's resolver rule names it.
  const listener = startChatgptUnblockListener<T>({ leaf, port: chatgptUnblockPort(options.config, options.publicPort) });
  return {
    port: listener.port ?? chatgptUnblockPort(options.config, options.publicPort),
    caCertPath: claudeInterceptCaCertPath(configDir),
    listener,
    stop: async () => {
      await listener.stop(true);
    },
  };
}
