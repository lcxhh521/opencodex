import { test, expect } from "bun:test";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import {
  enableAnthropicReplayCapture, createAnthropicReplayCapture, takeAnthropicReplay,
  bindAnthropicReplay, anthropicReplayContent,
} from "../../../src/adapters/anthropic-replay";

function start(limit = 100_000) {
  const response = new Response();
  const budget = createTranslatorBudget({ maxTurnBytes: limit });
  const cleanup = enableAnthropicReplayCapture(response);
  const capture = createAnthropicReplayCapture(response, budget)!;
  capture.accept({ type: "message_start" });
  capture.accept({ type: "content_block_start", index: 0, content_block: { type: "text", text: "initial" } });
  return { budget, capture, cleanup };
}
function complete(capture: ReturnType<typeof start>["capture"]) {
  capture.accept({ type: "content_block_stop", index: 0 });
  capture.accept({ type: "message_stop" });
  const done = { type: "done" } as const;
  capture.finish(done);
  return done;
}

test("capture cancellation releases retained bytes idempotently", () => {
  const { budget, capture, cleanup } = start();
  expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
  capture.discard(); cleanup(); capture.discard();
  expect(budget.snapshot().currentBytes).toBe(0);
});
test("invalid index releases bytes and cannot issue a snapshot", () => {
  const { budget, capture, cleanup } = start();
  capture.accept({ type: "content_block_stop", index: 9 });
  expect(takeAnthropicReplay(complete(capture))).toBeUndefined();
  cleanup();
  expect(budget.snapshot().currentBytes).toBe(0);
});
test("response cleanup releases an unclaimed complete snapshot", () => {
  const { budget, capture, cleanup } = start();
  complete(capture); capture.discard();
  expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
  cleanup();
  expect(budget.snapshot().currentBytes).toBe(0);
});
test("claim transfers ownership until release; external and expired snapshots are refused", () => {
  const { budget, capture, cleanup } = start();
  const snapshot = takeAnthropicReplay(complete(capture))!;
  const message = { role: "assistant", content: [], timestamp: 0 } as const;
  const mutableMessage = { ...message, content: [] };
  bindAnthropicReplay(mutableMessage, snapshot);
  expect(anthropicReplayContent(mutableMessage)).toEqual([{ type: "text", text: "initial" }]);
  expect(() => bindAnthropicReplay(mutableMessage, { content: [], release() {} })).toThrow();
  cleanup(); capture.discard();
  expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
  snapshot.release(); snapshot.release();
  expect(budget.snapshot().currentBytes).toBe(0);
  expect(() => bindAnthropicReplay(mutableMessage, snapshot)).toThrow();
  expect(() => anthropicReplayContent(mutableMessage)).toThrow();
});
test("budget overflow releases previously retained frames on discard", () => {
  const { budget, capture, cleanup } = start(1_000);
  expect(() => capture.accept({ type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text: "x".repeat(2_000) } })).toThrow();
  capture.discard(); cleanup();
  expect(budget.snapshot().currentBytes).toBe(0);
});
