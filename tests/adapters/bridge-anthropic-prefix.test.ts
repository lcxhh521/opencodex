import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterRequest } from "../../src/adapters/base";
import { createAnthropicPrefixObserver } from "../../src/adapters/anthropic-prefix-observer";
import { ANTHROPIC_PREFIX_ROOT, anthropicPrefixDigest, appendAnthropicPrefix, beginAnthropicAssistant, bindAnthropicPrefixResponse, rememberAnthropicPrefixRequest } from "../../src/adapters/anthropic-prefix";
import { getAnthropicPrefixHint, setAnthropicPrefixHint } from "../../src/adapters/anthropic-prefix-hints";
import { createTranslatorBudget, TranslatorBudgetExceededError } from "../../src/lib/translator-budget";
import { decodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import type { AdapterEvent, AnthropicPrefixHint } from "../../src/types";

function hint(block: string): AnthropicPrefixHint {
  return { v: 1, scheme: "anthropic-prefix-v1", scope: "a".repeat(64), prefix: "b".repeat(64), parent: "c".repeat(64), block: block.repeat(64) };
}
function tagged(event: AdapterEvent, value: AnthropicPrefixHint): AdapterEvent {
  setAnthropicPrefixHint(event, value);
  return event;
}

async function output(events: AdapterEvent[], stream: boolean, hidden: boolean): Promise<Record<string, unknown>[]> {
  if (!stream) return buildResponseJSON(events, "claude-x", { hideThinkingSummary: hidden }).output as Record<string, unknown>[];
  async function* replay() { yield* events; }
  const wire = await new Response(bridgeToResponsesSSE(replay(), "claude-x", undefined, undefined, undefined, undefined, undefined, { hideThinkingSummary: hidden })).text();
  return wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
    .filter(event => event.type === "response.output_item.done").map(event => event.item);
}

const cases = [
  { stream: true, hidden: false }, { stream: true, hidden: true },
  { stream: false, hidden: false }, { stream: false, hidden: true },
];

describe("private Anthropic prefix bridge propagation", () => {
  test("event hints never become public enumerable metadata", () => {
    const event = tagged({ type: "thinking_signature", signature: "signature" }, hint("d"));
    expect(Object.keys(event)).toEqual(["type", "signature"]);
    expect(JSON.stringify(event)).toBe('{"type":"thinking_signature","signature":"signature"}');
    expect(getAnthropicPrefixHint(event)).toEqual(hint("d"));
    expect(getAnthropicPrefixHint({ ...event })).toBeUndefined();
  });

  test.each(cases)("keeps hints on their own signed or redacted blocks: %j", async ({ stream, hidden }) => {
    const items = await output([
      { type: "thinking_delta", thinking: "first" },
      { type: "thinking_signature", signature: "signature-update" },
      { type: "heartbeat" },
      tagged({ type: "thinking_signature", signature: "signature-final" }, hint("d")),
      tagged({ type: "redacted_thinking", data: "red-one" }, hint("e")),
      tagged({ type: "redacted_thinking", data: "red-two" }, hint("f")),
      { type: "thinking_delta", thinking: "second" },
      { type: "thinking_signature", signature: "legacy-signature" },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ], stream, hidden);
    const reasoning = items.filter(item => item.type === "reasoning");
    expect(reasoning.map(item => decodeReasoningEnvelope(item.encrypted_content as string))).toEqual([
      { sig: "signature-final", ap: hint("d"), ...(hidden ? { txt: "first" } : {}) },
      { red: ["red-one"], ap: hint("e") }, { red: ["red-two"], ap: hint("f") },
      { sig: "legacy-signature", ...(hidden ? { txt: "second" } : {}) },
    ]);
    for (const item of items) {
      expect(item).not.toHaveProperty("ap");
      expect(item).not.toHaveProperty("anthropicPrefix");
    }
  });

  test.each(cases)("completed block observation survives a later response failure: %j", async ({ stream, hidden }) => {
    const items = await output([
      { type: "thinking_delta", thinking: "complete block" },
      tagged({ type: "thinking_signature", signature: "signature-final" }, hint("d")),
      { type: "error", message: "later upstream failure" },
    ], stream, hidden);
    const reasoning = items.find(item => item.type === "reasoning")!;
    expect(decodeReasoningEnvelope(reasoning.encrypted_content as string)).toEqual({
      sig: "signature-final", ap: hint("d"), ...(hidden ? { txt: "complete block" } : {}),
    });
  });

  test.each(cases)("keeps empty signed blocks separate at their existing thinking boundaries: %j", async ({ stream, hidden }) => {
    const items = await output([
      { type: "thinking_delta", thinking: "" },
      tagged({ type: "thinking_signature", signature: "signature-one" }, hint("d")),
      { type: "thinking_delta", thinking: "" },
      tagged({ type: "thinking_signature", signature: "signature-two" }, hint("e")),
      { type: "done" },
    ], stream, hidden);
    expect(items.filter(item => item.type === "reasoning").map(item => decodeReasoningEnvelope(item.encrypted_content as string))).toEqual([
      { sig: "signature-one", ap: hint("d") }, { sig: "signature-two", ap: hint("e") },
    ]);
  });

  test.each(cases)("ignores client-shaped enumerable metadata without the private observation: %j", async ({ stream, hidden }) => {
    const fake = Object.assign({ type: "thinking_signature", signature: "signature" } as AdapterEvent, { ap: hint("d"), anthropicPrefix: hint("d") });
    const items = await output([fake, { type: "done" }], stream, hidden);
    const reasoning = items.find(item => item.type === "reasoning")!;
    expect(decodeReasoningEnvelope(reasoning.encrypted_content as string)).toEqual({ sig: "signature" });
  });
});

function observing(block: Record<string, unknown>, maxTurnBytes?: number) {
  const request = {} as AdapterRequest;
  const seed = { hash: createHash("sha256").update("observer fixture"),
    scope: "a".repeat(64), parent: ANTHROPIC_PREFIX_ROOT, generation: {} };
  rememberAnthropicPrefixRequest(request, seed);
  const response = new Response();
  bindAnthropicPrefixResponse(request, response);
  const budget = createTranslatorBudget({ maxTurnBytes });
  const observer = createAnthropicPrefixObserver(response, budget)!;
  observer.accept({ type: "message_start" });
  observer.accept({ type: "content_block_start", index: 0, content_block: block });
  const delta = (value: Record<string, unknown>) => observer.accept({ type: "content_block_delta", index: 0, delta: value });
  const stop = () => observer.accept({ type: "content_block_stop", index: 0 });
  return { observer, budget, delta, stop, seed };
}

describe("Anthropic prefix observer live-buffer accounting", () => {
  test("repeated signature snapshots retain only the current value", () => {
    const { observer, budget, delta, stop } = observing({ type: "thinking", thinking: "", signature: "s".repeat(1_000) }, 16_384);
    try {
      const initial = budget.snapshot().currentBytes;
      delta({ type: "signature_delta", signature: "final" });
      const replaced = budget.snapshot().currentBytes;
      expect(replaced).toBeLessThan(initial);
      for (let index = 0; index < 20_000; index++) delta({ type: "signature_delta", signature: "final" });
      expect(budget.snapshot().currentBytes).toBe(replaced);
      const result = stop()!;
      expect(result.event).toEqual({ type: "thinking_signature", signature: "final" });
      expect(result.hint.block).toBe(anthropicPrefixDigest({ type: "thinking", thinking: "", signature: "final" }));
      expect(getAnthropicPrefixHint(result.event)).toEqual(result.hint);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { observer.dispose(); budget.dispose(); }
  });

  test("tiny thinking frames fit the default budget and preserve the completed digest", () => {
    const { observer, budget, delta, stop } = observing({ type: "thinking", thinking: "", signature: "final" });
    try {
      for (let index = 0; index < 100_000; index++) delta({ type: "thinking_delta", thinking: "x" });
      const result = stop()!;
      expect(result.hint.block).toBe(anthropicPrefixDigest({ type: "thinking", thinking: "x".repeat(100_000), signature: "final" }));
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(budget.snapshot().overflows).toBe(0);
    } finally { observer.dispose(); budget.dispose(); }
  });

  test("empty fragments do not grow retained arrays", () => {
    const { observer, budget, delta, stop } = observing({ type: "thinking", thinking: "", signature: "final" }, 4_096);
    try {
      const initial = budget.snapshot().currentBytes;
      for (let index = 0; index < 20_000; index++) delta({ type: "thinking_delta", thinking: "" });
      expect(budget.snapshot().currentBytes).toBe(initial);
      expect(stop()?.event).toEqual({ type: "thinking_signature", signature: "final" });
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { observer.dispose(); budget.dispose(); }
  });

  test("200k two-character tool fragments fit the default budget", () => {
    const initial = { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} };
    const { observer, budget, delta, stop, seed } = observing(initial);
    try {
      delta({ type: "input_json_delta", partial_json: '{"value":"' });
      for (let index = 0; index < 200_000; index++) delta({ type: "input_json_delta", partial_json: "xx" });
      delta({ type: "input_json_delta", partial_json: '"}' });
      expect(stop()).toBeUndefined();
      expect(budget.snapshot().currentBytes).toBe(0);
      const expected = beginAnthropicAssistant(seed);
      appendAnthropicPrefix(expected.hash, { ...initial, input: { value: "xx".repeat(200_000) } });
      observer.accept({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "final" } });
      expect(observer.accept({ type: "content_block_stop", index: 1 })!.hint.prefix).toBe(expected.hash.digest("hex"));
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(budget.snapshot().overflows).toBe(0);
    } finally { observer.dispose(); budget.dispose(); }
  });

  test("near-2MiB single-fragment tool strings remain within the default budget", () => {
    const initial = { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} };
    const { observer, budget, delta, stop, seed } = observing(initial);
    const value = "x".repeat(2 * 1024 * 1024 - 128);
    try {
      delta({ type: "input_json_delta", partial_json: JSON.stringify({ value }) });
      expect(stop()).toBeUndefined();
      const expected = beginAnthropicAssistant(seed);
      appendAnthropicPrefix(expected.hash, { ...initial, input: { value } });
      observer.accept({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "final" } });
      expect(observer.accept({ type: "content_block_stop", index: 1 })!.hint.prefix).toBe(expected.hash.digest("hex"));
      expect(budget.snapshot().highWaterBytes).toBeLessThan(16 * 1024 * 1024);
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(budget.snapshot().overflows).toBe(0);
    } finally { observer.dispose(); budget.dispose(); }
  });

  test("short-key object-heavy tool JSON is admitted before parsing its allocations", () => {
    const { observer, budget, delta, stop } = observing({ type: "tool_use", id: "tool_fixture", name: "lookup", input: {} }, 4 * 1024 * 1024);
    const parse = spyOn(JSON, "parse");
    try {
      delta({ type: "input_json_delta", partial_json: `{"items":[${'{"a":0},'.repeat(20_000)}{"a":0}]}` });
      budget.chargeRetained(137, { kind: "reasoning" });
      expect(stop).toThrow(TranslatorBudgetExceededError);
      expect(parse).not.toHaveBeenCalled();
      expect(budget.snapshot().currentBytes).toBe(137);
      expect(stop()).toBeUndefined();
    } finally { parse.mockRestore(); observer.dispose(); budget.dispose(); }
  });

  test("denied replacement releases only admitted observer memory", () => {
    const { observer, budget, delta, stop } = observing({ type: "thinking", thinking: "", signature: "initial" }, 4_096);
    try {
      budget.chargeRetained(137, { kind: "reasoning" });
      expect(() => delta({ type: "signature_delta", signature: "x".repeat(4_096) })).toThrow(TranslatorBudgetExceededError);
      expect(budget.snapshot().currentBytes).toBe(137);
      expect(stop()).toBeUndefined();
      observer.dispose(); observer.invalidate(); observer.dispose();
      expect(budget.snapshot().currentBytes).toBe(137);
    } finally { observer.dispose(); budget.dispose(); }
  });

  test("nonempty fragment slots remain bounded by the shared budget", () => {
    const { observer, budget, delta } = observing({ type: "thinking", thinking: "", signature: "final" }, 4_096);
    try {
      expect(() => {
        for (let index = 0; index < 4_096; index++) delta({ type: "thinking_delta", thinking: "x" });
      }).toThrow(TranslatorBudgetExceededError);
      observer.dispose(); observer.dispose();
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { observer.dispose(); budget.dispose(); }
  });

  test("split Unicode and escaped thinking preserve the completed canonical block", () => {
    const parts = ["\ud83d", "\ude80", "\"", "\\", "\u0000", "\ud800"];
    const { observer, budget, delta, stop } = observing({ type: "thinking", thinking: "initial", signature: "final" });
    try {
      for (const thinking of parts) delta({ type: "thinking_delta", thinking });
      expect(stop()!.hint.block).toBe(anthropicPrefixDigest({ type: "thinking", thinking: `initial${parts.join("")}`, signature: "final" }));
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { observer.dispose(); budget.dispose(); }
  });

  test.each([
    { initial: { type: "text", text: "start", citations: [{ source: "first" }] },
      deltas: [{ type: "text_delta", text: "\ud83d" }, { type: "text_delta", text: "\ude80" },
        { type: "citations_delta", citation: { source: "second", nested: ["quoted\"", "\u0000"] } }],
      completed: { type: "text", text: "start🚀", citations: [{ source: "first" }, { source: "second", nested: ["quoted\"", "\u0000"] }] } },
    { initial: { type: "tool_use", id: "tool_fixture", name: "lookup", input: { replaced: true } },
      deltas: [{ type: "input_json_delta", partial_json: '{"value":"\ud83d' }, { type: "input_json_delta", partial_json: '\ude80","nested":{"cache_control":"significant"}}' }],
      completed: { type: "tool_use", id: "tool_fixture", name: "lookup", input: { value: "🚀", nested: { cache_control: "significant" } } } },
  ])("text/citations and tool JSON retain their canonical prefix: $initial.type", ({ initial, deltas, completed }) => {
    const { observer, budget, delta, stop, seed } = observing(initial);
    try {
      for (const value of deltas) delta(value);
      expect(stop()).toBeUndefined();
      expect(budget.snapshot().currentBytes).toBe(0);
      const expected = beginAnthropicAssistant(seed);
      appendAnthropicPrefix(expected.hash, completed);
      observer.accept({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "next" } });
      const result = observer.accept({ type: "content_block_stop", index: 1 })!;
      expect(result.hint.prefix).toBe(expected.hash.digest("hex"));
      expect(result.hint.parent).toBe(ANTHROPIC_PREFIX_ROOT);
      expect(getAnthropicPrefixHint(result.event)).toBeUndefined();
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { observer.dispose(); budget.dispose(); }
  });

  test("denied stop-time reservation refunds the observer and preserves other owners", () => {
    const limit = 4_096;
    const { observer, budget, stop } = observing({ type: "thinking", thinking: "joined", signature: "final" }, limit);
    try {
      const otherBytes = limit - budget.snapshot().currentBytes;
      budget.chargeRetained(otherBytes, { kind: "reasoning" });
      expect(stop).toThrow(TranslatorBudgetExceededError);
      expect(budget.snapshot().currentBytes).toBe(otherBytes);
      expect(stop()).toBeUndefined();
      observer.dispose(); observer.dispose();
      expect(budget.snapshot().currentBytes).toBe(otherBytes);
    } finally { observer.dispose(); budget.dispose(); }
  });

  test.each(["invalidate", "dispose"] as const)("%s releases pending fragments and prevents later hints", method => {
    const { observer, budget, delta, stop } = observing({ type: "thinking", thinking: "", signature: "initial" });
    try {
      delta({ type: "thinking_delta", thinking: "unfinished" });
      observer[method](); observer[method]();
      expect(budget.snapshot().currentBytes).toBe(0);
      delta({ type: "signature_delta", signature: "late" });
      observer.accept({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "late" } });
      expect(stop()).toBeUndefined();
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { observer.dispose(); budget.dispose(); }
  });
});
