import { stripSendBlocks, unlockRateLimitGate } from "./rewrite";

/**
 * Line-level rewrite for the app-server's JSON-RPC output.
 *
 * Only a line that mentions one of the rate-limit fields is parsed. Everything else (model
 * deltas, tool output, thread items) is never touched, so the cost on the hot path is one regular
 * expression per line and the bytes stay identical.
 */
const GATE_FIELDS = /rateLimit|rate_limit|ordinaryUsageAllowed|blockedFeatures|blocked_features|limitsProgress|limits_progress/;

/**
 * Returns the rewritten line, or null when the line is not a gate-bearing JSON document or the
 * rewrite has nothing to change. Parse failures also return null: the rewrite owns removal of
 * known-shaped locks, not validation.
 */
export function rewriteAppServerLine(line: string): string | null {
  if (!GATE_FIELDS.test(line)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const stripped = stripSendBlocks(parsed);
  const unlocked = unlockRateLimitGate(stripped.value);
  return stripped.changed || unlocked ? JSON.stringify(stripped.value) : null;
}
