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
It invalidates the request-local observation generation: older opaque blocks are stripped, while
complete blocks observed on the repaired request can survive later search iterations.
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

## Selective rejection memos

`src/adapters/anthropic-rejection-memo.ts` captures the complete opaque-payload fingerprint set
from the final Anthropic request body after normalization and prefix filtering. Private WeakMaps
bind that set to the actual adapter request and its exact upstream `Response`; recovery does not
infer what was sent from a later rebuilt request or a caller-supplied hint. Each fingerprint is a
64-character lowercase SHA-256 digest of the block type, a separator, and the signature bytes for
`thinking` or data bytes for `redacted_thinking`. The domains are separate even when their opaque
bytes are identical. Plaintext and `ap` metadata do not participate, so editing either cannot make
an already rejected opaque payload appear new. Only a complete, nonempty, reliable set of at most
256 distinct fingerprints permits selective memoization; absent/incomplete capture falls back to
the existing blanket policy.

`src/responses/reasoning-replay-cache.ts` retains these fingerprints in the existing rejection
memo after the same validated successful-repair gate. Repeated selective entries union their sets;
invalid, empty or overflowing input becomes blanket, and an existing blanket entry cannot be
narrowed before expiry. Each retained fingerprint adds 64 bytes to the existing 256 KiB rejection
memo budget; the 64-entry oldest-first bound, durable scope, five-minute TTL and clear behavior are
unchanged. Getter results contain defensive set copies. No raw opaque payload is stored by this
memo, and no new cache, persistent key or database is introduced.

An active selective memo removes the captured rejected payloads, even if their visible text or
hint changed. Legacy blocks and blocks without a comparable recognized prefix observation retain
the conservative strip behavior under an active memo. A different opaque payload with a recognized
same-scope observation is only a candidate for retention: its block, non-thinking prefix and parent
chain must still pass the normal prefix-consistency checks. Older/blanket memos and unreliable or
oversized captures keep the existing blanket behavior; other adapters are unchanged. An active
memo never opens another signature-recovery attempt or increases the request send budget. The
memo is still process-local and does not change the legacy/no-new-thinking restart limitations.

`tests/adapters/reasoning-replay-identity.test.ts` covers selective union, blanket fallback,
defensive copies, byte/count eviction, expiry and scope isolation.

## Portable prefix-consistency observations

`src/adapters/anthropic-prefix.ts` compares replay observations against the final normalized
Anthropic body, after effective system guidance, advertised tools, message/tool normalization and
cache annotations have been applied. It hashes the effective system and tool definitions, message
boundaries and ordered non-thinking content. Signed/redacted blocks have a separate ordered
parent/block digest chain, so removing an incompatible opaque segment does not itself change the
non-thinking prefix. Assistant containers containing only opaque blocks do not contribute to it.
Object-key order is canonicalized; array, message and content-block order remains significant.
Only `cache_control` annotations at protocol system-block, tool-definition and message-content-block
positions are excluded. A field with that name inside a tool input, schema or other nested content
remains significant.

The existing `ocxr1` reasoning envelope can carry optional `ap` metadata with `v: 1`,
`scheme: "anthropic-prefix-v1"`, and four 64-character lowercase SHA-256 hex digests: `scope`,
`prefix`, `parent`, and `block`. Scope binds the durable provider destination, physical credential
identity and model. The envelope remains transparent base64 JSON, not encryption; the hashes are
consistency observations, not authentication, local verification of Anthropic's signature, or a
claim that Anthropic accepts every field in this comparison as its own signing contract.

`src/adapters/anthropic-prefix-observer.ts` observes ordered complete blocks from the response
associated with that request. Streaming hints are issued only after the matching `content_block_stop`;
JSON blocks are observed through equivalent start/stop processing. The final signature event, or
one complete redacted event, receives private metadata through `src/adapters/anthropic-prefix-hints.ts`.
SSE and JSON bridges copy it into that block's envelope without adding public adapter-event fields.
An unfinished or invalidated redacted observation retains its original payload without a hint when
normal error/EOF processing can emit it; cancellation releases pending buffers without minting one.
A complete-block hint remains an observation even if the response later fails or is incomplete.
It cannot authorize a retry, establish final success, or commit the rejection memo.

Recognized same-scope prefix/block mismatches remove only the incompatible opaque blocks. A retained
block must also match the surviving opaque parent chain; a root parent can establish a new empty
chain and retire older opaque predecessors after an omission. An unresolved parent-chain mismatch
fails before sending rather than inventing a predecessor. Fresh observations from the current
post-recovery generation remain eligible during later search iterations despite the older strip
flag. Plaintext, tool calls, executed tool results, advertised tools and reasoning mode are preserved.
If omission would leave a manual `thinking: enabled` tool-result continuation without its required
assistant thinking, the adapter reports incompatible history before sending; it does not disable
thinking or re-execute the tool.

Missing/malformed metadata, unknown versions and unknown scopes are not themselves evidence of
invalidity; the original payload remains governed by legacy policies, including an active rejection
memo's conservative stripping. If an
already-pruned chain cannot be reconciled with a later unrecognized block, the guard fails closed.
No comparable durable scope means no new observation. The client-facing bridge cannot preserve the
original assistant-message shape for thinking after text/tool content, so those blocks remain
legacy, without a client hint. Opted-in raw search snapshots preserve that shape and may retain the
private observation. Unsupported block shapes likewise do not acquire an invented client hint.

No client change, new signing key, database or persistent store is introduced. Comparable hints
travel with existing reasoning items and work independently of process caches. This does not add a
durable omission marker to responses with no newly observed signed/redacted thinking: such repairs,
and legacy histories without comparable hints, can still depend on the existing five-minute
in-memory rejection memo and encounter the original refusal again after restart.

`tests/responses/responses-anthropic-prefix-consistency.test.ts` covers replay across fresh cache
state, prefix edits, selective omission, repaired generations, manual-tool refusal, unknown metadata,
complete/incomplete blocks and later failures. `tests/responses/reasoning-envelope-prefix.test.ts`
and `tests/adapters/bridge-anthropic-prefix.test.ts` cover bounded decoding and private propagation.

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

Request-local fingerprint capture charges 256 retained translation-budget bytes per unique digest,
including conservative Set/copy overhead, until the existing turn budget is disposed. Partial
capture is refunded on invalid input, admission denial or overflow and cannot narrow the memo.
