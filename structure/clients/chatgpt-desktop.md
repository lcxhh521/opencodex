# ChatGPT Desktop

Two opt-in macOS integrations for the ChatGPT desktop app live under `src/chatgpt/`, and both are
operated through `src/cli/chatgpt-command.ts`. User workflow:
`docs-site/src/content/docs/guides/chatgpt-desktop.md`.

- The send-unblock intercept (`src/chatgpt/desktop-unblock/`) keeps the composer usable while the
  signed-in subscription quota is exhausted and the turn is routed to another provider. It relays
  the Chromium app's `chatgpt.com` traffic and rewrites its send gates.
- The experimental app-server shim (`src/chatgpt/app-server-shim/`) filters the bundled
  `codex app-server`'s stdout. It works on its own or together with the intercept.

## Switch and scope

- `chatgptDesktop.unblockSend` is off by default; `chatgptDesktop.pacFallback` only takes effect
  together with it, and `runtimeRole: "client"` disables both. `chatgptDesktop.appServerShim` is off
  by default: on its own it allows explicit shim launches; with `unblockSend` the runtime also
  prepares the shim's launcher at start and the launch switches carry it. The block is validated at
  the write boundary (`validateConfigCandidate` rejects a malformed value and names the field); a
  hand-edited file degrades to off on load. On other platforms diagnostics warn about
  `appServerShim`, and every `ocx chatgpt` subcommand exits 1.
- Nothing here logs, stores or forwards a credential. Requests are relayed to the real
  `https://chatgpt.com` with the caller's own headers.

## Listeners

The listeners bind `127.0.0.1` and share one relay (`relayWithSendUnblock`) and one set of rewrites:

| Listener | Port | Purpose |
|---|---|---|
| TLS origin | `chatgptDesktop.port`, else public port + 200 | Receives the Chromium app's `chatgpt.com` traffic; certificate from the shared local intercept CA. |
| CONNECT entry | origin + 1 | PAC mode only. Accepts `CONNECT chatgpt.com:443` and nothing else, then splices onto the origin listener. |

The two ports wrap inside the TCP range without colliding. A bind failure degrades to a warning;
the proxy's other duties never depend on these listeners.

## Rewrites

Only the conversation endpoints and `/backend-api/wham/usage[/stream]` are rewritten (`rewriteSurfaceFor`);
every other response passes through byte-identical.

- Send blocks whose reason is usage quota (or absent) are removed from `blocked_features` and
  `limits_progress`; any other reason is kept and listed by `ocx chatgpt status`.
- The usage snapshot's gate uses the shim's `unlockRateLimitGate`
  (`src/chatgpt/app-server-shim/gate-rewrite.ts`). A plain-quota `rate_limit_reached_type` is
  dropped, and `rate_limit.allowed` / `rate_limit.limit_reached` open only where the payload shows
  plain-quota evidence: that reached type, or a usage window at 100% (`used_percent` in the web
  snapshot, `usedPercent` in the app-server RPC). Workspace and credit variants are kept, and while
  one of them or a reached `spend_control` stands in the payload the flags stay as sent. A flag
  closed for a reason the payload does not show also stays closed.
- Displayed usage (percentages, reset times, banners) is never changed.
- A JSON body over `MAX_REWRITE_BODY_BYTES` streams through unchanged instead of being buffered.

## Two places the gate is read

The composer's send gate can come from two different clients, and each needs its own route:

- **The Chromium app** is launched with `--host-resolver-rules` (default mode) or an inline
  `--proxy-pac-url=data:` switch (PAC mode). A `file://` PAC is ignored by the app and an `http://`
  one would need opencodex alive to be fetched, so the script travels inline. When opencodex stops,
  the refused CONNECT makes Chromium fall through to the captured system chain with no restart. The
  launch watcher rebuilds the switch from the PAC file written at each start. Because the switch is
  one argv entry, `chooseChatgptUnblockPac` embeds a system PAC only while the encoded switch stays
  within `CHATGPT_UNBLOCK_PAC_SWITCH_MAX_BYTES` (512 KiB, half of macOS `ARG_MAX`); a larger one
  falls back to the scutil chain then DIRECT (`system-pac-too-large`, warned at start), since an
  oversized switch would make `open` fail after the watcher has already quit the app.
- **The bundled `codex app-server`** fetches the account rate limits with its own HTTP client, which
  no Chromium switch reaches, and reports them to the app over stdio JSON-RPC. That route is the
  app-server shim below.

## App-server shim

