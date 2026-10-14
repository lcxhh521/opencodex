import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpStatusFromTerminalError } from "../../src/lib/errors";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { markResponseNonReplayable, SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import { encodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import * as thoughtSignatureReplay from "../../src/responses/thought-signature-replay";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
const SIGNATURE = "SyntheticSignature123456==";
const REDACTED = "synthetic-redacted-thinking";
const REJECTION = "Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the thinking block and retry.";
let testDir = "";
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-anthropic-thinking-recovery-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  resetWorkflowBudgetsForTest();
});

afterEach(() => {
  try { releaseSpendHome?.(); } finally {
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
    clearReasoningReplayCacheForTests();
    resetThoughtSignatureReplayForTests();
    resetWorkflowBudgetsForTest();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(testDir);
  }
});

function config(): OcxConfig {
  return {
    defaultProvider: "anthropic-test",
    emptyCompletionRetry: false,
    providers: {
      "anthropic-test": {
        adapter: "anthropic",
        baseUrl: "https://anthropic.example.test",
        authMode: "key",
        apiKey: "synthetic-test-key",
        // The mock is the entire transport; inherited SOCKS settings must not bypass it.
        proxy: "direct",
        models: ["claude-sonnet-4-5"],
      },
    },
  } as OcxConfig;
}

function request(stream: boolean, threadId = "thinking-recovery-thread", signed = true): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-parent-thread-id": threadId },
    body: JSON.stringify({
      model: "anthropic-test/claude-sonnet-4-5", stream, store: false,
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "earlier question" }] },
        ...(signed ? [{ type: "reasoning", summary: [{ type: "summary_text", text: "earlier reasoning" }],
          encrypted_content: encodeReasoningEnvelope({ sig: SIGNATURE, red: [REDACTED] }) }] : []),
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next question" }] },
      ],
    }),
  });
}

function frame(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function sse(...frames: string[]): Response {
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

function rejection(status = 400, message = REJECTION): Response {
  return Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status });
}

function streamRejection(...prefix: string[]): Response {
  return sse(...prefix, frame("error", { error: { type: "invalid_request_error", message: REJECTION } }));
}

function textFrame(text: string): string {
  return frame("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
}

function success(stream: boolean, text = "Recovered answer"): Response {
  if (stream) return sse(
    frame("message_start", { message: { usage: { input_tokens: 2 } } }),
    ...(text ? [textFrame(text)] : []),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
    frame("message_stop"),
  );
  return Response.json({
    id: "msg-recovered", type: "message", role: "assistant", model: "claude-sonnet-4-5",
    content: text ? [{ type: "text", text }] : [], stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 3 },
  });
}

function fakeUpstream(answer: (index: number) => Response | Promise<Response>): string[] {
  const bodies: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return answer(bodies.length);
  }) as typeof fetch;
  return bodies;
}

async function send(stream: boolean, threadId?: string, options: Parameters<typeof handleResponses>[3] = {}) {
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(request(stream, threadId), config(), log, options);
  const text = await response.text();
  return { response, text, log };
}

function expectStrippedRetry(bodies: string[]): void {
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toContain(SIGNATURE);
  expect(bodies[0]).toContain(REDACTED);
  expect(bodies[1]).not.toContain(SIGNATURE);
  expect(bodies[1]).not.toContain(REDACTED);
  expect(bodies[1]).not.toContain('"type":"thinking"');
  expect(bodies[1]).toContain("earlier answer");
  expect(bodies[1]).toContain("next question");
}

function streamedFailure(text: string): {
  error: { type: string; code: string; message: string };
  retryable?: boolean;
} {
  const event = text.split("\n").filter(line => line.startsWith("data: {") && line.includes('"type":"response.failed"'))
    .map(line => JSON.parse(line.slice(6)))[0];
  expect(event?.response?.status).toBe("failed");
  return event.response;
}

