import type { Server } from "bun";
import type { OcxConfig } from "../../types";
import { getConfigDir } from "../../config/paths";
import { CLAUDE_INTERCEPT_HOSTS, startConnectProxy, type ConnectProxyHandle } from "./connect-proxy";
import { startClaudeInterceptListener } from "./listener";
import { claudeInterceptCaCertPath, ensureLocalInterceptCaForStartup, issueLocalInterceptLeaf } from "./local-ca";
import type { PickerRouteInput } from "./picker-models";
import { createPickerRuntime, type CreatePickerRuntimeOptions, type PickerRuntime } from "./picker-runtime";

/**
 * Lifecycle for the Claude intercept pair (CONNECT proxy + TLS listener).
 *
 * Started next to the public listener, torn down with it. The proxy port is derived from the
 * public port unless configured, because Claude Code's `settings.json` must name a port that
 * survives restarts; the TLS listener is ephemeral and only ever reached through the proxy.
 *
 * Picker mode adds a second CONNECT proxy on the next port, used only as Claude Desktop's egress
 * proxy. Desktop's app traffic and the Code tab's Claude Code never share a proxy: Claude Code
 * trusts only the intercept CA (NODE_EXTRA_CA_CERTS) and must never meet the picker terminator,
 * and Desktop trusts only the login keychain and must never meet the api.anthropic.com intercept.
 * On the egress proxy every host is a blind tunnel except claude.ai, which the picker runtime may
 * terminate (src/claude/intercept/picker-runtime.ts).
 */

export const CLAUDE_INTERCEPT_PORT_OFFSET = 100;

export function claudeInterceptEnabled(config: Pick<OcxConfig, "claudeCode" | "runtimeRole">): boolean {
  if (config.runtimeRole === "client") return false;
  if (config.claudeCode?.enabled === false) return false;
  return config.claudeCode?.intercept?.enabled !== false;
}

export function claudeInterceptProxyPort(config: Pick<OcxConfig, "claudeCode">, publicPort: number): number {
  const configured = config.claudeCode?.intercept?.port;
  if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= 65535) return configured;
  return publicPort + CLAUDE_INTERCEPT_PORT_OFFSET;
}

/** Desktop's egress proxy for picker mode: the port after the intercept proxy (before it at 65535). */
export function claudePickerProxyPort(config: Pick<OcxConfig, "claudeCode">, publicPort: number): number {
  const interceptPort = claudeInterceptProxyPort(config, publicPort);
  return interceptPort < 65535 ? interceptPort + 1 : interceptPort - 1;
}

export interface ClaudeInterceptState {
  proxyPort: number;
  caCertPath: string;
  /** Desktop egress proxy for picker mode; null when the picker is not wired or could not bind. */
  pickerProxyPort: number | null;
}

export interface ClaudeInterceptHandle<T = undefined> extends ClaudeInterceptState {
  listener: Server<T>;
  stop(): Promise<void>;
}

let activeState: ClaudeInterceptState | null = null;
let activePicker: PickerRuntime | null = null;

/** Live intercept endpoints, or `null` when the pair is not running in this process. */
export function getClaudeInterceptState(): ClaudeInterceptState | null {
  return activeState;
}

/** The running picker runtime, or `null` when picker mode is not wired in this process. */
export function getClaudePickerRuntime(): PickerRuntime | null {
  return activePicker;
}

export interface StartClaudeInterceptOptions<T> {
  config: OcxConfig;
  /** Bound public port; the derived proxy port is offset from it. */
  publicPort: number;
  /**
   * Port the operator asked for. `0` (ephemeral) gives the derived proxy port no stable value
   * to write into `settings.json`, so intercept stays off unless `intercept.port` is explicit.
   */
  requestedPort?: number;
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  maxRequestBodySize?: number;
  configDir?: string;
  /** Routes for Desktop's Code-tab picker. Picker mode is wired only when this is given. */
  loadPickerRoutes?: () => Promise<PickerRouteInput>;
  /** Test seam: builds the picker runtime. */
  createPicker?: (options: CreatePickerRuntimeOptions) => PickerRuntime;
}

/**
 * Bind both halves. Resolves `null` when intercept is disabled. A bind failure is reported by
 * rejecting; callers treat it as a degraded optional integration, never as a startup failure.
 */
export async function startClaudeIntercept<T>(options: StartClaudeInterceptOptions<T>): Promise<ClaudeInterceptHandle<T> | null> {
  if (!claudeInterceptEnabled(options.config)) return null;
  const explicitPort = typeof options.config.claudeCode?.intercept?.port === "number";
  if (options.requestedPort === 0 && !explicitPort) return null;
  const configDir = options.configDir ?? getConfigDir();
  const ca = await ensureLocalInterceptCaForStartup(configDir);
  const leaf = issueLocalInterceptLeaf(ca, CLAUDE_INTERCEPT_HOSTS);
  const listener = startClaudeInterceptListener<T>({
    leaf,
    dispatch: options.dispatch,
    upstreamBase: options.config.claudeCode?.anthropicBaseUrl,
    ...(options.maxRequestBodySize !== undefined ? { maxRequestBodySize: options.maxRequestBodySize } : {}),
  });
  let proxy: ConnectProxyHandle;
  try {
    proxy = await startConnectProxy(claudeInterceptProxyPort(options.config, options.publicPort), {
      interceptPort: listener.port!,
    });
  } catch (error) {
    await listener.stop(true);
    throw error;
  }
  // Widened on purpose: assignments happen in nested awaits the catch below must still see.
  let picker = null as PickerRuntime | null;
  let pickerProxy = null as ConnectProxyHandle | null;
  try {
    if (options.loadPickerRoutes) {
      picker = (options.createPicker ?? createPickerRuntime)({ config: options.config, configDir, loadRoutes: options.loadPickerRoutes });
      const runtime = picker;
      try {
        pickerProxy = await startConnectProxy(claudePickerProxyPort(options.config, options.publicPort), {
          interceptPort: listener.port!,
          // Nothing is intercepted by host on Desktop's egress proxy; only the picker may terminate.
          interceptHosts: [],
          selectTunnel: (host, port) => runtime.selectTunnel(host, port),
        });
      } catch (error) {
        // Picker mode is optional: a busy port leaves the intercept pair running without it.
        console.warn(`⚠ Claude Desktop picker proxy could not start: ${error instanceof Error ? error.message : String(error)}`);
        await runtime.stop();
        picker = null;
      }
      if (picker) await picker.start();
    }
  } catch (error) {
    // Construction or start failed after the CONNECT proxy bound: release every socket first,
    // so the lifecycle's catch never leaves a bound port without a handle.
    await picker?.stop();
    await pickerProxy?.close();
    await proxy.close();
    await listener.stop(true);
    throw error;
  }
  const state: ClaudeInterceptState = {
    proxyPort: proxy.port,
    caCertPath: claudeInterceptCaCertPath(configDir),
    pickerProxyPort: picker && pickerProxy ? pickerProxy.port : null,
  };
  activeState = state;
  activePicker = picker;
  const ownPicker = picker;
  return {
    ...state,
    listener,
    stop: async () => {
      if (activeState === state) activeState = null;
      if (activePicker === ownPicker) activePicker = null;
      await ownPicker?.stop();
      await pickerProxy?.close();
      await proxy.close();
      await listener.stop(true);
    },
  };
}
