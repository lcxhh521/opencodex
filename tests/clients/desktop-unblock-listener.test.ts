import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  CHATGPT_UNBLOCK_IDENTITY_PATH,
  MAX_REWRITE_BODY_BYTES,
  CHATGPT_UNBLOCK_SERVICE_ID,
  ChatgptUnblockDiagnostics,
  relayWithSendUnblock,
  sseRewriteStream,
} from "../../src/chatgpt/desktop-unblock/listener";

const UPSTREAM = "https://chatgpt.example";

/** A fetch stand-in that records the target and answers with `response`. */
function upstreamReturning(response: () => Response): { fetchImpl: typeof fetch; targets: string[] } {
  const targets: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    targets.push(String(input));
    return response();
  }) as typeof fetch;
  return { fetchImpl, targets };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("chatgpt unblock relay scope", () => {
  test("an unrelated endpoint carrying a closed rate_limit passes through byte-identical", async () => {
    // Reproduction from review: the whole hostname is mapped, so unrelated JSON must not change.
    const body = '{"result":{"rate_limit":{"allowed":false,"limit_reached":true}}}';
    const { fetchImpl } = upstreamReturning(() => new Response(body, { headers: { "content-type": "application/json" } }));
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/review-fixture/not-a-composer-endpoint"), UPSTREAM, fetchImpl);
    expect(await res.text()).toBe(body);
  });

  test("the usage endpoint's closed gate is opened", async () => {
    const { fetchImpl, targets } = upstreamReturning(() => json({ rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } } }));
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage?x=1"), UPSTREAM, fetchImpl);
    expect(targets).toEqual([`${UPSTREAM}/backend-api/wham/usage?x=1`]);
    expect(await res.json()).toEqual({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 100 } } });
  });

  test("conversation init loses quota send blocks and reports preserved eligibility blocks", async () => {
    const diagnostics = new ChatgptUnblockDiagnostics();
    const { fetchImpl } = upstreamReturning(() => json({
      blocked_features: [
        { name: "send", block_reason: "usage_limit" },
        { name: "tpp_send", block_reason: "work_subscription_required" },
      ],
    }));
    const res = await relayWithSendUnblock(
      new Request("https://chatgpt.com/backend-api/conversation/init", { method: "POST", body: "{}" }),
      UPSTREAM, fetchImpl, diagnostics,
    );
    expect(await res.json()).toEqual({ blocked_features: [{ name: "tpp_send", block_reason: "work_subscription_required" }] });
    const identity = await relayWithSendUnblock(new Request(`https://chatgpt.com${CHATGPT_UNBLOCK_IDENTITY_PATH}`), UPSTREAM, fetchImpl, diagnostics);
    const snapshot = await identity.json() as { service: string; preservedSendBlocks: { name: string; reason: string }[] };
    expect(snapshot.service).toBe(CHATGPT_UNBLOCK_SERVICE_ID);
    expect(snapshot.preservedSendBlocks.map(({ name, reason }) => ({ name, reason }))).toEqual([
      { name: "tpp_send", reason: "work_subscription_required" },
    ]);
  });

  test("the identity path is answered locally and never relayed", async () => {
    const { fetchImpl, targets } = upstreamReturning(() => json({}));
    const res = await relayWithSendUnblock(new Request(`https://chatgpt.com${CHATGPT_UNBLOCK_IDENTITY_PATH}`), UPSTREAM, fetchImpl);
    expect(targets).toEqual([]);
    expect(((await res.json()) as { service: string }).service).toBe(CHATGPT_UNBLOCK_SERVICE_ID);
  });
});

