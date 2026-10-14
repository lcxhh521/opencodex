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
signature recovery. No Anthropic `runTurn` or continuation recovery is introduced.

Only a delivery-validated completed response with actual text/tool output and an observed
successful terminal can memoize the rejection. Errors, incomplete/empty responses, missing
terminals, cancellation and changed serving identity cannot memoize it. The existing thread and
durable-serving-identity key and five-minute TTL are unchanged.

`tests/responses/responses-anthropic-thinking-signature-recovery.test.ts` exercises the actual
Anthropic adapter with synthetic HTTP/SSE; `tests/responses/responses-anthropic-thinking-recovery.test.ts`
pins heartbeat/side-effect fences, exact classification, iterator cleanup and memo boundaries.

## Hosted search iterations

Search history uses the bridge's signature snapshot semantics: consecutive signature updates,
including intervening heartbeats, replace one block's signature. The next semantic event closes
that block, so a genuine empty thinking-block start remains a separate signed block.

`src/server/responses/sidecar-execution.ts` supplies the same request-owned policy to
`src/web-search/loop.ts`. Only the current routed-model iteration is rebuilt; completed searches,
tool results, and history remain intact. Request caches are invalidated and the root strip flags
persist into later iterations. HTTP 400 classification runs after existing 429/key recovery.
`src/web-search/progress-stream.ts` has an opt-in typed adapter-error handoff before its normal
exception conversion, with a per-send semantic/replay-unsafe fence and original-body cleanup.
A streamed replacement gets a fresh header deadline; an HTTP refusal retains its current deadline.

The Anthropic search HTTP receipt admits a repair against the shared dispatch budget and settles
it once. Ordinary direct search sends retain their existing reporting contract; Combo bookings
and credential-hop permits are settled rather than charged twice. Recovery is conservatively
unavailable with enforced spend accounting because this legacy direct search lane cannot prove
receipts for earlier ordinary sends. No explicit caller or Combo allowance is increased, and the
ordinary search iteration limit/admission behavior is unchanged.

Only a validated current model iteration contributes completion/output evidence; search cards
cannot establish memo success. The final bridge completion still commits the memo, subject to
cancellation and unchanged serving scope. Replacement HTTP errors keep status/type/code and
non-replayable diagnostics remain withheld. A failed repair is terminal, including a replacement
429; it does not start another credential/rate-limit ladder. The actual-adapter hosted-search contract lives in
`tests/responses/responses-web-search-thinking-signature-recovery.test.ts`.

## Lossless in-memory search continuations

`src/adapters/anthropic-replay.ts` captures known Anthropic assistant content blocks from the
original SSE frames only for search streams explicitly opted in by the loop. Private WeakMaps
bind complete snapshots to terminal events and then to loop-owned assistant messages; request
parsers, clients, response persistence and logs cannot supply or receive this metadata. The
collector validates ordered start/delta/stop indices and message completion, charges retained
bytes incrementally, and releases unclaimed attempts on cancellation and claimed snapshots when
the loop exits. Unknown blocks/deltas, dropped malformed frames and incomplete histories make
continuation fail before any hosted search executes. Every block start fences signature retries,
including server tools that have no public adapter-event representation.

`src/web-search/anthropic-history.ts` supplies canonical tool identities while the raw snapshot
preserves text-block boundaries, citations, original input objects, opaque thinking and block
order on the wire. Parallel calls stay in one assistant turn; their results keep the existing
search budgets and duplicate-query suppression. Tool-name/id rewrites must agree with the raw
snapshot or serialization fails closed. This is request-local search fidelity, not a durable
cross-request transcript format or a guarantee for unsupported provider block types.

Anthropic forced-answer nudges are appended once to request-local history and remain in their
original sent positions. An empty-answer retry retains the same declared tool catalog and changes
only `tool_choice` to `none`; it does not remove definitions. `src/adapters/anthropic-tool-catalog.ts`
shares the effective advertised catalog between serializer, system guidance and search-loop setup,
including `allowed_tools` restrictions and Opus 5.5 named-tool compatibility narrowing. This avoids
changing bound tools/system or widening permissions during the retry. Other adapters keep their
existing empty-answer policy. Hosted search disabled by the incoming choice remains disabled.

`tests/adapters/anthropic/anthropic-replay.test.ts` pins opt-in ownership, cancellation, malformed
indices, bounded admission, forged/expired snapshot rejection and idempotent budget release.
Nonconforming or repeated tool IDs fail before search execution, including IDs already present
in the request-local history, rather than waiting for the next serializer to reject normalization.
