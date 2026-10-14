import { describe, expect, spyOn, test } from "bun:test";
import type { AnthropicPrefixHint, OcxThinkingContent } from "../../src/types";
import { parseRequest } from "../../src/responses/parser";
import { decodeReasoningEnvelope, encodeReasoningEnvelope, OCX_REASONING_PREFIX, type ReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { createTranslatorBudget, TranslatorBudgetExceededError } from "../../src/lib/translator-budget";

const hint: AnthropicPrefixHint = {
  v: 1, scheme: "anthropic-prefix-v1",
  scope: "a".repeat(64), prefix: "b".repeat(64), parent: "c".repeat(64), block: "d".repeat(64),
};
const legacy = { sig: "original-signature", red: ["red-one", "red-two"], txt: "exact\ntext\u0000" };
const wire = (value: unknown): string => OCX_REASONING_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64");

function parsedThinking(envelopes: ReasoningEnvelope[]): OcxThinkingContent[] {
  const parsed = parseRequest({
    model: "anthropic/claude-x",
    input: [
      ...envelopes.map((envelope, index) => ({ type: "reasoning", id: `rs_${index}`, summary: [], encrypted_content: encodeReasoningEnvelope(envelope) })),
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ],
  });
  return parsed.context.messages.flatMap(message => message.role === "assistant"
    ? message.content.filter((part): part is OcxThinkingContent => part.type === "thinking") : []);
}

describe("optional Anthropic prefix envelope metadata", () => {
  test("keeps old envelope bytes and payload semantics unchanged", () => {
    expect(encodeReasoningEnvelope(legacy)).toBe(wire(legacy));
    expect(decodeReasoningEnvelope(wire(legacy))).toEqual(legacy);
    expect(decodeReasoningEnvelope("native-provider-ciphertext")).toBeNull();
  });

  test("recognizes the complete v1 hint and copies only known fields", () => {
    const encoded = wire({ ...legacy, ap: { ...hint, future: "ignored" } });
    expect(decodeReasoningEnvelope(encoded)).toEqual({ ...legacy, ap: hint });
    expect(decodeReasoningEnvelope(encodeReasoningEnvelope({ sig: "s", ap: hint }))).toEqual({ sig: "s", ap: hint });
    expect(decodeReasoningEnvelope(wire({ ap: hint }))).toBeNull();
  });

  test.each([
    null, [], "unrecognized", {}, { ...hint, v: 2 }, { ...hint, v: "1" },
    { ...hint, scheme: "anthropic-prefix-v2" }, { ...hint, scope: "A".repeat(64) },
    { ...hint, prefix: "b".repeat(63) }, { ...hint, parent: "c".repeat(65) },
    { ...hint, block: "d".repeat(64) + "\n" }, { ...hint, scope: 0 }, { ...hint, parent: undefined },
  ].map(ap => ({ ap })))("omits malformed or unknown metadata without losing old payload: %j", ({ ap }) => {
    expect(decodeReasoningEnvelope(wire({ ...legacy, ap }))).toEqual(legacy);
  });

  test("decoding metadata stays behind the existing pre-allocation budget", () => {
    for (const ap of [hint, { ...hint, v: 2, extra: "x".repeat(4096) }]) {
      const encoded = wire({ ...legacy, ap });
      const rejected = createTranslatorBudget({ maxTurnBytes: encoded.length * 8 - 1 });
      const from = spyOn(Buffer, "from");
      try {
        expect(() => decodeReasoningEnvelope(encoded, rejected)).toThrow(TranslatorBudgetExceededError);
        expect(from).not.toHaveBeenCalled();
        expect(rejected.snapshot().currentBytes).toBe(0);
      } finally { from.mockRestore(); rejected.dispose(); }
      const admitted = createTranslatorBudget({ maxTurnBytes: encoded.length * 8 });
      try {
        expect(decodeReasoningEnvelope(encoded, admitted)).toEqual(ap.v === 1 ? { ...legacy, ap: hint } : legacy);
        expect(admitted.snapshot().currentBytes).toBe(0);
      } finally { admitted.dispose(); }
    }
  });

  test("parser carries recognized hints separately from signature and redacted bytes", () => {
    expect(parsedThinking([{ ...legacy, ap: hint }])).toEqual([{
      type: "thinking", thinking: legacy.txt, signature: legacy.sig,
      redacted: legacy.red, anthropicPrefix: hint, itemId: "rs_0",
    }]);
  });

  test("parser never transfers a single-block hint to merged unsigned reasoning", () => {
    const parts = parsedThinking([{ txt: "before" }, { txt: "tagged", ap: hint }, { txt: "after" }]);
    expect(parts.map(part => part.thinking)).toEqual(["before", "tagged", "after"]);
    expect(parts.map(part => part.anthropicPrefix)).toEqual([undefined, hint, undefined]);
  });
});
