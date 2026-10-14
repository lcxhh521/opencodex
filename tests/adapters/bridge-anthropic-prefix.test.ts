import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { getAnthropicPrefixHint, setAnthropicPrefixHint } from "../../src/adapters/anthropic-prefix-hints";
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
