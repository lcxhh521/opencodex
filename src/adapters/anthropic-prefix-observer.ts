import type { AdapterEvent, AnthropicPrefixHint } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import { jsonUtf8Bytes } from "../lib/json-byte-size";
import { appendAnthropicPrefix, hintForAnthropicBlock, nextAnthropicParent, takeAnthropicPrefixSeed } from "./anthropic-prefix";
import { issueAnthropicPrefixHint } from "./anthropic-prefix-hints";

type Block = Record<string, unknown>;
/** Incremental observation of a complete block, never an attestation of response success. */
export function createAnthropicPrefixObserver(response: Response, budget: TranslatorBudget) {
  const seed = takeAnthropicPrefixSeed(response);
  if (!seed) return;
  let valid = true, started = false, index = 0, bytes = 0;
  let clientRepresentable = true;
  let block: Block | undefined;
  let text: string[] = [], args: string[] = [];
  const release = () => { budget.releaseRetained(bytes, { kind: "reasoning" }); bytes = 0; block = undefined; text = []; args = []; };
  const invalidate = () => { valid = false; release(); };
  const retain = (value: unknown) => { const size = jsonUtf8Bytes(value) * 4 + 64; budget.chargeRetained(size, { kind: "reasoning" }); bytes += size; };
  return {
    invalidate,
    accept(data: Block): { event: AdapterEvent; hint: AnthropicPrefixHint; index: number } | undefined {
      if (!valid) return;
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
        retain(incoming); block = { ...incoming, ...(Array.isArray(incoming.citations) ? { citations: [...incoming.citations] } : {}) };
        if (block.type === "text" || block.type === "thinking") {
          const initial = block.type === "text" ? block.text : block.thinking;
          if (typeof initial !== "string") { invalidate(); return; }
          text = [initial];
        }
      } else if (type === "content_block_delta") {
        const delta = data.delta as Block | undefined;
        if (!block || data.index !== index || !delta) { invalidate(); return; }
        retain(delta);
        if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") text.push(delta.text);
        else if (delta.type === "thinking_delta" && block.type === "thinking" && typeof delta.thinking === "string") text.push(delta.thinking);
        else if (delta.type === "signature_delta" && block.type === "thinking" && typeof delta.signature === "string") block.signature = delta.signature;
        else if (delta.type === "input_json_delta" && block.type === "tool_use" && typeof delta.partial_json === "string") args.push(delta.partial_json);
        else if (delta.type === "citations_delta" && block.type === "text" && delta.citation && typeof delta.citation === "object") {
          if (block.citations !== undefined && !Array.isArray(block.citations)) { invalidate(); return; }
          (block.citations ??= [] as unknown[] as unknown);
          (block.citations as unknown[]).push(delta.citation);
        } else invalidate();
      } else if (type === "content_block_stop") {
        if (!block || data.index !== index) { invalidate(); return; }
        const reservation = budget.reserveTransient(bytes * 2, { kind: "reasoning" });
        try {
          if (block.type === "text") block.text = text.join("");
          if (block.type === "thinking") block.thinking = text.join("");
          if (block.type === "tool_use" && args.length) block.input = JSON.parse(args.join(""));
          let event: AdapterEvent | undefined;
          if (block.type === "thinking" && typeof block.signature === "string" && block.signature.length > 0) event = { type: "thinking_signature", signature: block.signature };
          else if (block.type === "redacted_thinking" && typeof block.data === "string") event = { type: "redacted_thinking", data: block.data };
          else if (block.type === "thinking" || block.type === "redacted_thinking") { invalidate(); return; }
          if (event) {
            const hint = hintForAnthropicBlock(seed, block);
            // Responses currently splits text-before-thinking into separate assistant items.
            // Preserve the payload as legacy rather than issuing a hint it cannot round-trip.
            issueAnthropicPrefixHint(clientRepresentable ? event : { type: "heartbeat" }, hint, seed.generation);
            seed.parent = nextAnthropicParent(seed.parent, block);
            return { event, hint, index: index++ };
          }
          appendAnthropicPrefix(seed.hash, block); clientRepresentable = false; index++;
        } catch { invalidate(); }
        finally { reservation.release(); release(); }
      } else if (type === "message_stop") { if (block) invalidate(); }
      else invalidate();
    },
    dispose: release,
  };
}
