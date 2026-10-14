# Anthropic Thinking-Signature Recovery

`src/server/responses/anthropic-thinking-recovery.ts` owns one request-scoped recovery for
Anthropic history rejected as bound to another conversation. The exact backtick-bearing
signature-validation phrase and the conversation-binding phrase must both be present.
The request must contain a signature that the real Anthropic adapter would replay, or a
nonempty redacted-thinking block. The adapter's existing signature predicate is shared.

`src/server/responses/adapter-dispatch.ts` checks a complete, bounded, display-safe HTTP 400
error body; non-replayable responses remain terminal. `src/server/responses/adapter-delivery.ts`
checks initial HTTP-200 adapter errors before terminal/empty-completion guards. Both use the
same opaque-recovery guard and the existing request send budget, pacing and rebuild owner.
Only harmless heartbeats may precede a streamed recovery: text, thinking, boundaries, tool
activity and replay-unsafe heartbeats fence replay. The rejected iterator closes before refetch.

Recovery uses the existing opaque-state strip/drop flags and leaves plaintext history intact.
A replacement HTTP refusal retains its status, safe error message/type and code; its body is
not parsed as SSE. Cancellation, budget exhaustion and a second rejection cannot trigger another
signature recovery. No Anthropic `runTurn` path or search/continuation recovery is introduced.

Only a delivery-validated completed response with actual text/tool output and an observed
successful terminal can memoize the rejection. Errors, incomplete/empty responses, missing
terminals, cancellation and changed serving identity cannot memoize it. The existing thread and
durable-serving-identity key and five-minute TTL are unchanged.

`tests/responses/responses-anthropic-thinking-signature-recovery.test.ts` exercises the actual
Anthropic adapter with synthetic HTTP/SSE; `tests/responses/responses-anthropic-thinking-recovery.test.ts`
pins heartbeat/side-effect fences, exact classification, iterator cleanup and memo boundaries.
