export const CLOUD_HOST = "codex-cloud-backend.chatgpt.com";
// v2 requires the helper to own privileged 443; v1 helpers must not accept this runtime.
export const CLOUD_NETWORK_PROTOCOL = 2;
export const CLOUD_ENTRY_PORT = 10443;
export const CLOUD_HELPER_LABEL = "com.opencodex.cloud-network";
export const CLOUD_HELPER_ROOT = "/Library/Application Support/OpenCodex/cloud-network";
export const CLOUD_HELPER_SOCKET = "/var/run/com.opencodex.cloud-network.sock";
export const CLOUD_HELPER_PLIST = "/Library/LaunchDaemons/com.opencodex.cloud-network.plist";

export type CloudMappingState = "idle" | "active" | "recovery_required";
export interface CloudHelperReply {
  protocol: number;
  ok: boolean;
  state: CloudMappingState;
  error?: string;
}

export interface CloudNetworkStatus {
  configured: boolean;
  state: "disabled" | "starting" | "active" | "unavailable" | "stopped";
  reason?: string;
  applicationHandshake: "unverified";
}

export class CloudNetworkError extends Error {
  constructor(message: string, readonly recoveryRequired = false) { super(message); }

  static fromReply(reply: CloudHelperReply, fallback: string): CloudNetworkError {
    return new CloudNetworkError(reply.error ?? fallback, reply.state === "recovery_required");
  }
}
