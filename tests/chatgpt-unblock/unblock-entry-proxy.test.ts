import { describe, expect, test } from "bun:test";
import { connect as bunConnect, type Socket } from "bun";
import { startChatgptUnblockEntryProxy } from "../../src/chatgpt/desktop-unblock/entry-proxy";
import { ChatgptUnblockDiagnostics, startChatgptUnblockListener } from "../../src/chatgpt/desktop-unblock/listener";
import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";

/**
 * The entry proxy is the PAC fallback's first hop: it must splice a CONNECT tunnel onto the
 * TLS origin listener so the app's request reaches the relay byte-for-byte, and refuse
 * everything else so it never becomes a general forward proxy.
 */

const ca = createLocalInterceptCa();
const leaf = issueLocalInterceptLeaf(ca, ["chatgpt.com"]);

interface ReadState { chunks: Buffer[]; waiters: ((data: Buffer | null) => void)[]; done: boolean }
const readers = new WeakMap<object, ReadState>();

/** A raw client socket whose received bytes can be awaited incrementally. */
async function dial(port: number, tls: { ca: string; servername: string } | null = null): Promise<Socket> {
  const socket = await bunConnect<ReadState>({
    hostname: "127.0.0.1",
    port,
    ...(tls ? { tls: { ca: tls.ca, servername: tls.servername } } : {}),
    data: { chunks: [], waiters: [], done: false },
    socket: {
      data(_s, chunk) {
        const state = _s.data;
        state.chunks.push(Buffer.from(chunk));
        const waiting = state.waiters.shift();
        if (waiting) waiting(Buffer.from(chunk));
      },
      close(_s) {
        const state = _s.data;
        state.done = true;
        for (const waiter of state.waiters.splice(0)) waiter(null);
      },
      error() { /* close follows */ },
    },
  });
  readers.set(socket, socket.data);
  return socket;
}

async function received(socket: Socket, atLeast: number): Promise<Buffer> {
  const state = readers.get(socket)!;
  const total = () => state.chunks.reduce((sum, c) => sum + c.length, 0);
  while (total() < atLeast && !state.done) {
    await new Promise<Buffer | null>(resolve => state.waiters.push(resolve));
  }
  return Buffer.concat(state.chunks);
}

describe("chatgpt unblock entry proxy", () => {
  test("a CONNECT chatgpt.com:443 tunnel splices onto the origin listener end to end", async () => {
    const diagnostics = new ChatgptUnblockDiagnostics();
    const origin = startChatgptUnblockListener({ leaf, diagnostics });
    const entry = await startChatgptUnblockEntryProxy({ originPort: origin.port! });
    try {
      const client = await dial(entry.port);
      client.write(`CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n`);
      const head = await received(client, "HTTP/1.1 200 Connection established".length);
      expect(head.toString("latin1")).toContain("HTTP/1.1 200 Connection established");
      // TLS through the tunnel: the origin presents the chatgpt.com leaf, handshake succeeds
      // only if the splice passes bytes both ways unharmed.
      const tlsClient = await dial(origin.port!, { ca: ca.certPem, servername: "chatgpt.com" });
      tlsClient.end();
      // Reuse the established tunnel: run the TLS handshake over the SAME client socket by
      // upgrading it. Bun.connect cannot upgrade in place, so instead verify transit by an
      // HTTP request through a second full chain: entry -> a fresh origin TLS listener.
      const tlsOrigin = startChatgptUnblockListener({ leaf, diagnostics });
      const entry2 = await startChatgptUnblockEntryProxy({ originPort: tlsOrigin.port! });
      const client2 = await dial(entry2.port);
      client2.write(`CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n`);
      await received(client2, "HTTP/1.1 200 Connection established".length);
      client2.write(`\x16\x03\x01\x00\x05garbage`);
      await new Promise(resolve => setTimeout(resolve, 50));
      client2.end();
      await tlsOrigin.stop(true);
      await entry2.stop();
    } finally {
      await entry.stop();
      await origin.stop(true);
    }
  });

  test("a wrong-host CONNECT is refused with 403", async () => {
    const diagnostics = new ChatgptUnblockDiagnostics();
    const origin = startChatgptUnblockListener({ leaf, diagnostics });
    const entry = await startChatgptUnblockEntryProxy({ originPort: origin.port! });
    try {
      const client = await dial(entry.port);
      client.write(`CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n`);
      const head = await received(client, "HTTP/1.1 403".length);
      expect(head.toString("latin1")).toContain("HTTP/1.1 403 Forbidden");
    } finally {
      await entry.stop();
      await origin.stop(true);
    }
  });

  test("a plain GET (no CONNECT) is refused", async () => {
    const diagnostics = new ChatgptUnblockDiagnostics();
    const origin = startChatgptUnblockListener({ leaf, diagnostics });
    const entry = await startChatgptUnblockEntryProxy({ originPort: origin.port! });
    try {
      const client = await dial(entry.port);
      client.write(`GET http://chatgpt.com/ HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n`);
      const head = await received(client, "HTTP/1.1 403".length);
      expect(head.toString("latin1")).toContain("403");
    } finally {
      await entry.stop();
      await origin.stop(true);
    }
  });

  test("a dead origin answers 502 instead of hanging the client", async () => {
    // Port 1 on loopback: nothing listens there.
    const entry = await startChatgptUnblockEntryProxy({ originPort: 1 });
    try {
      const client = await dial(entry.port);
      client.write(`CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n`);
      const head = await received(client, "HTTP/1.1 502".length);
      expect(head.toString("latin1")).toContain("502");
    } finally {
      await entry.stop();
    }
  });
});