The launcher under the config directory (`chatgpt-codex-shim.sh`) re-enters the current CLI using
`process.execPath` and `selfLaunchArgv()`. Its hidden internal filter command
(`ocx internal chatgpt-app-server-filter`) stays out of the public command registry and generated
skill surface. Source installs include the CLI entry argument; compiled builds use only the
executable and internal command arguments.

The launcher checks macOS, executable presence and a successful filter self-test, then replaces
itself with the bundled app-server using shell exec. Only stdout passes through the filter. Stdin,
stderr, process identity and the real server's exit status retain the direct app/server
relationship. When the platform is not macOS, the runtime is missing, or the filter self-test
fails, the launcher runs the original binary with untouched stdout. A missing bundled binary exits
127 instead. A filter that passes the self-test and then exits mid-session closes the server's
stdout pipe; the filter's passthrough mode limits this to an exit/crash case.

The filter (`filter.ts`, `app-server-rewrite.ts`) changes known plain-quota fields only in eligible
JSON-RPC rate-limit notifications (`account/rateLimits/updated`) and top-level rate-limit results
(`account/rateLimits/read`), with the gate rule above. Unrelated messages and malformed lines remain
byte-identical; changed lines are reserialized. A per-line rewrite exception preserves that line. A
failure in the framing/rewrite machinery preserves buffered bytes and switches the rest of the
stream to raw passthrough. A partial line is held as a list of chunks and joined once at its
newline, and a line longer than `MAX_FILTERED_LINE_BYTES` (8 MiB) is never joined or parsed: its
bytes stream through raw, and filtering resumes after its newline.

The app is discovered and confirmed by bundle identifier through `darwinDesktopAppAdapter.discover`
(`src/codex/desktop-app/darwin.ts`). `prepareChatgptShimLauncher` (`prepare.ts`) derives the bundled
app-server binary from that root (`resolveChatgptCodexBinary`) and refuses when none exists or when
`untrustedChatgptBundleReason` (`bundle-trust.ts`) reports the bundle or binary as owned by another
user, group/other-writable, unsigned, or signed by a team other than OpenAI's. Only then does it
write the mode-0755 launcher through an exclusive temp file and a rename (never through a symbolic
link). A refusal leaves an existing launcher in place, because an app started through it may still
respawn its app-server from it.

- **On its own** (`unblockSend` off), `ocx chatgpt launch` prepares the launcher, quits the bundle by
  id, waits for this user's instance to exit, then opens the same bundle path with the launcher in
  `CODEX_CLI_PATH`. `restore` relaunches without that override and removes the launcher only after
  `open` succeeds; when no `com.openai.codex` bundle is found it removes the launcher, relaunches
  nothing and exits 1. `status` reports the flag, launcher presence and whether the verified bundle
  process carries the override, without printing its environment. No listener, CA, PAC or watcher
  is involved, and explicit launches are the only activation point.
- **With the intercept**, `startChatgptUnblock` prepares the launcher at each start. A refusal or a
  failed write only disables the shim (`shimProblem`, warned at start); the listeners stay up.
  `ocx chatgpt launch` prepares it as well and refuses to launch on a refusal. The launch switches
  add `--env CODEX_CLI_PATH=<launcher>`, the watcher adds it only while an executable launcher exists
  (`shim_wanted`), and `restore` removes the launcher after a successful relaunch.

The launcher and its executable paths are local code-execution inputs. Tests cover rewriting, byte
framing, passthrough degradation, source/compiled launcher text, stub launcher execution, hidden
preflight and strict config writes in `tests/clients/desktop-*.test.ts`; the intercept-side
preparation and watcher behavior are in `tests/chatgpt-unblock/`. Pipe-crash behavior is mock
evidence only; no bundled-app respawn guarantee is asserted.

## Launch watcher

The watcher decides whether an app is already launched correctly from its command line plus its
environment (`ps eww`), so an app started without the shim is corrected once. It finds the app with
`pgrep -a -x ChatGPT`: without `-a`, pgrep skips its own ancestors, and `ocx chatgpt` run from a
terminal inside the app has the app as one. `install-watcher` runs `bash -n` on the generated script
and refuses to load one that does not parse, and `restore` hands back an app carrying either switch.
Its launchd agent wakes on the app's `SingletonLock` and on `chatgpt-unblock.ready`, which
`startChatgptUnblock` rewrites once the listener is up, so an app that opened before opencodex (both
at login) is still routed. In watch mode it only restarts an app that started within the last five
minutes (`ps -o etime=`), so an opencodex restart does not quit an app that has been open longer.
It is an age check, not an activity check, and an unreadable age counts as a fresh launch;
`ocx chatgpt launch` always acts. `ocx chatgpt launch|restore|status|install-watcher` follow the
configured modes.
