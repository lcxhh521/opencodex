/**
 * Send-unblock rewriting for the ChatGPT desktop intercept.
 *
 * The ChatGPT desktop app disables the conversation composer from two backend data shapes:
 *
 *  1. Conversation payloads (`/conversation/init` and friends) attach `blocked_features`
 *     entries named `send` (or `tpp_send`) and `limits_progress` entries for `send` with
 *     `remaining <= 0`.
 *  2. The desktop usage snapshot (`/backend-api/wham/usage[/stream]`) carries
 *     `rate_limit.allowed: false` + `rate_limit.limit_reached: true` while the logged-in
 *     ChatGPT subscription quota is exhausted.
 *
 * Both describe the account's own subscription quota -- data that is meaningless for turns
 * whose model calls are routed to third-party providers by opencodex.
 *
 * The rewriter removes exactly the send-lock entries and flips exactly the usage gate flags.
 * Quota display stays honest: `banner_info` / `rate_limit_upsell`, the `used_percent`,
 * `reset_at` and window fields, `model_limits`, `model_usage` and every other key pass
 * through untouched, so the app keeps showing the account's real usage while the composer
 * unlocks.
 */

/** `blocked_features[].name` values the desktop composer treats as a send lock. */
const SEND_BLOCKED_FEATURE_NAMES = new Set(["send", "tpp_send"]);

/** `limits_progress[].feature_name` value for the composer's send gate. */
const SEND_LIMIT_FEATURE_NAME = "send";

export interface RewriteResult {
  value: unknown;
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSendBlockedFeature(entry: unknown): boolean {
  return isRecord(entry) && SEND_BLOCKED_FEATURE_NAMES.has(String(entry.name ?? ""));
}

function isExhaustedSendLimit(entry: unknown): boolean {
  if (!isRecord(entry) || entry.feature_name !== SEND_LIMIT_FEATURE_NAME) return false;
  const remaining = entry.remaining;
  return typeof remaining === "number" && remaining <= 0;
}

/**
 * Recursively strip send-lock entries from any `blocked_features` / `limits_progress` arrays.
 * Malformed entries are kept: the rewrite owns removal of known-shaped blocks, not validation.
 */
export function stripSendBlocks(value: unknown): RewriteResult {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map(item => {
      const result = stripSendBlocks(item);
      changed ||= result.changed;
      return result.value;
    });
    return { value: items, changed };
  }
  if (!isRecord(value)) return { value, changed: false };
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "blocked_features" && Array.isArray(child)) {
      const kept = child.filter(entry => !isSendBlockedFeature(entry));
      changed ||= kept.length !== child.length;
      out[key] = kept;
      continue;
    }
    if (key === "limits_progress" && Array.isArray(child)) {
      const kept = child.filter(entry => !isExhaustedSendLimit(entry));
      changed ||= kept.length !== child.length;
      out[key] = kept;
      continue;
    }
    const result = stripSendBlocks(child);
    changed ||= result.changed;
    out[key] = result.value;
  }
  return { value: out, changed };
}

/**
 * Flip the desktop usage snapshot's send gate in place: `rate_limit.allowed` false -> true and
 * `rate_limit.limit_reached` true -> false, at any depth (top-level for snapshot endpoints,
 * under `usage` for stream events). Window percentages, reset timestamps, the upsell banner
 * and every other display field are left exactly as the backend sent them.
 *
 * Returns whether anything changed.
 */
export function unlockRateLimitGate(value: unknown): boolean {
  let changed = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    const rateLimit = node.rate_limit;
    if (isRecord(rateLimit)) {
      if (rateLimit.allowed === false) {
        rateLimit.allowed = true;
        changed = true;
      }
      if (rateLimit.limit_reached === true) {
        rateLimit.limit_reached = false;
        changed = true;
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return changed;
}

/**
 * Rewrite a JSON response body. Returns `null` when the body is not valid JSON or contains
 * nothing to rewrite, so callers can pass the original bytes through untouched.
 */
export function stripSendBlocksFromJson(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const stripped = stripSendBlocks(parsed);
  const unlocked = unlockRateLimitGate(stripped.value);
  return stripped.changed || unlocked ? JSON.stringify(stripped.value) : null;
}

/**
 * Rewrite a single SSE line. ChatGPT conversation and usage-stream events carry one JSON
 * document per `data:` line; lines that parse to a payload with send blocks or a closed usage
 * gate are replaced, everything else passes through byte-identical. Returns `null` when the
 * line is unchanged.
 */
export function stripSendBlocksFromSseLine(line: string): string | null {
  const match = /^(data: ?)(.*)$/.exec(line);
  if (!match) return null;
  const rewritten = stripSendBlocksFromJson(match[2]!);
  if (rewritten === null) return null;
  return `${match[1]}${rewritten}`;
}
