import { anthropicOpaqueFingerprint, anthropicRejectionPolicy, bindAnthropicRejectionResponse } from "./anthropic-rejection-memo";
import type { TranslatorBudget } from "../lib/translator-budget";
import { jsonUtf8Bytes } from "../lib/json-byte-size";
import { createHash, type Hash } from "node:crypto";
import type { AdapterRequest } from "./base";
import type { AnthropicPrefixHint, OcxParsedRequest } from "../types";
import { getAnthropicPrefixHint, isLocallyIssuedAnthropicPrefixHint } from "./anthropic-prefix-hints";

type Block = Record<string, unknown>;
export interface AnthropicPrefixSeed { hash: Hash; parent: string; scope: string; generation: object }
const generations = new WeakMap<object, object>();
function generationFor(parsed: OcxParsedRequest): object {
  const owner = parsed._reasoningReplayScope ?? parsed;
  let generation = generations.get(owner); if (!generation) { generation = {}; generations.set(owner, generation); }
  return generation;
}
export function invalidateAnthropicPrefixGeneration(parsed: OcxParsedRequest): void { generations.set(parsed._reasoningReplayScope ?? parsed, {}); }
const requests = new WeakMap<AdapterRequest, AnthropicPrefixSeed>();
const responses = new WeakMap<Response, AnthropicPrefixSeed>();
export const ANTHROPIC_PREFIX_ROOT = createHash("sha256").update("anthropic-thinking-chain-v1").digest("hex");
/** Stable object ordering; array/block/message order is significant. Only cache annotations vary. */
class UnsupportedPrefixShape extends Error {}
export function canonicalAnthropicPrefix(value: unknown, depth = 0): string {
  if (depth > 128) throw new UnsupportedPrefixShape("Anthropic prefix nesting is unsupported");
  if (Array.isArray(value)) return `[${value.map(item => canonicalAnthropicPrefix(item, depth + 1)).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).filter(key => (value as Block)[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalAnthropicPrefix((value as Block)[key], depth + 1)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function anthropicPrefixDigest(value: unknown): string { return createHash("sha256").update(canonicalAnthropicPrefix(value)).digest("hex"); }
export function appendAnthropicPrefix(hash: Hash, value: unknown): void {
  const encoded = canonicalAnthropicPrefix(value); hash.update(`${Buffer.byteLength(encoded)}:`).update(encoded);
}
function protocolBlock(block: Block): Block { const { cache_control: _cache, ...content } = block; return content; }
function protocolBlocks(value: unknown): unknown { return Array.isArray(value) ? value.map(block => block && typeof block === "object" ? protocolBlock(block as Block) : block) : value; }
export function nextAnthropicParent(parent: string, block: Block): string { return anthropicPrefixDigest([parent, protocolBlock(block)]); }
export function beginAnthropicAssistant(seed: AnthropicPrefixSeed): AnthropicPrefixSeed {
  const copy = { ...seed, hash: seed.hash.copy() }; appendAnthropicPrefix(copy.hash, { role: "assistant" }); return copy;
}
export function hintForAnthropicBlock(seed: AnthropicPrefixSeed, block: Block): AnthropicPrefixHint {
  return { v: 1, scheme: "anthropic-prefix-v1", scope: seed.scope, prefix: seed.hash.copy().digest("hex"),
    parent: seed.parent, block: anthropicPrefixDigest(protocolBlock(block)) };
}
export class AnthropicHistoryIncompatibleError extends Error {
  constructor() { super("Anthropic thinking history is incompatible with the current request prefix; resend a consistent history. Reasoning mode and executed tool results were not changed."); }
}
function scopeFor(parsed: OcxParsedRequest): string | undefined {
  const current = parsed._reasoningReplayScope?.current;
  if (!current?.providerDestinationDurableIdentity || !current.credentialDurableIdentity) return;
  return anthropicPrefixDigest(["anthropic", current.providerDestinationDurableIdentity, current.credentialDurableIdentity, parsed.modelId]);
}
export function isCurrentAnthropicPrefixHint(hint: AnthropicPrefixHint, parsed: OcxParsedRequest): boolean {
  return hint.scope === scopeFor(parsed) && isLocallyIssuedAnthropicPrefixHint(hint, generationFor(parsed));
}
function initialSeed(body: Block, scope: string, generation: object): AnthropicPrefixSeed {
  const hash = createHash("sha256"); appendAnthropicPrefix(hash, { scheme: "anthropic-prefix-v1", system: typeof body.system === "string" ? [{ type: "text", text: body.system }] : protocolBlocks(body.system ?? null), tools: protocolBlocks(body.tools ?? []) });
  return { hash, parent: ANTHROPIC_PREFIX_ROOT, scope, generation };
}
const opaque = (block: Block) => block.type === "thinking" || block.type === "redacted_thinking";
/** The final wire, not the client's input JSON, defines the observed prefix. */
function prepareAnthropicPrefixUnchecked(body: Block, parsed: OcxParsedRequest): AnthropicPrefixSeed | undefined {
  const scope = scopeFor(parsed);
  if (!scope || !Array.isArray(body.messages)) return;
  let seed = initialSeed(body, scope, generationFor(parsed));
  const removed = new Set<Block>();
  const kept: Block[] = [];
  let incompleteChain = false;
  for (const entry of body.messages as Block[]) {
    const before = seed.hash.copy();
    const { content, ...header } = entry; appendAnthropicPrefix(seed.hash, header);
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content as Block[];
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!opaque(block)) { appendAnthropicPrefix(seed.hash, protocolBlock(block)); continue; }
      const hint = getAnthropicPrefixHint(block);
      const comparable = hint?.scope === scope;
      const memo = anthropicRejectionPolicy(parsed);
      const memoStrip = !!memo && (memo.mode === "blanket" || !comparable || memo.fingerprints.has(anthropicOpaqueFingerprint(block) ?? ""));
      const forceStrip = memoStrip || parsed._stripReasoningEncryptedContent === true && !(hint && isCurrentAnthropicPrefixHint(hint, parsed));
      const mismatch = comparable && (hint.block !== anthropicPrefixDigest(protocolBlock(block)) || hint.prefix !== seed.hash.copy().digest("hex"));
      if (forceStrip || mismatch) { removed.add(block); incompleteChain = true; continue; }
      if (comparable) {
        if (hint.parent !== seed.parent) {
          // A complete, explicitly empty predecessor chain starts a new generation after omission.
          if (hint.parent !== ANTHROPIC_PREFIX_ROOT) throw new AnthropicHistoryIncompatibleError();
          for (const prior of kept) removed.add(prior);
          kept.length = 0; seed.parent = ANTHROPIC_PREFIX_ROOT;
        }
        incompleteChain = false;
      } else if (incompleteChain) throw new AnthropicHistoryIncompatibleError();
      kept.push(block); seed.parent = nextAnthropicParent(seed.parent, block);
    }
    if (blocks.length > 0 && blocks.every(opaque)) seed.hash = before;
    else appendAnthropicPrefix(seed.hash, { endMessage: true });
  }
  if (removed.size || parsed._stripReasoningEncryptedContent === true) {
    const filtered = (body.messages as Block[]).map(message => Array.isArray(message.content)
      ? { ...message, content: (message.content as Block[]).filter(block => !removed.has(block)) } : message)
      .filter(message => !Array.isArray(message.content) || message.content.length > 0);
    const last = filtered.at(-1);
    const assistant = filtered.findLast(message => message.role === "assistant");
    if ((body.thinking as Block | undefined)?.type === "enabled" && last?.role === "user"
      && Array.isArray(last.content) && last.content.some(block => (block as Block).type === "tool_result")
      && Array.isArray(assistant?.content) && !assistant.content.some(block => opaque(block as Block))) throw new AnthropicHistoryIncompatibleError();
    body.messages = filtered;
  }
  // Recompute after omission, including any removed empty assistant container.
  seed = initialSeed(body, scope, generationFor(parsed));
  for (const entry of body.messages as Block[]) {
    const before = seed.hash.copy();
    const { content, ...header } = entry; appendAnthropicPrefix(seed.hash, header);
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content as Block[];
    for (const block of blocks) {
      if (opaque(block)) seed.parent = nextAnthropicParent(seed.parent, block);
      else appendAnthropicPrefix(seed.hash, protocolBlock(block));
    }
    if (blocks.length > 0 && blocks.every(opaque)) seed.hash = before;
    else appendAnthropicPrefix(seed.hash, { endMessage: true });
  }
  return seed;
}
/** Account for temporary canonical strings before hashing the already-built wire body. */
export function prepareAnthropicPrefix(body: Block, parsed: OcxParsedRequest, budget?: TranslatorBudget): AnthropicPrefixSeed | undefined {
  if (!scopeFor(parsed)) return undefined;
  const reservation = budget?.reserveTransient(jsonUtf8Bytes(body) * 4, { kind: "reasoning" });
  try { return prepareAnthropicPrefixUnchecked(body, parsed); }
  catch (error) {
    if (!(error instanceof UnsupportedPrefixShape)) throw error;
    const hasHints = Array.isArray(body.messages) && body.messages.some(message => Array.isArray(message.content)
      && message.content.some((block: object) => getAnthropicPrefixHint(block)));
    if (hasHints) throw new AnthropicHistoryIncompatibleError();
    return undefined;
  } finally { reservation?.release(); }
}
export function rememberAnthropicPrefixRequest(request: AdapterRequest, seed: AnthropicPrefixSeed | undefined): void { if (seed) requests.set(request, seed); }
export function bindAnthropicPrefixResponse(request: AdapterRequest | undefined, response: Response): void {
  bindAnthropicRejectionResponse(request, response);
  const seed = request && requests.get(request); if (seed && response.ok) responses.set(response, seed);
}
export function aliasAnthropicPrefixResponse(source: Response, target: Response): void { const seed = responses.get(source); if (seed) responses.set(target, seed); }
export function takeAnthropicPrefixSeed(response: Response): AnthropicPrefixSeed | undefined {
  const seed = responses.get(response); responses.delete(response); return seed && beginAnthropicAssistant(seed);
}
