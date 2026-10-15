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

// Prefix preparation must not charge the size of already-owned media as a new copy.
describe("bounded Anthropic prefix preparation", () => {
  const scoped = () => ({ modelId: "claude-fixture", _reasoningReplayScope: { current: {
    providerDestinationDurableIdentity: "fixture-destination", credentialDurableIdentity: "fixture-credential",
  } } }) as unknown as import("../../src/types").OcxParsedRequest;
  test("large media without thinking does not allocate a prefix observation", async () => {
    const { prepareAnthropicPrefix } = await import("../../src/adapters/anthropic-prefix");
    const { createTranslatorBudget } = await import("../../src/lib/translator-budget");
    const budget = createTranslatorBudget();
    try {
      const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "A".repeat(9 * 1024 * 1024) } }] }] };
      expect(prepareAnthropicPrefix(body, scoped(), budget)).toBeUndefined();
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(budget.snapshot().highWaterBytes).toBe(0);
    } finally { budget.dispose(); }
  });
  test.each(["image", "document"])("large %s with thinking hashes without a whole-wire temporary copy", async type => {
    const { prepareAnthropicPrefix } = await import("../../src/adapters/anthropic-prefix");
    const { createTranslatorBudget } = await import("../../src/lib/translator-budget");
    const budget = createTranslatorBudget();
    try {
      const body = { thinking: { type: "adaptive" }, messages: [{ role: "user", content: [{ type, source: { type: "base64", data: "A".repeat(9 * 1024 * 1024) } }] }] };
      const seed = prepareAnthropicPrefix(body, scoped(), budget);
      expect(seed).toBeDefined();
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(budget.snapshot().highWaterBytes).toBeLessThan(256 * 1024);
    } finally { budget.dispose(); }
  });
});

test("incremental canonical hashes preserve exact v1 bytes across escaped and surrogate chunk boundaries", async () => {
  const { createHash } = await import("node:crypto");
  const { anthropicPrefixDigest, appendAnthropicPrefix, canonicalAnthropicPrefix } = await import("../../src/adapters/anthropic-prefix");
  const { createTranslatorBudget } = await import("../../src/lib/translator-budget");
  const values = [null, undefined, [1, undefined, null], { b: true, a: "x", skipped: undefined },
    { nested: ["a".repeat(1023) + "😀" + "\\\"\n\u0000\ud800\udc01", { semantic: { cache_control: "keep" } }] },
    { large: "a".repeat(100_000) }, { escaped: "\u0001".repeat(2049) }];
  const budget = createTranslatorBudget();
  try {
    for (const value of values) {
      const canonical = canonicalAnthropicPrefix(value);
      expect(anthropicPrefixDigest(value, budget)).toBe(createHash("sha256").update(canonical).digest("hex"));
      const hash = createHash("sha256"); appendAnthropicPrefix(hash, value, budget);
      expect(hash.digest("hex")).toBe(createHash("sha256").update(`${Buffer.byteLength(canonical)}:`).update(canonical).digest("hex"));
    }
    expect(budget.snapshot().currentBytes).toBe(0);
    expect(budget.snapshot().highWaterBytes).toBeLessThan(64 * 1024);
  } finally { budget.dispose(); }
});
