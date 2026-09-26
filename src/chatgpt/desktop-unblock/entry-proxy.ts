import { connect as bunConnect, listen as bunListen, type Socket, type TCPSocketListener } from "bun";

/**
 * Loopback CONNECT entry for the ChatGPT desktop send-unblock PAC fallback.
 *
 * The PAC points chatgpt.com at this plaintext listener. It speaks only enough HTTP proxy to
 * accept `CONNECT chatgpt.com:443`, answer 200, and splice the raw bytes both ways onto the TLS
 * origin listener (which terminates the intercept). Anything else is refused: this is not a
 * general forward proxy, and the app only ever asks for the intercepted host here.
 *
 * When opencodex stops, this listener dies with the process; Chromium sees the refused CONNECT
 * and falls through the PAC chain on its own, with no app restart.
 */

const MAX_HEAD_BYTES = 8 * 1024;
const HEAD_TIMEOUT_SECONDS = 10;

interface EntryState {
  head: Buffer;
  /** Set once the request head parsed; further data queues until the upstream attaches. */
  connecting: boolean;
  /** Bytes that arrived while the upstream connect was in flight. */
  pending: Buffer[];
  upstream: Socket | null;
}

export interface EntryProxyHandle {
  port: number;
  stop(): Promise<void>;
}

export interface StartEntryProxyOptions {
  /** Loopback port of the TLS origin listener the tunnels splice onto. */
  originPort: number;
  /** Test seam: bind a fixed port instead of an ephemeral one. */
  port?: number;
}

function refuse(socket: Socket<EntryState>, line: string): void {
  if (socket.data.upstream) return;
  socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
  socket.end();
}

function handleData(socket: Socket<EntryState>, chunk: Uint8Array, originPort: number): void {
  const state = socket.data;
  if (state.upstream) {
    state.upstream.write(chunk);
    return;
  }
  if (state.connecting) {
    // The CONNECT head parsed and the upstream dial is still in flight; hold the bytes
    // instead of re-entering the head parser (which would answer a second CONNECT).
    state.pending.push(Buffer.from(chunk));
    return;
  }
  state.head = state.head.length === 0 ? Buffer.from(chunk) : Buffer.concat([state.head, Buffer.from(chunk)]);
  const end = state.head.indexOf("\r\n\r\n");
  if (end === -1) {
    if (state.head.length > MAX_HEAD_BYTES) refuse(socket, "431 Request Header Fields Too Large");
    return;
  }
  const head = state.head.subarray(0, end).toString("latin1");
  const leftover = state.head.subarray(end + 4);
  if (!/^CONNECT\s+chatgpt\.com:443\s+HTTP\/1\.[01]\r?$/i.test(head.split("\r\n")[0] ?? "")) {
    refuse(socket, "403 Forbidden");
    return;
  }
  state.connecting = true;
  if (leftover.length > 0) state.pending.push(Buffer.from(leftover));
  bunConnect({
    hostname: "127.0.0.1",
    port: originPort,
    socket: {
      data(_upstream, upChunk) { socket.write(upChunk); },
      close() { socket.end(); },
      error() { socket.end(); },
    },
  }).then(upstream => {
    state.upstream = upstream;
    state.connecting = false;
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    for (const buffered of state.pending.splice(0)) upstream.write(buffered);
  }).catch(() => {
    state.connecting = false;
    refuse(socket, "502 Bad Gateway");
  });
}

export function startChatgptUnblockEntryProxy(options: StartEntryProxyOptions): Promise<EntryProxyHandle> {
  return new Promise((resolve, reject) => {
    let server: TCPSocketListener<EntryState>;
    try {
      server = bunListen<EntryState>({
        hostname: "127.0.0.1",
        port: options.port ?? 0,
        socket: {
          open(socket) {
            socket.data = { head: Buffer.alloc(0), connecting: false, pending: [], upstream: null };
            socket.timeout(HEAD_TIMEOUT_SECONDS);
          },
          data(socket, chunk) { handleData(socket, chunk, options.originPort); },
          close(socket) { socket.data.upstream?.end(); },
          error() { /* the close handler tears the pair down */ },
        },
      });
    } catch (error) {
      reject(error);
      return;
    }
    // Bun binds synchronously: `listen()` either returned a serving listener or threw.
    resolve({
      port: server.port,
      stop: () =>
        new Promise<void>(done => {
          server.stop(true);
          done();
        }),
    });
  });
}
