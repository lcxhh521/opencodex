import type { Server } from "bun";
import type { PemKeyPair } from "../../claude/intercept/local-ca";
import { forwardHeadersForUpstream } from "../../claude/intercept/listener";
import { stripSendBlocksFromJson, stripSendBlocksFromSseLine } from "./rewrite";

/**
 * TLS listener for the ChatGPT desktop send-unblock intercept.
 *
 * Launched with `--host-resolver-rules="MAP chatgpt.com 127.0.0.1:<port>"`, the desktop app
 * dialls this listener believing it reached chatgpt.com. Requests are relayed verbatim to the
 * real upstream with the caller's own auth headers; responses pass through untouched except
 * that conversation payloads lose their client-side send-lock entries. Nothing is logged and
 * no credential is persisted -- the listener is a pipe, not a store.
 *
 * Only the exact host `chatgpt.com` is ever presented here. Subdomains (`ab.chatgpt.com`,
 * `codex-cloud-backend.chatgpt.com`) and `auth.openai.com` are not mapped by the launcher, so
 * login, telemetry and cloud sessions stay native.
 */

export const CHATGPT_UNBLOCK_UPSTREAM = "https://chatgpt.com";
export const CHATGPT_INTERCEPT_HOST = "chatgpt.com";

// fetch() transparently decodes the body, so the encoding headers would describe bytes the
// client never sees.
const RESPONSE_STRIP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length",
]);

export interface ChatgptUnblockListenerOptions {
  leaf: PemKeyPair;
  upstreamBase?: string;
  idleTimeout?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: bind a fixed port instead of an ephemeral one. */
  port?: number;
}

function responseHeaders(source: Response): Headers {
  const headers = new Headers();
  source.headers.forEach((value, name) => {
    if (!RESPONSE_STRIP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  });
  return headers;
}

/**
 * Line-oriented SSE rewriter. Complete lines are checked one at a time so an untouched stream
 * keeps its exact chunking and line endings; only `data:` lines whose JSON loses an entry are
 * re-serialized.
 */
export function sseRewriteStream(debug?: (line: string, rewritten: string | null) => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        const rewritten = stripSendBlocksFromSseLine(line);
        debug?.(line, rewritten);
        controller.enqueue(encoder.encode(`${rewritten ?? line}\n`));
      }
    },
    flush(controller) {
      if (pending.length === 0) return;
      const rewritten = stripSendBlocksFromSseLine(pending);
      debug?.(pending, rewritten);
      controller.enqueue(encoder.encode(rewritten ?? pending));
      pending = "";
    },
  });
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes("application/json") || contentType.endsWith("+json");
}

function isEventStreamContentType(contentType: string): boolean {
  return contentType.includes("text/event-stream");
}

export async function relayWithSendUnblock(
  req: Request,
  upstreamBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(req.url);
  const target = `${upstreamBase.replace(/\/$/, "")}${url.pathname}${url.search}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: req.method,
      headers: forwardHeadersForUpstream(req.headers),
      body: hasBody ? req.body : undefined,
      signal: req.signal,
      redirect: "manual",
      // @ts-expect-error -- streaming request bodies require half duplex under the fetch spec.
      duplex: "half",
    });
  } catch (error) {
    return Response.json(
      { error: { message: `chatgpt unblock relay failed: ${error instanceof Error ? error.message : String(error)}` } },
      { status: 502 },
    );
  }
  const headers = responseHeaders(upstream);
  const contentType = upstream.headers.get("content-type") ?? "";
  if (isJsonContentType(contentType)) {
    let text: string;
    try {
      text = await upstream.text();
    } catch {
      return new Response(JSON.stringify({ error: { message: "chatgpt unblock upstream read failed" } }), { status: 502, headers });
    }
    const rewritten = stripSendBlocksFromJson(text);
    return new Response(rewritten ?? text, { status: upstream.status, statusText: upstream.statusText, headers });
  }
  if (isEventStreamContentType(contentType) && upstream.body) {
    return new Response(upstream.body.pipeThrough(sseRewriteStream()), { status: upstream.status, statusText: upstream.statusText, headers });
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/** Bind the intercept TLS listener on an ephemeral loopback port. */
export function startChatgptUnblockListener<T = undefined>(options: ChatgptUnblockListenerOptions): Server<T> {
  const upstreamBase = options.upstreamBase ?? CHATGPT_UNBLOCK_UPSTREAM;
  return Bun.serve<T>({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    tls: { cert: options.leaf.certPem, key: options.leaf.keyPem },
    idleTimeout: options.idleTimeout ?? 255,
    async fetch(req) {
      return relayWithSendUnblock(req, upstreamBase, options.fetchImpl);
    },
  });
}
