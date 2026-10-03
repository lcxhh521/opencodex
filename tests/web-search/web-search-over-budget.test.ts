import { afterEach, describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { runWithWebSearch } from "../../src/web-search/loop";
import { runTurnWebSearchLoop } from "../../src/web-search/run-turn-loop";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { SidecarPlan } from "../../src/web-search";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

/**
 * #6464 keeps web_search declared on the forced-answer pass, so that pass can loop: a call past the
 * per-turn budget is answered with the limit-reached tool result instead of a real search. These
 * tests pin the bounds that change makes load-bearing, for both loops:
 *  - physical searches never exceed maxSearches, however often the model asks;
 *  - a model that keeps asking stops at the hard cap (maxSearches + 3 model passes) with an explicit
 *    error, not a stream that just ends;
 *  - a caller tool and a cancellation still end the forced pass at once.
 */

const CAP_MESSAGE = "web search stopped at its iteration cap";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const searchCall = (id: string, query: string): AdapterEvent[] => [
  { type: "tool_call_start", id, name: "web_search" },
  { type: "tool_call_delta", arguments: JSON.stringify({ query }) },
  { type: "tool_call_end" },
];
const shellCall: AdapterEvent[] = [
  { type: "tool_call_start", id: "shell_1", name: "shell" },
  { type: "tool_call_delta", arguments: "{\"cmd\":\"ls\"}" },
  { type: "tool_call_end" },
];
const done: AdapterEvent = { type: "done" };

describe("runTurn loop past the search budget", () => {
  const parsed: OcxParsedRequest = {
    modelId: "fixture", stream: true, options: {}, context: { messages: [], tools: [] },
  };
  const plan = (maxSearches: number): SidecarPlan => ({
    backend: "exa", hostedTool: { type: "web_search" }, maxSearches,
    settings: { model: "fixture", reasoning: "low", timeoutMs: 1000 },
    routedModelStallTimeoutMs: 1000, stallTimeoutSec: 1, streamRoutedModelOutput: false,
  });
  async function* stream(events: AdapterEvent[]) { yield* events; }
  async function collect(source: AsyncIterable<AdapterEvent>) {
    const out: AdapterEvent[] = [];
    for await (const event of source) out.push(event);
    return out.filter(event => event.type !== "heartbeat");
  }
  /** Exa answers every real search with one distinct result; returns the physical call count. */
  function countExaSearches(): { count: () => number } {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ results: [{ url: `https://example.test/${calls}`, title: `result ${calls}`, text: "evidence" }] });
    }) as unknown as typeof fetch;
    return { count: () => calls };
  }

  test("a model that keeps calling web_search gets maxSearches real searches and stops at the hard cap", async () => {
    const exa = countExaSearches();
    const maxSearches = 2;
    let dispatches = 0;
    const out = await collect(runTurnWebSearchLoop(stream([...searchCall("s0", "q0"), done]), {
      parsed, plan: plan(maxSearches), exaApiKey: "fixture",
      dispatch: () => {
        dispatches++;
        return stream([...searchCall(`s${dispatches}`, `q${dispatches}`), done]);
      },
    }));
    expect(exa.count()).toBe(maxSearches);
    // The first pass comes from the initial stream; every later pass is a dispatch.
    expect(dispatches + 1).toBe(maxSearches + 3);
    expect(out.at(-1)).toMatchObject({ type: "error" });
    expect(String((out.at(-1) as { message?: string }).message)).toContain(CAP_MESSAGE);
    expect(out.some(event => event.type === "done")).toBe(false);
  });

  test("a caller tool on the forced pass ends the turn without another dispatch or search", async () => {
    const exa = countExaSearches();
    let dispatches = 0;
    const out = await collect(runTurnWebSearchLoop(stream([...searchCall("s0", "q0"), done]), {
      parsed, plan: plan(1), exaApiKey: "fixture",
      dispatch: () => {
        dispatches++;
        // Forced pass: one more web_search next to a caller tool. The caller tool makes it terminal.
        return stream([...searchCall("s1", "q1"), ...shellCall, done]);
      },
    }));
    expect(dispatches).toBe(1);
    expect(exa.count()).toBe(1);
    expect(out.some(event => event.type === "tool_call_start" && event.name === "shell")).toBe(true);
    expect(out.at(-1)).toEqual(done);
  });

  test("cancellation during the forced pass stops the loop at once", async () => {
    const exa = countExaSearches();
    const controller = new AbortController();
    let dispatches = 0;
    const out = await collect(runTurnWebSearchLoop(stream([...searchCall("s0", "q0"), done]), {
      parsed, plan: plan(1), exaApiKey: "fixture", abortSignal: controller.signal,
      dispatch: () => {
        dispatches++;
        controller.abort();
        return stream([...searchCall("s1", "q1"), done]);
      },
    }));
    expect(dispatches).toBe(1);
    expect(exa.count()).toBe(1);
    expect(out.at(-1)).toMatchObject({ type: "error", message: "client closed request during web-search" });
  });
});

