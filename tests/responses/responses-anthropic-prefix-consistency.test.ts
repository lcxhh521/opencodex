import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCompactionSummary } from "../../src/responses/compaction";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { anthropicPrefixDigest, bindAnthropicPrefixResponse } from "../../src/adapters/anthropic-prefix";
import { createTranslatorBudget, type TranslatorBudget } from "../../src/lib/translator-budget";
import { resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import { decodeReasoningEnvelope, encodeReasoningEnvelope, type ReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import { parseRequest } from "../../src/responses/parser";
import { handleResponses } from "../../src/server/responses/core";
import { bindRouteReasoningReplayScope } from "../../src/server/responses/core-replay";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
const SIGNATURE = "SyntheticPrefixSignature123456==";
const SECOND_SIGNATURE = "SyntheticNextPrefixSignature123456==";
const MODEL = "claude-sonnet-5";
const REJECTION = "Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the thinking block and retry.";
const TOOLS = [{ type: "function", name: "lookup", description: "Fixture lookup", parameters: { type: "object", properties: {} } }];
type Item = Record<string, unknown>;
let home = "";
let release: (() => void) | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-prefix-roundtrip-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  resetWorkflowBudgetsForTest();
});
afterEach(() => {
  try { release?.(); } finally {
    release = undefined;
    globalThis.fetch = originalFetch;
    clearReasoningReplayCacheForTests();
    resetThoughtSignatureReplayForTests();
    resetWorkflowBudgetsForTest();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  }
});

function config(): OcxConfig {
  return { defaultProvider: "anthropic-test", emptyCompletionRetry: false, providers: { "anthropic-test": {
    adapter: "anthropic", baseUrl: "https://anthropic.example.test", authMode: "key",
    apiKey: "synthetic-test-key", proxy: "direct", models: [MODEL, "claude-sonnet-4-5"],
  } } } as OcxConfig;
}
const user = (text: string): Item => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
function request(input: Item[], stream: boolean, overrides: Item = {}): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "x-codex-parent-thread-id": "prefix-fixture-thread" },
    body: JSON.stringify({ model: `anthropic-test/${MODEL}`, stream, store: false,
      instructions: "Preserve the fixture context.", reasoning: { effort: "high", summary: "detailed" },
      tools: TOOLS, input, ...overrides }),
  });
}
function frame(type: string, data: Item = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}
function signedFrames(signature = SIGNATURE, thinking = "Complete fixture reasoning"): string[] {
  return [
    frame("message_start", { message: { id: "msg_fixture", role: "assistant", content: [], usage: { input_tokens: 2 } } }),
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking } }),
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature } }),
    frame("content_block_stop", { index: 0 }),
  ];
}
function upstream(signature = SIGNATURE, tool = false, stream = true): Response {
  if (!stream) return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: MODEL,
    content: [{ type: "thinking", thinking: "Complete fixture reasoning", signature },
      tool ? { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} } : { type: "text", text: "Fixture answer" }],
    stop_reason: tool ? "tool_use" : "end_turn", usage: { input_tokens: 2, output_tokens: 3 } });
  const frames = signedFrames(signature);
  if (tool) frames.push(
    frame("content_block_start", { index: 1, content_block: { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} } }),
    frame("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }),
    frame("content_block_stop", { index: 1 }),
  );
  else frames.push(
    frame("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Fixture answer" } }),
    frame("content_block_stop", { index: 1 }),
  );
  frames.push(frame("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } }), frame("message_stop"));
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}
function upstreamBlocks(content: Item[], stream: boolean): Response {
  const usage = { input_tokens: 2, output_tokens: 3 };
  if (!stream) return Response.json({ id: "msg_blocks", type: "message", role: "assistant", content, stop_reason: "end_turn", usage });
  const frames = [frame("message_start", { message: { content: [], usage } })];
  content.forEach((block, index) => {
    const contentBlock = block.type === "thinking" ? { type: "thinking", thinking: "" }
      : block.type === "text" ? { type: "text", text: "" } : block;
    frames.push(frame("content_block_start", { index, content_block: contentBlock }));
    if (block.type === "thinking") frames.push(
      frame("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } }),
      frame("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } }),
    );
    if (block.type === "text") frames.push(frame("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }));
    frames.push(frame("content_block_stop", { index }));
  });
  frames.push(frame("message_delta", { delta: { stop_reason: "end_turn" }, usage }), frame("message_stop"));
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}
function failureAfterBlock(stream: boolean): Response {
  if (!stream) return Response.json({ content: [{ type: "thinking", thinking: "Complete fixture reasoning", signature: SECOND_SIGNATURE }],
    stop_reason: "error", usage: { input_tokens: 2, output_tokens: 3 } });
  return new Response([...signedFrames(SECOND_SIGNATURE), frame("error", { error: { type: "invalid_request_error", message: REJECTION } })].join(""),
    { headers: { "content-type": "text/event-stream" } });
}
function transport(answer: (index: number, stream: boolean) => Response | Promise<Response>) {
  const bodies: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!["https://anthropic.example.test/v1/messages", "https://other-anthropic.example.test/v1/messages"].includes(url)) {
      throw new Error(`Unexpected network target blocked: ${url}`);
    }
    bodies.push(String(init?.body));
    return answer(bodies.length, JSON.parse(String(init?.body)).stream === true);
  }) as typeof fetch;
  return bodies;
}
async function send(input: Item[], stream = false, overrides: Item = {}, cfg = config(), options: Parameters<typeof handleResponses>[3] = {}) {
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(request(input, stream, overrides), cfg, log, options);
  const text = await response.text();
  const events = stream ? text.split("\n").filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6)) as Item) : [];
  const json = stream ? undefined : JSON.parse(text);
  const output = (stream ? events.filter(event => event.type === "response.output_item.done").map(event => event.item)
    : json?.output ?? []) as Item[];
  return { response, text, output, log, json, events };
}
function envelope(output: Item[]): ReasoningEnvelope {
  const reasoning = output.find(item => item.type === "reasoning");
  expect(reasoning).toBeDefined();
  const decoded = decodeReasoningEnvelope(String(reasoning!.encrypted_content));
  expect(decoded).not.toBeNull();
  return decoded!;
}
function expectHint(output: Item[], signature = SIGNATURE): void {
  const decoded = envelope(output);
  expect(decoded.sig).toBe(signature);
  expect(decoded.ap).toEqual({ v: 1, scheme: "anthropic-prefix-v1", scope: expect.stringMatching(/^[0-9a-f]{64}$/),
    prefix: expect.stringMatching(/^[0-9a-f]{64}$/), parent: expect.stringMatching(/^[0-9a-f]{64}$/), block: expect.stringMatching(/^[0-9a-f]{64}$/) });
  output.forEach(item => { expect(item).not.toHaveProperty("ap"); expect(item).not.toHaveProperty("anthropicPrefix"); });
}
function expectAdaptive(body: string): void { expect(JSON.parse(body).thinking.type).toBe("adaptive"); }