describe("chatgpt unblock relay responses", () => {
  for (const status of [204, 205, 304]) {
    test(`a ${status} with a JSON content type is relayed without a body`, async () => {
      const { fetchImpl } = upstreamReturning(() => new Response(null, { status, headers: { "content-type": "application/json", etag: "\"v1\"" } }));
      const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage"), UPSTREAM, fetchImpl);
      expect(res.status).toBe(status);
      expect(res.body).toBeNull();
      expect(res.headers.get("etag")).toBe("\"v1\"");
    });
  }

  test("a HEAD request is answered without a body", async () => {
    const { fetchImpl } = upstreamReturning(() => json({ rate_limit: { allowed: false } }));
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage", { method: "HEAD" }), UPSTREAM, fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("an upstream failure becomes a 502 error envelope", async () => {
    const fetchImpl = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage"), UPSTREAM, fetchImpl);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { message: "chatgpt unblock relay failed: connect ECONNREFUSED" } });
  });

  test("response headers keep cookies and drop encoding, length and HTTP/3 advertisements", async () => {
    const { fetchImpl } = upstreamReturning(() => {
      const headers = new Headers({
        "content-type": "text/plain",
        "content-encoding": "br",
        "content-length": "999",
        "alt-svc": "h3=\":443\"; ma=86400",
      });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("ok", { headers });
    });
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/"), UPSTREAM, fetchImpl);
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).not.toBe("999");
    expect(res.headers.get("alt-svc")).toBeNull();
  });
});

describe("chatgpt unblock SSE rewriting", () => {
  // A window at 100% is the plain-quota evidence the gate rewrite requires before it opens the flags.
  const locked = JSON.stringify({ usage: { rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } } } });
  const opened = JSON.stringify({ usage: { rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 100 } } } });

  test("a data line split across chunks is rewritten once and every other byte survives", async () => {
    const frame = `event: snapshot\ndata: ${locked}\n\n: keep-alive\n\n`;
    const cut = frame.indexOf("limit_reached");
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame.slice(0, cut)));
        controller.enqueue(encoder.encode(frame.slice(cut)));
        controller.close();
      },
    });
    const text = await collect(source.pipeThrough(sseRewriteStream({ surface: "usage" })));
    expect(text.split("\n\n")).toEqual(["event: snapshot\ndata: " + opened, ": keep-alive", ""]);
  });

  test("CRLF-framed events are rewritten and keep their line endings", async () => {
    const frame = `event: snapshot\r\ndata: ${locked}\r\n\r\n`;
    const source = new Response(frame).body!;
    const text = await collect(source.pipeThrough(sseRewriteStream({ surface: "usage" })));
    expect(text).toBe(`event: snapshot\r\ndata: ${opened}\r\n\r\n`);
  });

  test("a stream on the conversation surface leaves usage gates alone", async () => {
    const source = new Response(`data: ${locked}\n\n`).body!;
    const text = await collect(source.pipeThrough(sseRewriteStream({ surface: "conversation" })));
    expect(text).toBe(`data: ${locked}\n\n`);
  });
});

describe("chatgpt unblock relay body cap", () => {
  const closedUsage = (padding: string) => JSON.stringify({ padding, rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } } });

  test("a JSON body over the cap streams through unchanged, whatever content-length says", async () => {
    const body = closedUsage("x".repeat(MAX_REWRITE_BODY_BYTES + 1024));
    // Chunked: no content-length, so the cap has to be enforced while reading.
    const chunked = upstreamReturning(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        for (let i = 0; i < bytes.length; i += 1 << 20) controller.enqueue(bytes.slice(i, i + (1 << 20)));
        controller.close();
      },
    }), { headers: { "content-type": "application/json" } }));
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage"), UPSTREAM, chunked.fetchImpl);
    expect(await res.text()).toBe(body);

    const declared = upstreamReturning(() => new Response(body, { headers: { "content-type": "application/json", "content-length": String(body.length) } }));
    const res2 = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage"), UPSTREAM, declared.fetchImpl);
    expect(await res2.text()).toBe(body);
  });

  test("a JSON body under the cap is still rewritten", async () => {
    const { fetchImpl } = upstreamReturning(() => new Response(closedUsage("y".repeat(1024)), { headers: { "content-type": "application/json" } }));
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/usage"), UPSTREAM, fetchImpl);
    expect((await res.json() as { rate_limit: { allowed: boolean } }).rate_limit.allowed).toBe(true);
  });
});