describe("Responses loop past the search budget", () => {
  const forwardProvider: OcxProviderConfig = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.test/v1",
    authMode: "forward",
  };
  /** The forward sidecar answers every real search with a short completed stream. */
  function countSidecarSearches(): { count: () => number } {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: `evidence ${calls}` })}\n\n`
        + "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    return { count: () => calls };
  }
  /** Model passes come from `pass(i)`; every request the loop builds is recorded in `seen`. */
  function adapter(pass: (index: number) => AdapterEvent[], seen: OcxParsedRequest[], onPass?: (index: number) => void): ProviderAdapter {
    let index = 0;
    return {
      name: "over-budget",
      buildRequest: request => {
        seen.push(request);
        return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        const current = index++;
        onPass?.(current);
        for (const event of pass(current)) yield event;
      },
      async parseResponse() {
        throw new Error("parseResponse must be unreachable");
      },
    };
  }
  async function frames(response: Response): Promise<{ event?: string; data: Record<string, unknown> }[]> {
    const text = await response.text();
    return text.split("\n\n")
      .map(frame => frame.trim())
      .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
      .map(frame => {
        const lines = frame.split("\n");
        const event = lines.find(line => line.startsWith("event: "))?.slice(7);
        const dataLine = lines.find(line => line.startsWith("data: "));
        return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
      });
  }
  function run(adapterImpl: ProviderAdapter, maxSearches: number, abortSignal?: AbortSignal): Promise<Response> {
    const parsed = parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] });
    // Production injects the synthetic declaration before the loop (sidecar-execution.ts).
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    return runWithWebSearch({
      parsed,
      adapter: adapterImpl,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 30_000 },
      maxSearches,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      ...(abortSignal ? { abortSignal } : {}),
    });
  }

  test("a model that keeps calling web_search gets maxSearches real searches and stops at the hard cap", async () => {
    const sidecar = countSidecarSearches();
    const seen: OcxParsedRequest[] = [];
    const maxSearches = 2;
    const out = await frames(await run(adapter(index => [...searchCall(`s${index}`, `q${index}`), done], seen), maxSearches));
    expect(sidecar.count()).toBe(maxSearches);
    expect(seen).toHaveLength(maxSearches + 3);
    // Every pass, including those past the budget, keeps the declaration (#6464).
    expect(seen.every(request => request.context.tools.some(tool => tool.webSearch))).toBe(true);
    const failed = out.find(frame => frame.event === "response.failed");
    expect(JSON.stringify(failed?.data)).toContain(CAP_MESSAGE);
    expect(out.some(frame => frame.event === "response.completed")).toBe(false);
    expect(out.some(frame => frame.event === "response.incomplete")).toBe(false);
  });

  test("a caller tool on the forced pass ends the turn without another pass or search", async () => {
    const sidecar = countSidecarSearches();
    const seen: OcxParsedRequest[] = [];
    const out = await frames(await run(adapter(index => index === 0
      ? [...searchCall("s0", "q0"), done]
      : [...searchCall("s1", "q1"), ...shellCall, done], seen), 1));
    expect(seen).toHaveLength(2);
    expect(sidecar.count()).toBe(1);
    expect(out.some(frame => frame.event === "response.completed")).toBe(true);
    expect(out.some(frame => frame.event === "response.failed")).toBe(false);
  });

  test("cancellation during the forced pass stops the loop at once", async () => {
    const sidecar = countSidecarSearches();
    const seen: OcxParsedRequest[] = [];
    const controller = new AbortController();
    const out = await frames(await run(adapter(
      index => [...searchCall(`s${index}`, `q${index}`), done],
      seen,
      index => { if (index === 1) controller.abort(); },
    ), 1, controller.signal));
    expect(seen).toHaveLength(2);
    expect(sidecar.count()).toBe(1);
    expect(out.some(frame => frame.event === "response.completed")).toBe(false);
  });
});