type OpaqueKind = "thinking" | "redacted";
function memoBlocks(kind: OpaqueKind, payload: string): Item[] {
  return [kind === "thinking" ? { type: "thinking", thinking: "Complete fixture reasoning", signature: payload }
    : { type: "redacted_thinking", data: payload }, { type: "text", text: "Fixture answer" }];
}
function bindingRejection(): Response {
  return Response.json({ type: "error", error: { type: "invalid_request_error", message: REJECTION } }, { status: 400 });
}
async function recoveredMemoScenario(stream: boolean, kind: OpaqueKind, nextRefusal?: "http" | "sse") {
  const oldPayload = kind === "thinking" ? SIGNATURE : "synthetic-rejected-redacted-payload";
  const newPayload = kind === "thinking" ? SECOND_SIGNATURE : "synthetic-fresh-redacted-payload";
  const bodies = transport((index, upstreamStream) => {
    if (index === 2) return bindingRejection();
    if (index === 4 && nextRefusal) return nextRefusal === "http" ? bindingRejection()
      : new Response(frame("error", { error: { type: "invalid_request_error", message: REJECTION } }),
        { headers: { "content-type": "text/event-stream" } });
    return upstreamBlocks(memoBlocks(kind, index === 1 ? oldPayload : newPayload), upstreamStream);
  });
  const first = await send([user("First question")], stream);
  expect(envelope(first.output).ap).toBeDefined();
  const history = [user("First question"), ...first.output, user("Second question")];
  const recovered = await send(history, stream);
  expect(envelope(recovered.output).ap).toBeDefined();
  expect(recovered.log.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
  expect(bodies).toHaveLength(3);
  expect(bodies[1]).toContain(oldPayload);
  expect(bodies[2]).not.toContain(oldPayload);
  return { bodies, oldPayload, newPayload, history, recovered };
}

describe("Anthropic prefix hints through actual Responses requests", () => {
  for (const stream of [false, true]) for (const hidden of [false, true]) {
    test(`minted envelope survives unchanged and append-only replay without caches (stream=${stream}, hidden=${hidden})`, async () => {
      const bodies = transport((_index, upstreamStream) => upstream(SIGNATURE, false, upstreamStream));
      const overrides = { reasoning: { effort: "high", summary: hidden ? "none" : "detailed" } };
      const first = await send([user("First question")], stream, overrides);
      expect(first.response.status).toBe(200);
      expectHint(first.output);
      expect(JSON.stringify(first.log)).not.toContain(envelope(first.output).ap!.scope);
      expect(JSON.stringify(first.log)).not.toContain(SIGNATURE);
      if (hidden) expect(envelope(first.output).txt).toBe("Complete fixture reasoning");
      // The replay crosses a JSON boundary, with fresh configuration and no serving/rejection cache.
      const history = JSON.parse(JSON.stringify([user("First question"), ...first.output])) as Item[];
      clearReasoningReplayCacheForTests();
      resetThoughtSignatureReplayForTests();
      await send(history, stream, overrides);
      await send([...history, user("Append-only next question")], stream, overrides);
      expect(bodies).toHaveLength(3);
      for (const body of bodies.slice(1)) {
        expect(body).toContain(SIGNATURE);
        expect(body).toContain("Complete fixture reasoning");
        expectAdaptive(body);
        expect(body).not.toContain("anthropic-prefix-v1");
        expect(body).not.toContain('"anthropicPrefix"');
      }
    });
  }

  for (const stream of [false, true]) for (const change of ["earlier-input", "system", "tools", "compaction"] as const) {
    test(`known ${change} mismatch removes incompatible thinking without changing mode (stream=${stream})`, async () => {
      const bodies = transport((_index, upstreamStream) => upstream(SIGNATURE, false, upstreamStream));
      const first = await send([user("First question")], stream);
      expectHint(first.output);
      const history = [user("First question"), ...first.output, user("Next question")];
      const overrides: Item = {};
      if (change === "earlier-input") history[0] = user("Edited first question");
      if (change === "system") overrides.instructions = "Changed system instructions.";
      if (change === "tools") overrides.tools = [{ ...TOOLS[0], description: "Changed lookup contract" }];
      if (change === "compaction") history.splice(0, 1, { type: "compaction",
        encrypted_content: encodeCompactionSummary("A compacted summary replaces the original question.") });
      const result = await send(history, stream, overrides);
      expect(result.response.status).toBe(200);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).not.toContain(SIGNATURE);
      expect(bodies[1]).not.toContain('"type":"thinking"');
      expect(bodies[1]).toContain("Fixture answer");
      expect(bodies[1]).toContain("Next question");
      expectAdaptive(bodies[1]!);
      expect(result.log.activeAttempt?.sendCount).toBe(1);
      expect(result.log.activeAttempt?.recoveryKinds ?? []).toEqual([]);
    });
  }

  for (const stream of [false, true]) {
    test(`edits between generations remove only the invalid segment (stream=${stream})`, async () => {
      const bodies = transport((index, upstreamStream) => upstream(index === 1 ? SIGNATURE : SECOND_SIGNATURE, false, upstreamStream));
      const first = await send([user("First question")], stream);
      const secondInput = [user("First question"), ...first.output, user("Second question")];
      const second = await send(secondInput, stream);
      expectHint(second.output, SECOND_SIGNATURE);
      const changed = [...secondInput.slice(0, -1), user("Edited second question"), ...second.output, user("Third question")];
      const result = await send(changed, stream);
      expect(result.response.status).toBe(200);
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).toContain(SIGNATURE);
      expect(bodies[2]).not.toContain(SECOND_SIGNATURE);
      expect(bodies[2]).toContain("Edited second question");
      expect(bodies[2]).toContain("Third question");
    });

    test(`newly minted thinking after omission survives the next request (stream=${stream})`, async () => {
      const bodies = transport((index, upstreamStream) => upstream(index === 1 ? SIGNATURE : SECOND_SIGNATURE, false, upstreamStream));
      const first = await send([user("First question")], stream);
      const changed = [user("Edited first question"), ...first.output, user("Second question")];
      const second = await send(changed, stream);
      expectHint(second.output, SECOND_SIGNATURE);
      const third = await send([...changed, ...second.output, user("Third question")], stream);
      expect(third.response.status).toBe(200);
      expect(bodies).toHaveLength(3);
      expect(bodies[1]).not.toContain(SIGNATURE);
      expect(bodies[2]).not.toContain(SIGNATURE);
      expect(bodies[2]).toContain(SECOND_SIGNATURE);
      expectAdaptive(bodies[2]!);
    });

    test(`successful recovery memo preserves new matched thinking across requests (stream=${stream})`, async () => {
      const bodies = transport((index, upstreamStream) => index === 2
        ? Response.json({ type: "error", error: { type: "invalid_request_error", message: REJECTION } }, { status: 400 })
        : upstream(index >= 3 ? SECOND_SIGNATURE : SIGNATURE, false, upstreamStream));
      const first = await send([user("First question")], stream);
      const history = [user("First question"), ...first.output, user("Second question")];
      const recovered = await send(history, stream);
      expectHint(recovered.output, SECOND_SIGNATURE);
      expect(recovered.log.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).not.toContain(SIGNATURE);
      const next = await send([...history, ...recovered.output, user("Third question")], stream);
      expect(next.response.status).toBe(200);
      expect(bodies).toHaveLength(4);
      expect(bodies[3]).not.toContain(SIGNATURE);
      expect(bodies[3]).toContain(SECOND_SIGNATURE);
    });

    test(`completed block hints do not convert a failed turn to success or authorize a retry (stream=${stream})`, async () => {
      const bodies = transport((index, upstreamStream) => index === 2 ? failureAfterBlock(upstreamStream) : upstream(SIGNATURE, false, upstreamStream));
      const first = await send([user("First question")], stream);
      const history = [user("First question"), ...first.output, user("Second question")];
      const failed = await send(history, stream);
      expect(failed.text).toContain(stream ? REJECTION : 'upstream ended the turn');
      if (stream) expect(failed.text).toContain("response.failed");
      else expect(failed.json.status).toBe("failed");
      expectHint(failed.output, SECOND_SIGNATURE);
      expect(bodies).toHaveLength(2);
      await send(history, stream);
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).toContain(SIGNATURE);
    });

    test(`failed recovered turn keeps its completed observation without memoizing omission (stream=${stream})`, async () => {
      const bodies = transport((index, upstreamStream) => index === 2
        ? Response.json({ type: "error", error: { type: "invalid_request_error", message: REJECTION } }, { status: 400 })
        : index === 3 ? failureAfterBlock(upstreamStream) : upstream(SIGNATURE, false, upstreamStream));
      const first = await send([user("First question")], stream);
      const history = [user("First question"), ...first.output, user("Second question")];
      const failed = await send(history, stream);
      if (stream) expect(failed.text).toContain("response.failed");
      else expect(failed.json.status).toBe("failed");
      expectHint(failed.output, SECOND_SIGNATURE);
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).not.toContain(SIGNATURE);
      expect(failed.log.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
      await send(history, stream);
      expect(bodies).toHaveLength(4);
      expect(bodies[3]).toContain(SIGNATURE);
    });

    test(`manual tool continuation reports incompatible history without a downgraded send (stream=${stream})`, async () => {
      const bodies = transport((_index, upstreamStream) => upstream(SIGNATURE, true, upstreamStream));
      const overrides = { model: "anthropic-test/claude-sonnet-4-5" };
      const first = await send([user("Run the fixture tool")], stream, overrides);
      expectHint(first.output);
      expect(JSON.parse(bodies[0]!).thinking.type).toBe("enabled");
      const next = await send([user("Edited request for the fixture tool"), ...first.output,
        { type: "function_call_output", call_id: "tool_fixture", output: "Already executed fixture result" }], stream, overrides);
      expect(next.text).toContain("incompatible");
      expect(next.text).toContain("consistent history");
      expect(bodies).toHaveLength(1);
    });
  }

  for (const stream of [false, true]) {
    test(`redacted and consecutive signed blocks preserve their own hints and order (stream=${stream})`, async () => {
      const blocks = [
        { type: "thinking", thinking: "First thinking", signature: SIGNATURE },
        { type: "redacted_thinking", data: "synthetic-redacted-prefix-one" },
        { type: "redacted_thinking", data: "synthetic-redacted-prefix-two" },
        { type: "thinking", thinking: "Second thinking", signature: SECOND_SIGNATURE },
        { type: "text", text: "Fixture answer" },
      ];
      const bodies = transport((_index, upstreamStream) => upstreamBlocks(blocks, upstreamStream));
      const first = await send([user("First question")], stream);
      const reasoning = first.output.filter(item => item.type === "reasoning").map(item => decodeReasoningEnvelope(String(item.encrypted_content))!);
      expect(reasoning).toHaveLength(4);
      expect(reasoning.map(item => item.sig ?? item.red?.[0])).toEqual([
        SIGNATURE, "synthetic-redacted-prefix-one", "synthetic-redacted-prefix-two", SECOND_SIGNATURE,
      ]);
      reasoning.forEach(item => expect(item.ap?.scheme).toBe("anthropic-prefix-v1"));
      expect(new Set(reasoning.map(item => item.ap?.parent)).size).toBe(4);
      await send([user("First question"), ...first.output, user("Next question")], stream);
      const replayed = JSON.parse(bodies[1]!).messages.find((item: Item) => item.role === "assistant").content;
      expect(replayed.map(({ cache_control: _cache, ...block }: Item) => block)).toEqual(blocks);
      await send([user("Edited first question"), ...first.output, user("Next question")], stream);
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).not.toContain(SIGNATURE);
      expect(bodies[2]).not.toContain(SECOND_SIGNATURE);
      expect(bodies[2]).not.toContain("synthetic-redacted-prefix");
    });
  }

  for (const stream of [false, true]) for (const thinking of ["", "Consecutive thinking"]) {
    test(`consecutive signed blocks keep separate envelopes and exact replay text (stream=${stream}, empty=${!thinking})`, async () => {
      const blocks = [{ type: "thinking", thinking, signature: SIGNATURE },
        { type: "thinking", thinking, signature: SECOND_SIGNATURE }, { type: "text", text: "Fixture answer" }];
      const bodies = transport((_index, upstreamStream) => upstreamBlocks(blocks, upstreamStream));
      const first = await send([user("First question")], stream);
      const reasoning = first.output.filter(item => item.type === "reasoning").map(item => decodeReasoningEnvelope(String(item.encrypted_content))!);
      expect(reasoning.map(item => item.sig)).toEqual([SIGNATURE, SECOND_SIGNATURE]);
      expect(reasoning.map(item => item.ap?.scheme)).toEqual(["anthropic-prefix-v1", "anthropic-prefix-v1"]);
      await send([user("First question"), ...first.output, user("Next question")], stream);
      const replayed = JSON.parse(bodies[1]!).messages.find((item: Item) => item.role === "assistant").content;
      expect(replayed.map(({ cache_control: _cache, ...block }: Item) => block)).toEqual(blocks);
    });
  }

  for (const stream of [false, true]) {
    test(`signed-only assistant output replays before a user continuation (stream=${stream})`, async () => {
      const blocks = [{ type: "thinking", thinking: "Signed-only reasoning", signature: SIGNATURE }];
      const bodies = transport((_index, upstreamStream) => upstreamBlocks(blocks, upstreamStream));
      const first = await send([user("First question")], stream);
      expectHint(first.output);
      await send([user("First question"), ...first.output, user("Next question")], stream);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain(SIGNATURE);
      expect(bodies[1]).toContain("Signed-only reasoning");
    });

    test(`thinking following assistant text stays legacy when its wire prefix cannot round-trip (stream=${stream})`, async () => {
      const blocks = [{ type: "thinking", thinking: "First thinking", signature: SIGNATURE },
        { type: "text", text: "Intermediate assistant text" },
        { type: "thinking", thinking: "Second thinking", signature: SECOND_SIGNATURE },
        { type: "text", text: "Fixture answer" }];
      const bodies = transport((_index, upstreamStream) => upstreamBlocks(blocks, upstreamStream));
      const first = await send([user("First question")], stream);
      const reasoning = first.output.filter(item => item.type === "reasoning").map(item => decodeReasoningEnvelope(String(item.encrypted_content))!);
      expect(reasoning.map(item => item.ap?.scheme)).toEqual(["anthropic-prefix-v1", undefined]);
      await send([user("First question"), ...first.output, user("Next question")], stream);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain(SIGNATURE);
      expect(bodies[1]).toContain(SECOND_SIGNATURE);
    });
  }

  for (const ending of ["eof", "error", "message-stop", "invalidated"] as const) {
    test(`unfinished redacted block preserves its payload without a hint at ${ending}`, async () => {
      const redacted = "synthetic-partial-redacted-prefix";
      const frames = [frame("message_start", { message: { content: [], usage: { input_tokens: 2 } } }),
        frame("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: redacted } })];
      if (ending === "error") frames.push(frame("error", { error: { type: "invalid_request_error", message: REJECTION } }));
      if (ending === "message-stop") frames.push(frame("message_stop"));
      if (ending === "invalidated") frames.push("event: unknown\ndata: not-json\n\n", frame("content_block_stop", { index: 0 }), frame("message_stop"));
      const bodies = transport((index, stream) => index === 1
        ? new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } }) : upstream(SIGNATURE, false, stream));
      const first = await send([user("First question")], true);
      const observed = envelope(first.output);
      expect(observed.red).toEqual([redacted]);
      expect(observed.ap).toBeUndefined();
      expect(bodies).toHaveLength(1);
      if (ending === "eof" || ending === "error") expect(first.text).toContain("response.failed");
      await send([user("First question"), ...first.output, user("Next question")], true);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain(redacted);
    });
  }

  test("canceling while a redacted block is pending releases retained bytes without issuing a hint", async () => {
    const abort = new AbortController();
    const budget = createTranslatorBudget();
    const charged = spyOn(budget, "chargeRetained");
    const released = spyOn(budget, "releaseRetained");
    let abortScheduled = false;
    let canceled = false;
    let retainedBeforeAbort = 0;
    const bodies = transport(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          frame("message_start", { message: { content: [], usage: { input_tokens: 2 } } }),
          frame("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: "synthetic-pending-redacted" } }),
        ].join("")));
      },
      pull() {
        if (abortScheduled) return;
        abortScheduled = true;
        setTimeout(() => { retainedBeforeAbort = budget.snapshot().currentBytes; abort.abort(); }, 0);
      },
      cancel() { canceled = true; },
    }), { headers: { "content-type": "text/event-stream" } }));
    let wire = "";
    try {
      const response = await handleResponses(request([user("First question")], true), config(), { model: "", provider: "" },
        { abortSignal: abort.signal, translatorBudget: budget });
      try { wire = await response.text(); } catch { /* The client cancellation can reject its stream reader. */ }
      expect(abort.signal.aborted).toBe(true);
      expect(retainedBeforeAbort).toBeGreaterThan(0);
      expect(bodies).toHaveLength(1);
      expect(canceled).toBe(true);
      expect(wire).not.toContain("anthropic-prefix-v1");
      const completed = wire.split("\n").filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice(6))).filter(event => event.type === "response.output_item.done");
      completed.forEach(event => expect(decodeReasoningEnvelope(String(event.item.encrypted_content))?.ap).toBeUndefined());
      const reasoningBytes = (calls: Array<[number, { kind: string }]>) => calls
        .filter(([, scope]) => scope.kind === "reasoning").reduce((sum, [bytes]) => sum + bytes, 0);
      expect(reasoningBytes(charged.mock.calls)).toBeGreaterThan(0);
      expect(reasoningBytes(released.mock.calls)).toBe(reasoningBytes(charged.mock.calls));
      expect(budget.snapshot().activeCalls).toBe(0);
    } finally { charged.mockRestore(); released.mockRestore(); budget.dispose(); }
  });

  test("failed admission of pending redacted bytes never releases unrelated retained ownership", async () => {
    const payload = "SyntheticAdmissionDeniedRedacted";
    const budget = createTranslatorBudget();
    budget.chargeRetained(123, { kind: "reasoning" });
    const wrapped = new Proxy(budget, {
      get(target, property) {
        if (property === "chargeRetained") return (bytes: number, scope: Parameters<TranslatorBudget["chargeRetained"]>[1]) => {
          if (bytes === Buffer.byteLength(payload)) throw new Error("synthetic pending admission denial");
          target.chargeRetained(bytes, scope);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const provider = config().providers["anthropic-test"]!;
    const parsed = parseRequest({ model: MODEL, reasoning: { effort: "high" }, input: [user("First question")] });
    parsed._reasoningReplayScope = { clientThreadId: "admission-denial-fixture" };
    bindRouteReasoningReplayScope({ parsed, provider, providerName: "anthropic-test", adapterName: "anthropic" });
    const adapter = createAnthropicAdapter(provider);
    const bodies = transport(() => { throw new Error("Unexpected dispatch after local admission denial"); });
    try {
      const built = await adapter.buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
      const response = new Response([
        frame("message_start", { message: { content: [] } }),
        frame("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: payload } }),
      ].join(""), { headers: { "content-type": "text/event-stream" } });
      bindAnthropicPrefixResponse(built, response);
      const consume = async () => { for await (const event of adapter.parseStream(response, wrapped)) void event; };
      await expect(consume()).rejects.toThrow("synthetic pending admission denial");
      expect(budget.snapshot().currentBytes).toBe(123);
      expect(bodies).toHaveLength(0);
      budget.releaseRetained(123, { kind: "reasoning" });
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { budget.dispose(); }
  });

  test("canceling a recovered turn after a completed observed block does not memoize omission", async () => {
    const abort = new AbortController();
    const bodies = transport((index, stream) => {
      if (index === 2) return Response.json({ type: "error", error: { type: "invalid_request_error", message: REJECTION } }, { status: 400 });
      if (index === 3) return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([...signedFrames(SECOND_SIGNATURE),
            frame("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
            frame("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Unfinished answer" } }),
          ].join("")));
        },
      }), { headers: { "content-type": "text/event-stream" } });
      return upstream(SIGNATURE, false, stream);
    });
    const first = await send([user("First question")], true);
    const history = [user("First question"), ...first.output, user("Second question")];
    const response = await handleResponses(request(history, true), config(), { model: "", provider: "" }, { abortSignal: abort.signal });
    const reader = response.body!.getReader();
    let wire = "";
    try {
      while (!wire.includes('"type":"response.output_item.done"')) {
        const part = await reader.read();
        if (part.done) break;
        wire += new TextDecoder().decode(part.value);
      }
      const itemDone = wire.split("\n").filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice(6))).find(event => event.type === "response.output_item.done");
      expectHint([itemDone.item], SECOND_SIGNATURE);
    } finally {
      abort.abort();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toContain(SIGNATURE);
    await send(history, true);
    expect(bodies).toHaveLength(4);
    expect(bodies[3]).toContain(SIGNATURE);
  });

  for (const stream of [false, true]) for (const kind of ["thinking", "redacted"] as const) {
    test(`rejection memo cannot be escaped with forged matching hints and changed plaintext (${kind}, stream=${stream})`, async () => {
      const fixture = await recoveredMemoScenario(stream, kind);
      const observed = envelope(fixture.recovered.output);
      const changedThinking = "Altered thinking with the same rejected signature";
      const block = kind === "thinking"
        ? { type: "thinking", thinking: changedThinking, signature: fixture.oldPayload }
        : { type: "redacted_thinking", data: fixture.oldPayload };
      // The fabricated consistency hint matches this new position and payload. Only the opaque
      // fingerprint can identify the rejected signature independently of changed plaintext/ap.
      const forged: ReasoningEnvelope = { ...observed,
        ...(kind === "thinking" ? { sig: fixture.oldPayload, txt: changedThinking } : { red: [fixture.oldPayload] }),
        ap: { ...observed.ap!, block: anthropicPrefixDigest(block) } };
      const replay = fixture.recovered.output.map(item => item.type === "reasoning"
        ? { ...item, encrypted_content: encodeReasoningEnvelope(forged) } : item);
      const nextInput = [...fixture.history, ...replay, user("Third question")];
      const next = await send(nextInput, stream);
      expect(next.response.status).toBe(200);
      expect(fixture.bodies).toHaveLength(4);
      expect(fixture.bodies[3]).not.toContain(fixture.oldPayload);
      expect(fixture.bodies[3]).not.toContain(changedThinking);
      expect(next.log.activeAttempt?.sendCount).toBe(1);
      // Control: no cache entry means the consistency-only hint itself compares successfully.
      clearReasoningReplayCacheForTests();
      await send(nextInput, stream);
      expect(fixture.bodies).toHaveLength(5);
      expect(fixture.bodies[4]).toContain(fixture.oldPayload);
      if (kind === "thinking") expect(fixture.bodies[4]).toContain(changedThinking);
    });

    for (const variant of ["legacy", "unknown-version", "unknown-scope", "malformed-hint"] as const) {
      test(`rejection memo strips new ${variant} payloads (${kind}, stream=${stream})`, async () => {
        const fixture = await recoveredMemoScenario(stream, kind);
        const observed = envelope(fixture.recovered.output);
        const changed: Record<string, unknown> = { ...observed };
        if (variant === "legacy") delete changed.ap;
        else changed.ap = { ...observed.ap, ...(variant === "unknown-version" ? { v: 2 }
          : variant === "unknown-scope" ? { scope: "0".repeat(64) } : { block: "malformed" }) };
        const replay = fixture.recovered.output.map(item => item.type === "reasoning"
          ? { ...item, encrypted_content: encodeReasoningEnvelope(changed as ReasoningEnvelope) } : item);
        const next = await send([...fixture.history, ...replay, user("Third question")], stream);
        expect(next.response.status).toBe(200);
        expect(fixture.bodies).toHaveLength(4);
        expect(fixture.bodies[3]).not.toContain(fixture.oldPayload);
        expect(fixture.bodies[3]).not.toContain(fixture.newPayload);
        expect(next.log.activeAttempt?.recoveryKinds ?? []).toEqual([]);
      });
    }

    for (const refusal of stream ? ["http", "sse"] as const : ["http"] as const) {
      test(`memo-hit ${refusal} refusal is terminal for a new valid payload (${kind}, stream=${stream})`, async () => {
        const fixture = await recoveredMemoScenario(stream, kind, refusal);
        const nextInput = [...fixture.history, ...fixture.recovered.output, user("Third question")];
        const refused = await send(nextInput, stream);
        expect(refused.text).toContain(REJECTION);
        if (refusal === "sse") expect(refused.text).toContain("response.failed");
        else expect(refused.response.status).toBe(400);
        expect(fixture.bodies).toHaveLength(4);
        expect(fixture.bodies[3]).not.toContain(fixture.oldPayload);
        expect(fixture.bodies[3]).toContain(fixture.newPayload);
        expect(refused.log.activeAttempt?.sendCount).toBe(1);
        expect(refused.log.activeAttempt?.recoveryKinds ?? []).toEqual([]);
        await send(nextInput, stream);
        expect(fixture.bodies).toHaveLength(5);
        expect(fixture.bodies[4]).toContain(fixture.newPayload);
      });
    }
  }

  for (const stream of [false, true]) {
    test(`successful recovery memo keeps a new valid redacted payload and rejects the old one (stream=${stream})`, async () => {
      const fixture = await recoveredMemoScenario(stream, "redacted");
      const next = await send([...fixture.history, ...fixture.recovered.output, user("Third question")], stream);
      expect(next.response.status).toBe(200);
      expect(fixture.bodies).toHaveLength(4);
      expect(fixture.bodies[3]).not.toContain(fixture.oldPayload);
      expect(fixture.bodies[3]).toContain(fixture.newPayload);
      expectAdaptive(fixture.bodies[3]!);
    });

    test(`failed redacted recovery observation does not install a selective memo (stream=${stream})`, async () => {
      const oldPayload = "synthetic-failed-recovery-old-redacted";
      const newPayload = "synthetic-failed-recovery-new-redacted";
      const bodies = transport((index, upstreamStream) => {
        if (index === 2) return bindingRejection();
        if (index === 3 && !upstreamStream) return Response.json({ content: [{ type: "redacted_thinking", data: newPayload }], stop_reason: "error" });
        if (index === 3) return new Response([
          frame("message_start", { message: { content: [] } }),
          frame("content_block_start", { index: 0, content_block: { type: "redacted_thinking", data: newPayload } }),
          frame("content_block_stop", { index: 0 }),
          frame("error", { error: { type: "invalid_request_error", message: REJECTION } }),
        ].join(""), { headers: { "content-type": "text/event-stream" } });
        return upstreamBlocks(memoBlocks("redacted", oldPayload), upstreamStream);
      });
      const first = await send([user("First question")], stream);
      const history = [user("First question"), ...first.output, user("Second question")];
      const failed = await send(history, stream);
      expect(envelope(failed.output).red).toEqual([newPayload]);
      expect(envelope(failed.output).ap).toBeDefined();
      if (stream) expect(failed.text).toContain("response.failed");
      else expect(failed.json.status).toBe("failed");
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).not.toContain(oldPayload);
      await send(history, stream);
      expect(bodies).toHaveLength(4);
      expect(bodies[3]).toContain(oldPayload);
    });
  }

  for (const variant of ["legacy", "unknown-version", "malformed-hint"] as const) {
    test(`${variant} envelopes retain provider signatures for compatibility`, async () => {
      const bodies = transport((_index, upstreamStream) => upstream(SIGNATURE, false, upstreamStream));
      const first = await send([user("First question")]);
      const observed = envelope(first.output);
      expect(observed.ap).toBeDefined();
      const raw: Record<string, unknown> = { ...observed };
      if (variant === "legacy") delete raw.ap;
      else raw.ap = { ...observed.ap, ...(variant === "unknown-version" ? { v: 2 } : { prefix: "invalid" }) };
      const altered = first.output.map(item => item.type === "reasoning"
        ? { ...item, encrypted_content: encodeReasoningEnvelope(raw as ReasoningEnvelope) } : item);
      await send([user("Changed prefix with unknown history"), ...altered, user("Next question")]);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain(SIGNATURE);
    });
  }

  for (const dimension of ["credential", "destination", "model"] as const) {
    test(`unknown ${dimension} scope is not proof of invalid thinking`, async () => {
      const bodies = transport((_index, upstreamStream) => upstream(SIGNATURE, false, upstreamStream));
      const first = await send([user("First question")]);
      expectHint(first.output);
      // A restarted process has no separate serving-provenance record to authorize removal.
      clearReasoningReplayCacheForTests();
      resetThoughtSignatureReplayForTests();
      const cfg = config();
      const overrides: Item = {};
      if (dimension === "credential") cfg.providers["anthropic-test"]!.apiKey = "synthetic-other-test-key";
      if (dimension === "destination") cfg.providers["anthropic-test"]!.baseUrl = "https://other-anthropic.example.test";
      if (dimension === "model") overrides.model = "anthropic-test/claude-sonnet-4-5";
      const result = await send([user("Different prefix under unknown scope"), ...first.output, user("Next question")], false, overrides, cfg);
      expect(result.response.status).toBe(200);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain(SIGNATURE);
    });
  }
});

