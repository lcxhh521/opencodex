import type { ChatgptUnblockHandle, StartChatgptUnblockOptions } from "../../chatgpt/desktop-unblock/runtime";
import { chatgptUnblockResolverRule, startChatgptUnblock } from "../../chatgpt/desktop-unblock/runtime";

/**
 * Owns the ChatGPT desktop send-unblock listener on behalf of `startServer`. The listener is
 * an optional integration: a bind failure degrades to a warning, never to a startup failure,
 * because every other duty keeps working without it. `startServer` stays synchronous, so the
 * start is fire-and-forget and `stop()` awaits whatever it produced.
 */
export interface ChatgptUnblockLifecycle {
  start(options: StartChatgptUnblockOptions): void;
  stop(): Promise<void>;
}

export function createChatgptUnblockLifecycle<T>(): ChatgptUnblockLifecycle {
  let pending: Promise<ChatgptUnblockHandle<T> | null> = Promise.resolve(null);
  return {
    start(options) {
      pending = startChatgptUnblock<T>(options).then(handle => {
        if (handle) {
          console.log(`🔓 ChatGPT send-unblock active on https://127.0.0.1:${handle.port} (CA: ${handle.caCertPath})`);
          console.log(`   Launch the ChatGPT app with: open -a ChatGPT --args --host-resolver-rules='${chatgptUnblockResolverRule(handle.port)}'`);
        }
        return handle;
      }).catch((error: unknown) => {
        console.warn(`⚠ ChatGPT send-unblock could not start: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    },
    async stop() {
      await (await pending)?.stop();
    },
  };
}
