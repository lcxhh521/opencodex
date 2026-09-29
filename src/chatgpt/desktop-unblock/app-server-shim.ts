import { existsSync } from "node:fs";
import { rewriteAppServerLine } from "./app-server-rewrite";

/**
 * Stdio shim for the bundled `codex app-server`.
 *
 * The ChatGPT desktop app decides whether the composer can send from what the app-server tells
 * it over JSON-RPC (account rate limits, blocked features). The app-server fetches that state
 * with its own HTTP client, so neither Chromium switches nor a PAC file ever see it. The desktop
 * app does honour `CODEX_CLI_PATH`, so a launch that points it at a script running this shim puts
 * the shim on the one pipe that carries the answer, and nothing else:
 *
 *  - stdin and stderr are inherited, so the child reads and writes them directly;
 *  - stdout is read line by line; a line that does not mention a rate-limit field is written back
 *    as the exact bytes it arrived in, and only a line the rewrite changes is re-serialized;
 *  - no environment variable, address, certificate or config key is touched, so the app-server's
 *    own children and every other client of the Codex home behave exactly as before;
 *  - the shim needs no running opencodex. If it cannot start, the launcher script falls through to
 *    the real binary.
 */

/** Where the real Codex binary lives inside the app bundle. */
export const CHATGPT_APP_CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

/** Environment variable the launcher script uses to hand the real binary to the shim. */
export const REAL_CODEX_ENV = "OCX_REAL_CODEX";

const NEWLINE = 0x0a;

/**
 * Splits a byte stream into lines and rewrites the ones that need it. Returns the bytes to write
 * for each chunk; a partial trailing line is held back until its newline arrives (or `flush`).
 */
export function createRpcLineFilter(
  rewrite: (line: string) => string | null = rewriteAppServerLine,
): { push(chunk: Uint8Array): Uint8Array[]; flush(): Uint8Array[] } {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending: Uint8Array = new Uint8Array(0);

  // `line` excludes the newline, `whole` includes it when there is one. An untouched line is
  // returned as the very bytes that arrived; only a rewritten one is re-encoded.
  const emit = (line: Uint8Array, whole: Uint8Array, terminated: boolean): Uint8Array => {
    const rewritten = rewrite(decoder.decode(line));
    if (rewritten === null) return whole;
    const body = encoder.encode(rewritten);
    if (!terminated) return body;
    const out = new Uint8Array(body.length + 1);
    out.set(body, 0);
    out[body.length] = NEWLINE;
    return out;
  };

  return {
    push(chunk) {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending, 0);
      joined.set(chunk, pending.length);
      const out: Uint8Array[] = [];
      let start = 0;
      for (let i = 0; i < joined.length; i++) {
        if (joined[i] !== NEWLINE) continue;
        out.push(emit(joined.subarray(start, i), joined.subarray(start, i + 1), true));
        start = i + 1;
      }
      pending = joined.slice(start);
      return out;
    },
    flush() {
      if (pending.length === 0) return [];
      const last = pending;
      pending = new Uint8Array(0);
      return [emit(last, last, false)];
    },
  };
}

/** Run the real Codex with `argv`, filtering its stdout. Resolves to its exit code. */
export async function runAppServerShim(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  write: (bytes: Uint8Array) => Promise<unknown> | unknown = bytes => Bun.write(Bun.stdout, bytes),
): Promise<number> {
  const real = env[REAL_CODEX_ENV]?.trim() || CHATGPT_APP_CODEX_BINARY;
  if (!existsSync(real)) {
    process.stderr.write(`opencodex app-server shim: real Codex binary not found at ${real}\n`);
    return 127;
  }
  const childEnv = { ...env };
  delete childEnv[REAL_CODEX_ENV];
  const child = Bun.spawn([real, ...argv], { env: childEnv, stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  const forward = (signal: NodeJS.Signals) => () => {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, forward(signal));

  const filter = createRpcLineFilter();
  for await (const chunk of child.stdout) {
    for (const out of filter.push(chunk)) await write(out);
  }
  for (const out of filter.flush()) await write(out);
  return await child.exited;
}

if (import.meta.main) {
  process.exit(await runAppServerShim(process.argv.slice(2)));
}
