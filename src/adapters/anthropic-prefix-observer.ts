import type { AdapterEvent, AnthropicPrefixHint } from "../types";
import { isTranslatorBudgetExceededError, type TranslatorBudget, type TranslatorTransientReservation } from "../lib/translator-budget";
import { jsonUtf8Bytes } from "../lib/json-byte-size";
import { appendAnthropicPrefix, hintForAnthropicBlock, nextAnthropicParent, takeAnthropicPrefixSeed } from "./anthropic-prefix";
import { issueAnthropicPrefixHint } from "./anthropic-prefix-hints";

type Block = Record<string, unknown>;
/** Bound parsed JSON storage before allocation, without copying or validating its tokens. */
function parsedJsonBytes(source: string): number {
  let bytes = source.length * 2 + 64;
  let quoted = false, escaped = false, scalar = false;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (quoted) {
      if (escaped) escaped = false;
      else if (code === 92) escaped = true;
      else if (code === 34) quoted = false;
      continue;
    }
    if (code === 34) { bytes += 64; quoted = true; scalar = false; }
    else if (code === 123 || code === 91) { bytes += 64; scalar = false; }
    else if (code === 44 || code === 58) { bytes += code === 44 ? 16 : 32; scalar = false; }
    else if (code === 125 || code === 93 || code === 32 || code === 9 || code === 10 || code === 13) scalar = false;
    else if (!scalar) { bytes += 64; scalar = true; }
  }
  return bytes;
}
/** Incremental observation of a complete block, never an attestation of response success. */
export function createAnthropicPrefixObserver(response: Response, budget: TranslatorBudget) {
  const seed = takeAnthropicPrefixSeed(response);
  if (!seed) return;
  seed.budget = budget;
  let valid = true, started = false, index = 0, bytes = 0;
  let clientRepresentable = true;
  let block: Block | undefined;
  let text: string[] = [], args: string[] = [];
  let textLength = 0, argsLength = 0, signatureBytes = 0, hasArgs = false;
  const release = () => {
    budget.releaseRetained(bytes, { kind: "reasoning" }); bytes = 0; block = undefined; text = []; args = [];
    textLength = 0; argsLength = 0; signatureBytes = 0; hasArgs = false;
  };
  const invalidate = () => { valid = false; release(); };
  const retain = (size: number) => { budget.chargeRetained(size, { kind: "reasoning" }); bytes += size; };
  const append = (parts: string[], value: string) => {
    // Only the payload survives a delta frame. Bound each nonempty string and array slot;
    // empty deltas need neither a retained value nor another slot.
    if (value.length === 0) return;
    retain(value.length * 2 + 48); parts.push(value);
  };
  return {
    invalidate,
    accept(data: Block): { event: AdapterEvent; hint: AnthropicPrefixHint; index: number } | undefined {
      if (!valid) return;
      try {
        const type = data.type;
        if (type === "ping" || type === "message_delta") return;
        if (type === "message_start") {
          const message = data.message as Block | undefined;
          if (started || (Array.isArray(message?.content) && message.content.length > 0)) invalidate();
          else started = true;
          return;
        }
        if (!started) { invalidate(); return; }
        if (type === "content_block_start") {
          const incoming = data.content_block as Block | undefined;
          if (block || data.index !== index || !incoming || !["text", "thinking", "redacted_thinking", "tool_use"].includes(String(incoming.type))) { invalidate(); return; }
          if (incoming.type === "thinking" && Object.keys(incoming).some(key => !["type", "thinking", "signature"].includes(key))) clientRepresentable = false;
          if (incoming.type === "redacted_thinking" && Object.keys(incoming).some(key => !["type", "data"].includes(key))) clientRepresentable = false;
          retain(jsonUtf8Bytes(incoming) * 4 + 64);
          // This portion of the admitted initial block belongs to its replaceable signature.
          signatureBytes = incoming.type === "thinking" && incoming.signature !== undefined ? jsonUtf8Bytes(incoming.signature) * 4 : 0;
          block = { ...incoming, ...(Array.isArray(incoming.citations) ? { citations: [...incoming.citations] } : {}) };
          if (block.type === "text" || block.type === "thinking") {
            const initial = block.type === "text" ? block.text : block.thinking;
            if (typeof initial !== "string") { invalidate(); return; }
            if (initial.length) { retain(16); text = [initial]; }
            textLength = initial.length;
          }
        } else if (type === "content_block_delta") {
          const delta = data.delta as Block | undefined;
          if (!block || data.index !== index || !delta) { invalidate(); return; }
          if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") { append(text, delta.text); textLength += delta.text.length; }
          else if (delta.type === "thinking_delta" && block.type === "thinking" && typeof delta.thinking === "string") { append(text, delta.thinking); textLength += delta.thinking.length; }
          else if (delta.type === "signature_delta" && block.type === "thinking" && typeof delta.signature === "string") {
            const nextBytes = jsonUtf8Bytes(delta.signature) * 4;
            // Admit growth before changing ownership. A refusal must never refund a value
            // that was not admitted, or release another reasoning owner's charge.
            if (nextBytes > signatureBytes) retain(nextBytes - signatureBytes);
            block.signature = delta.signature;
            if (nextBytes < signatureBytes) { budget.releaseRetained(signatureBytes - nextBytes, { kind: "reasoning" }); bytes -= signatureBytes - nextBytes; }
            signatureBytes = nextBytes;
          } else if (delta.type === "input_json_delta" && block.type === "tool_use" && typeof delta.partial_json === "string") {
            append(args, delta.partial_json); argsLength += delta.partial_json.length; hasArgs = true;
          } else if (delta.type === "citations_delta" && block.type === "text" && delta.citation && typeof delta.citation === "object") {
            if (block.citations !== undefined && !Array.isArray(block.citations)) { invalidate(); return; }
            retain(jsonUtf8Bytes(delta.citation) * 4 + 64);
            (block.citations ??= [] as unknown[] as unknown);
            (block.citations as unknown[]).push(delta.citation);
          } else invalidate();
        } else if (type === "content_block_stop") {
          if (!block || data.index !== index) { invalidate(); return; }
          let reservation: TranslatorTransientReservation | undefined, parsedReservation: TranslatorTransientReservation | undefined;
          try {
            // Fragment headers/signature snapshots are not copied. Admit joined strings, then
            // parsed token/container storage; hashing owns its bounded canonical scratch.
            reservation = budget.reserveTransient((textLength + argsLength) * 2 + 64, { kind: "reasoning" });
            if (block.type === "text") block.text = text.join("");
            if (block.type === "thinking") block.thinking = text.join("");
            if (block.type === "tool_use" && hasArgs) {
              const joined = args.join("");
              parsedReservation = budget.reserveTransient(parsedJsonBytes(joined), { kind: "reasoning" });
              block.input = JSON.parse(joined);
            }
            let event: AdapterEvent | undefined;
            if (block.type === "thinking" && typeof block.signature === "string" && block.signature.length > 0) event = { type: "thinking_signature", signature: block.signature };
            else if (block.type === "redacted_thinking" && typeof block.data === "string") event = { type: "redacted_thinking", data: block.data };
            else if (block.type === "thinking" || block.type === "redacted_thinking") { invalidate(); return; }
            if (event) {
              const hint = hintForAnthropicBlock(seed, block);
              // Responses currently splits text-before-thinking into separate assistant items.
              // Preserve the payload as legacy rather than issuing a hint it cannot round-trip.
              issueAnthropicPrefixHint(clientRepresentable ? event : { type: "heartbeat" }, hint, seed.generation);
              seed.parent = nextAnthropicParent(seed.parent, block, budget);
              return { event, hint, index: index++ };
            }
            appendAnthropicPrefix(seed.hash, block, budget); clientRepresentable = false; index++;
          } catch (error) { invalidate(); if (isTranslatorBudgetExceededError(error)) throw error; }
          finally { parsedReservation?.release(); reservation?.release(); release(); }
        } else if (type === "message_stop") { if (block) invalidate(); }
        else invalidate();
      } catch (error) { invalidate(); throw error; }
    },
    dispose: invalidate,
  };
}