describe("Anthropic thinking-signature recovery through Responses dispatch", () => {
  for (const stream of [false, true]) {
    test(`HTTP 400 rebuilds once and memoizes only completed output (stream=${stream})`, async () => {
      const bodies = fakeUpstream(index => index === 1 ? rejection() : success(stream));
      const result = await send(stream);
      expect(result.response.status).toBe(200);
      expect(result.text).toContain("Recovered answer");
      expectStrippedRetry(bodies);
      expect(result.log.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
      expect(result.log.activeAttempt?.sendCount).toBe(2);
      await send(stream);
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).not.toContain(SIGNATURE);
      await send(stream, "another-thinking-thread");
      expect(bodies[3]).toContain(SIGNATURE);
    });

    test(`failed and empty stripped retries do not poison later replay (stream=${stream})`, async () => {
      for (const retry of ["http-error", "empty", "adapter-error"] as const) {
        clearReasoningReplayCacheForTests();
        const bodies = fakeUpstream(index => index === 1 ? rejection() : index === 2
          ? retry === "http-error" ? rejection(400, "Unrelated bad request")
            : retry === "empty" ? success(stream, "")
              : stream ? streamRejection() : Response.json({ content: [], stop_reason: "error" })
          : success(stream));
        await send(stream);
        expectStrippedRetry(bodies);
        await send(stream);
        expect(bodies).toHaveLength(3);
        expect(bodies[2]).toContain(SIGNATURE);
      }
    });
  }

  test("initial HTTP 200 signature error after harmless pings replaces the stream once", async () => {
    const bodies = fakeUpstream(index => index === 1
      ? streamRejection(": keepalive\n\n", frame("ping")) : success(true));
    const result = await send(true);
    expect(result.text).toContain("Recovered answer");
    expect(result.text).toContain("response.completed");
    expect(result.text).not.toContain("response.failed");
    expect(result.text).not.toContain(REJECTION);
    expectStrippedRetry(bodies);
    await send(true);
    expect(bodies[2]).not.toContain(SIGNATURE);
  });

  test("HTTP rejection and its replacement stream share a single recovery allowance", async () => {
    const bodies = fakeUpstream(index => index === 1 ? rejection() : streamRejection());
    const result = await send(true);
    expectStrippedRetry(bodies);
    expect(result.text).toContain("response.failed");
    expect(result.text).toContain(REJECTION);
  });

  test("a second stream rejection is terminal and is not memoized", async () => {
    const bodies = fakeUpstream(index => index < 3 ? streamRejection() : success(true));
    const result = await send(true);
    expectStrippedRetry(bodies);
    expect(result.text).toContain("response.failed");
    await send(true);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain(SIGNATURE);
  });

  test("a non-OK replacement is delivered as an error rather than parsed as SSE", async () => {
    const bodies = fakeUpstream(index => index === 1 ? streamRejection() : index === 2
      ? rejection(400, "Synthetic replacement refusal") : success(true));
    const result = await send(true);
    expectStrippedRetry(bodies);
    expect(result.text).toContain("Synthetic replacement refusal");
    expect(result.text).toContain("response.failed");
    expect(result.text).not.toContain("possible truncation");
    await send(true);
    expect(bodies[2]).toContain(SIGNATURE);
  });

  test("a marked non-replayable replacement withholds diagnostics and preserves its terminal identity", async () => {
    const diagnostic = "synthetic-private-upstream-diagnostic";
    const bodies = fakeUpstream(index => {
      if (index === 1) return streamRejection();
      if (index !== 2) return success(true);
      const response = Response.json({ error: {
        type: "invalid_request_error", code: "context_length_exceeded", message: diagnostic,
      } }, { status: 400 });
      markResponseNonReplayable(response);
      return response;
    });
    const result = await send(true);
    expectStrippedRetry(bodies);
    expect(result.text).not.toContain(diagnostic);
    const failure = streamedFailure(result.text);
    expect(failure.error).toEqual({
      type: "invalid_request_error", code: "context_length_exceeded",
      message: "Provider error 400: upstream diagnostic withheld for a non-replayable failure",
    });
    expect(failure.retryable).toBe(false);
    expect(httpStatusFromTerminalError(failure.error)).toBe(400);
    await send(true);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain(SIGNATURE);
  });

  test("a local send-budget refusal retains 429 identity after refetch aborts its upstream signal", async () => {
    const bodies = fakeUpstream(index => {
      if (index === 1) return streamRejection();
      if (index === 2) throw new SendBudgetExhaustedError("synthetic-upstream");
      return success(true);
    });
    const result = await send(true);
    expectStrippedRetry(bodies);
    const failure = streamedFailure(result.text);
    expect(failure.error.type).toBe("rate_limit_error");
    expect(failure.error.code).toBe("request_send_budget_exhausted");
    expect(failure.error.message).toContain("request send budget exhausted before dispatch");
    expect(httpStatusFromTerminalError(failure.error)).toBe(429);
    expect(result.text).not.toContain("Upstream recovery failed");
    expect(result.text).not.toContain("Provider unreachable");
    await send(true);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain(SIGNATURE);
  });

  test("empty, truncated, and incomplete stream retries never memoize rejection", async () => {
    for (const retry of ["empty", "truncated", "incomplete"] as const) {
      clearReasoningReplayCacheForTests();
      const bodies = fakeUpstream(index => index === 1 ? streamRejection() : index === 2
        ? retry === "empty" ? success(true, "") : retry === "truncated" ? sse(textFrame("Partial answer"))
          : sse(textFrame("Partial answer"), frame("message_delta", { delta: { stop_reason: "max_tokens" } }), frame("message_stop"))
        : success(true));
      const result = await send(true);
      expectStrippedRetry(bodies);
      if (retry !== "empty") expect(result.text).not.toContain("event: response.completed");
      await send(true);
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).toContain(SIGNATURE);
    }
  });

  for (const initialStreamError of [false, true]) {
    test(`the shared send budget can deny recovery (initialStreamError=${initialStreamError})`, async () => {
      const bodies = fakeUpstream(index => index === 1
        ? initialStreamError ? streamRejection() : rejection() : success(initialStreamError));
      const budget = createRequestExecutionBudget({
        maxTotalModelSends: 0, baseSendAllowance: 0, finalRecoveryAllowance: 0,
        maxAlternateTargetSends: 0, maxTargetTransitions: 0,
      }, "thinking-recovery-budget-refused");
      await send(initialStreamError, undefined, { sendBudget: budget });
      expect(bodies).toHaveLength(1);
      expect(budget.used).toBe(0);
      await send(initialStreamError);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toContain(SIGNATURE);
    });
  }

  test("concurrent requests each get one recovery and retain separate conversation memos", async () => {
    let releaseInitial!: () => void;
    const initialBarrier = new Promise<void>(resolve => { releaseInitial = resolve; });
    const bodies = fakeUpstream(async index => {
      if (index <= 2) {
        if (index === 2) releaseInitial();
        await initialBarrier;
        return rejection();
      }
      return success(false);
    });
    const results = await Promise.all([send(false, "parallel-thinking-a"), send(false, "parallel-thinking-b")]);
    expect(results.every(result => result.response.status === 200 && result.text.includes("Recovered answer"))).toBe(true);
    expect(bodies).toHaveLength(4);
    expect(bodies.slice(0, 2).every(body => body.includes(SIGNATURE))).toBe(true);
    expect(bodies.slice(2).every(body => !body.includes(SIGNATURE))).toBe(true);
    await send(false, "parallel-thinking-a");
    await send(false, "parallel-thinking-b");
    expect(bodies).toHaveLength(6);
    expect(bodies.slice(4).every(body => !body.includes(SIGNATURE))).toBe(true);
  });

  for (const prefix of [
    { name: "visible text", frame: textFrame("Already visible") },
    { name: "thinking output", frame: frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }) },
    { name: "tool call", frame: frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "call-synthetic", name: "lookup" } }) },
  ]) {
    test(`does not resend after ${prefix.name}`, async () => {
      const bodies = fakeUpstream(() => streamRejection(prefix.frame));
      const result = await send(true);
      expect(bodies).toHaveLength(1);
      expect(result.text).toContain("response.failed");
      expect(result.text).toContain(REJECTION);
    });
  }

  test("unrelated wording and missing replayed thinking never gain a resend", async () => {
    for (const message of ["Invalid `signature` in `thinking` block", "The block is bound to a different conversation", "Invalid API key"]) {
      const bodies = fakeUpstream(() => rejection(400, message));
      const result = await send(false);
      expect(result.response.status).toBe(400);
      expect(bodies).toHaveLength(1);
    }
    const bodies = fakeUpstream(() => rejection());
    const result = await handleResponses(request(false, "unsigned-thread", false), config(), { model: "", provider: "" });
    await result.text();
    expect(result.status).toBe(400);
    expect(bodies).toHaveLength(1);
  });

  test("reasoning that Anthropic never serialized cannot gain an identical resend", async () => {
    for (const stream of [false, true]) {
      for (const encrypted of [undefined, "native-provider-opaque-blob",
        encodeReasoningEnvelope({ sig: "short" }),
        encodeReasoningEnvelope({ sig: "call_not_a_real_signature" })]) {
        const bodies = fakeUpstream(() => stream ? streamRejection() : rejection());
        const base = request(stream);
        const body = await base.json() as { input: Record<string, unknown>[] };
        body.input[1] = {
          type: "reasoning", summary: [{ type: "summary_text", text: "unsigned reasoning" }],
          ...(encrypted ? { encrypted_content: encrypted } : {}),
        };
        const response = await handleResponses(new Request(base.url, {
          method: "POST", headers: base.headers, body: JSON.stringify(body),
        }), config(), { model: "", provider: "" });
        const text = await response.text();
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).not.toContain('"type":"thinking"');
        expect(bodies[0]).not.toContain('"type":"redacted_thinking"');
        expect(text).toContain(REJECTION);
      }
    }
  });

  test("non-replayable HTTP responses stay terminal", async () => {
    const bodies = fakeUpstream(() => {
      const response = rejection();
      markResponseNonReplayable(response);
      return response;
    });
    const result = await send(false);
    expect(result.response.status).toBe(400);
    expect(bodies).toHaveLength(1);
  });

  test("cancellation before recovery prevents a second send and leaves replay available", async () => {
    const abort = new AbortController();
    const bodies = fakeUpstream(index => {
      if (index === 1) { abort.abort(); return rejection(); }
      return success(false);
    });
    await send(false, undefined, { abortSignal: abort.signal });
    expect(bodies).toHaveLength(1);
    await send(false);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain(SIGNATURE);
  });

  test("cancellation after recovery dispatch cannot memoize an unread HTTP 200", async () => {
    const abort = new AbortController();
    const bodies = fakeUpstream(index => {
      if (index === 1) return streamRejection();
      if (index === 2) abort.abort();
      return success(true);
    });
    const response = await handleResponses(request(true), config(), { model: "", provider: "" }, { abortSignal: abort.signal });
    try { await response.text(); } catch { /* client cancellation can reject its stream reader */ }
    expectStrippedRetry(bodies);
    await send(true);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain(SIGNATURE);
  });

  test("caller cancellation during buffered durability wait cannot memoize completed recovery", async () => {
    const abort = new AbortController();
    const bodies = fakeUpstream(index => index === 1 ? rejection() : success(false));
    const durability = spyOn(thoughtSignatureReplay, "awaitThoughtSignatureDurability").mockImplementation(async () => {
      abort.abort();
    });
    try {
      await send(false, undefined, { abortSignal: abort.signal });
      expect(durability).toHaveBeenCalledTimes(1);
      expect(abort.signal.aborted).toBe(true);
      expectStrippedRetry(bodies);
    } finally {
      durability.mockRestore();
    }
    await send(false);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain(SIGNATURE);
  });
});
