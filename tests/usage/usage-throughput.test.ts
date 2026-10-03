import { describe, expect, test } from "bun:test";
import { summarizeUsage } from "../../src/usage/summary";
import type { PersistedUsageEntry } from "../../src/usage/log";

const FIXED_NOW = Date.UTC(2026, 5, 28, 12, 0, 0);

function entry(overrides: Partial<PersistedUsageEntry> & { ts: number }): PersistedUsageEntry {
  const { ts, ...rest } = overrides;
  return {
    requestId: rest.requestId ?? `req-${ts}`,
    timestamp: ts,
    provider: rest.provider ?? "openai",
    model: rest.model ?? "gpt-5.5",
    status: rest.status ?? 200,
    durationMs: rest.durationMs ?? 10,
    usageStatus: rest.usageStatus ?? "unreported",
    ...(rest.usage ? { usage: rest.usage } : {}),
    ...(rest.attempts ? { attempts: rest.attempts } : {}),
  };
}

function attempt(partial: {
  ordinal: number;
  provider?: string;
  model?: string;
  durationMs: number;
  outputTokens: number;
}): NonNullable<PersistedUsageEntry["attempts"]>[number] {
  return {
    ordinal: partial.ordinal,
    provider: partial.provider ?? "openai",
    model: partial.model ?? "gpt-5.5",
    adapter: "openai-responses",
    status: 200,
    durationMs: partial.durationMs,
    sendCount: 1,
    recoveryKinds: [],
    usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: partial.outputTokens },
  };
}

describe("usage throughput aggregation (#6309)", () => {
  test("rate is the token sum over the duration sum across attempts, not a mean of rates", () => {
    // 100 tok over 10s (10 tok/s) and 50 tok over 5s (10 tok/s) happen to agree; make
    // them disagree so a mean-of-rates would read 30 tok/s instead of the true 10.
    const sum = summarizeUsage(
      [entry({
        ts: FIXED_NOW - 1,
        usageStatus: "reported",
        usage: { inputTokens: 10, outputTokens: 300 },
        durationMs: 10,
        attempts: [
          attempt({ ordinal: 1, durationMs: 10_000, outputTokens: 100 }),
          attempt({ ordinal: 2, durationMs: 5_000, outputTokens: 200 }),
        ],
      })],
      "all",
      FIXED_NOW,
    );
    // 300 tokens over 15s = 20 tok/s; a mean of per-attempt rates would be 50.
    expect(sum.summary.throughputTokensPerSec).toBeCloseTo(20, 9);
    expect(sum.summary.throughputSamples).toBe(2);
    expect(sum.models[0]).toMatchObject({ throughputTokensPerSec: 20, throughputSamples: 2 });
    expect(sum.providers[0]).toMatchObject({ throughputTokensPerSec: 20, throughputSamples: 2 });
  });

  test("zero-token and zero-duration attempts contribute nothing and leave no samples", () => {
    const sum = summarizeUsage(
      [entry({
        ts: FIXED_NOW - 1,
        usageStatus: "unreported",
        attempts: [
          attempt({ ordinal: 1, durationMs: 0, outputTokens: 100 }),
          attempt({ ordinal: 2, durationMs: 5_000, outputTokens: 0 }),
        ],
      })],
      "all",
      FIXED_NOW,
    );
    expect(sum.summary.throughputTokensPerSec).toBeUndefined();
    expect(sum.summary.throughputSamples).toBeUndefined();
    expect(sum.models[0]?.throughputTokensPerSec).toBeUndefined();
  });

  test("rows without attempts use their own usage and duration", () => {
    const sum = summarizeUsage(
      [entry({
        ts: FIXED_NOW - 1,
        usageStatus: "reported",
        usage: { inputTokens: 10, outputTokens: 250 },
        durationMs: 5_000,
      })],
      "all",
      FIXED_NOW,
    );
    expect(sum.summary.throughputTokensPerSec).toBeCloseTo(50, 9);
    expect(sum.summary.throughputSamples).toBe(1);
  });

  test("a row whose duration is missing or not a number adds no sample and cannot poison the rate", () => {
    // The ledger reader does not type-check a row's own durationMs; a legacy or hand-edited row
    // can carry undefined or a string. Both must be skipped, not summed as NaN or concatenated.
    const malformed = (ts: number, durationMs: unknown) => ({
      ...entry({ ts, usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 999 } }),
      durationMs: durationMs as number,
    });
    const sum = summarizeUsage(
      [
        malformed(FIXED_NOW - 3, undefined),
        malformed(FIXED_NOW - 2, "5000"),
        entry({ ts: FIXED_NOW - 1, usageStatus: "reported", usage: { inputTokens: 10, outputTokens: 250 }, durationMs: 5_000 }),
      ],
      "all",
      FIXED_NOW,
    );
    expect(sum.summary.throughputSamples).toBe(1);
    expect(sum.summary.throughputTokensPerSec).toBeCloseTo(50, 9);
    expect(sum.models[0]?.throughputSamples).toBe(1);
    expect(sum.models[0]?.throughputTokensPerSec).toBeCloseTo(50, 9);
    expect(sum.providers[0]?.throughputSamples).toBe(1);
    expect(sum.providers[0]?.throughputTokensPerSec).toBeCloseTo(50, 9);
  });

  test("providers aggregate across models and the summary aggregates across rows", () => {
    const sum = summarizeUsage(
      [
        entry({
          ts: FIXED_NOW - 2,
          usageStatus: "reported",
          usage: { inputTokens: 10, outputTokens: 100 },
          durationMs: 10,
          attempts: [attempt({ ordinal: 1, model: "gpt-5.5", durationMs: 10_000, outputTokens: 100 })],
        }),
        entry({
          ts: FIXED_NOW - 1,
          usageStatus: "reported",
          usage: { inputTokens: 10, outputTokens: 300 },
          durationMs: 10,
          attempts: [attempt({ ordinal: 1, model: "gpt-5.5-mini", durationMs: 20_000, outputTokens: 300 })],
        }),
      ],
      "all",
      FIXED_NOW,
    );
    expect(sum.providers[0]?.throughputTokensPerSec).toBeCloseTo(400 / 30, 9);
    expect(sum.providers[0]?.throughputSamples).toBe(2);
    expect(sum.summary.throughputTokensPerSec).toBeCloseTo(400 / 30, 9);
    expect(sum.summary.throughputSamples).toBe(2);
  });
});