describe("chatgpt unblock read recovery", () => {
  const messagesUrl = "https://chatgpt.com/backend-api/messaging/rooms/fixture/messages?limit=20";
  const reset = () => new TypeError("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");

  test("a room history read recovers when the upstream closes before sending headers", async () => {
    const requests: { url: string | undefined; connection: string | undefined }[] = [];
    const server = createServer((req, res) => {
      requests.push({ url: req.url, connection: req.headers.connection });
      if (requests.length === 1) { req.socket.destroy(); return; }
      res.setHeader("content-type", "application/json");
      res.end('{"items":[]}');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const res = await relayWithSendUnblock(new Request(messagesUrl), `http://127.0.0.1:${address.port}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"items":[]}');
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual({ url: "/backend-api/messaging/rooms/fixture/messages?limit=20", connection: "close" });
    } finally {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });

  for (const method of ["GET", "HEAD"]) {
    test(`${method} retries once with the keep-alive pool disabled`, async () => {
      const attempts: RequestInit[] = [];
      const fetchImpl = (async (_: RequestInfo | URL, init?: RequestInit) => {
        attempts.push(init!);
        if (attempts.length === 1) throw reset();
        return new Response(method === "HEAD" ? null : "ok");
      }) as typeof fetch;
      const res = await relayWithSendUnblock(new Request(messagesUrl, { method }), UPSTREAM, fetchImpl);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(method === "HEAD" ? "" : "ok");
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.keepalive).toBeUndefined();
      expect(attempts[1]!.keepalive).toBe(false);
      expect(new Headers(attempts[1]!.headers).get("connection")).toBe("close");
    });
  }

  test("a persistent reset stops after two sends", async () => {
    let sends = 0;
    const fetchImpl = (async () => { sends++; throw reset(); }) as unknown as typeof fetch;
    const res = await relayWithSendUnblock(new Request(messagesUrl), UPSTREAM, fetchImpl);
    expect(res.status).toBe(502);
    expect(sends).toBe(2);
  });

  test("a read through a momentarily-refusing proxy recovers after the blip backoff", async () => {
    // A consumer VPN core reconnecting its tunnel refuses every dial for a second or two;
    // the relay waits it out instead of answering the desktop's own retry with a 502.
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Unable to connect");
      return json({ ok: true });
    }) as typeof fetch;
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/accounts/check"), UPSTREAM, fetchImpl);
    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("a read whose dial times out is not retried as a blip", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new DOMException("The operation was timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const res = await relayWithSendUnblock(new Request("https://chatgpt.com/backend-api/wham/accounts/check"), UPSTREAM, fetchImpl);
    // Timeouts are caller decisions: the desktop's own fetch deadline is the bound.
    expect(res.status).toBe(502);
    expect(attempts).toBe(1);
  });

  for (const method of ["POST", "PATCH", "DELETE"]) {
    test(`${method} is never replayed after a reset`, async () => {
      let sends = 0;
      const bodies: string[] = [];
      const fetchImpl = (async (_: RequestInfo | URL, init?: RequestInit) => {
        sends++;
        bodies.push(await new Response(init?.body).text());
        throw reset();
      }) as typeof fetch;
      const res = await relayWithSendUnblock(new Request(messagesUrl, { method, body: "fixture" }), UPSTREAM, fetchImpl);
      expect(res.status).toBe(502);
      expect(sends).toBe(1);
      expect(bodies).toEqual(["fixture"]);
    });
  }

  test("canceling a failed read during backoff prevents another send", async () => {
    const abort = new AbortController();
    let sends = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchImpl = (async () => {
      sends++;
      timer = setTimeout(() => abort.abort(), 10);
      throw reset();
    }) as unknown as typeof fetch;
    try {
      await relayWithSendUnblock(new Request(messagesUrl, { signal: abort.signal }), UPSTREAM, fetchImpl);
      expect(abort.signal.aborted).toBe(true);
      expect(sends).toBe(1);
    } finally { clearTimeout(timer); }
  });

  for (const status of [429, 502]) {
    test(`an upstream HTTP ${status} passes through without retry`, async () => {
      const { fetchImpl, targets } = upstreamReturning(() => new Response("upstream error", { status }));
      const res = await relayWithSendUnblock(new Request(messagesUrl), UPSTREAM, fetchImpl);
      expect(res.status).toBe(status);
      expect(await res.text()).toBe("upstream error");
      expect(targets).toHaveLength(1);
    });
  }

  test("a reset after headers does not replay the history stream", async () => {
    const { fetchImpl, targets } = upstreamReturning(() => new Response(new ReadableStream({
      start(controller) { controller.error(reset()); },
    })));
    const res = await relayWithSendUnblock(new Request(messagesUrl), UPSTREAM, fetchImpl);
    await expect(res.text()).rejects.toThrow("socket connection was closed unexpectedly");
    expect(targets).toHaveLength(1);
  });
});