test.each(["none", "high"])("actual scoped adapter preserves a large accepted text request with reasoning %s", async effort => {
  const provider = config().providers["anthropic-test"]!;
  const text = "Synthetic large input. ".repeat(450_000);
  const parsed = parseRequest({ model: MODEL, reasoning: { effort }, input: [user(text)] });
  parsed._reasoningReplayScope = { clientThreadId: "large-prefix-budget-fixture" };
  bindRouteReasoningReplayScope({ parsed, provider, providerName: "anthropic-test", adapterName: "anthropic" });
  expect(parsed._reasoningReplayScope.current?.providerDestinationDurableIdentity).toBeTruthy();
  expect(parsed._reasoningReplayScope.current?.credentialDurableIdentity).toBeTruthy();
  const budget = createTranslatorBudget();
  try {
    const built = await createAnthropicAdapter(provider).buildRequest(parsed, { headers: new Headers(), translatorBudget: budget });
    const body = typeof built.body === "string" ? JSON.parse(built.body) : built.body;
    expect(JSON.stringify(body.messages)).toContain(text);
    if (effort === "high") expect(budget.snapshot().highWaterBytes).toBeGreaterThan(0);
    expect(budget.snapshot().overflows).toBe(0);
    built.releaseBodyObservation?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  } finally { budget.dispose(); }
});
