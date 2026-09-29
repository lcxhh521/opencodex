# ChatGPT desktop send-unblock

The opt-in macOS integration that keeps the ChatGPT desktop composer usable while the signed-in
subscription quota is exhausted and the turn is routed to another provider. It lives in
`src/chatgpt/desktop-unblock/`. User workflow: `docs-site/src/content/docs/guides/chatgpt-desktop.md`.

## Switch and scope

- `chatgptDesktop.unblockSend` is off by default; `chatgptDesktop.pacFallback` only takes effect
  together with it, and `runtimeRole: "client"` disables both. The block is validated at the write
  boundary (`validateConfigCandidate` rejects a malformed value); a hand-edited file degrades to off
  on load.
- Nothing here logs, stores or forwards a credential. Requests are relayed to the real
  `https://chatgpt.com` with the caller's own headers.

## Listeners

All bind `127.0.0.1` and share one relay (`relayWithSendUnblock`) and one set of rewrites:

| Listener | Port | Purpose |
|---|---|---|
| TLS origin | `chatgptDesktop.port`, else public port + 200 | Receives the Chromium app's `chatgpt.com` traffic; certificate from the shared local intercept CA. |
| CONNECT entry | origin + 1 | PAC mode only. Accepts `CONNECT chatgpt.com:443` and nothing else, then splices onto the origin listener. |
| Plain HTTP | origin + 2 | The bundled `codex app-server`, reached through `chatgpt_base_url`; needs no certificate. |

The three ports wrap inside the TCP range without colliding. A bind failure degrades to a warning;
the proxy's other duties never depend on these listeners.

## Rewrites

Only the conversation endpoints and `/backend-api/wham/usage[/stream]` are rewritten (`rewriteSurfaceFor`);
every other response passes through byte-identical.

- Send blocks whose reason is usage quota (or absent) are removed from `blocked_features` and
  `limits_progress`; any other reason is kept and listed by `ocx chatgpt status`.
- On the usage snapshot `rate_limit.allowed` becomes true, `rate_limit.limit_reached` false, and a
  plain-quota `rate_limit_reached_type` is dropped. Workspace and credit variants are kept.
- Displayed usage (percentages, reset times, banners) is never changed.
- A JSON body over `MAX_REWRITE_BODY_BYTES` streams through unchanged instead of being buffered.

## Two routes to the same relay

The gate is read by two different clients, and each needs its own switch:

- **The Chromium app** is launched with `--host-resolver-rules` (default mode) or an inline
  `--proxy-pac-url=data:` switch (PAC mode). A `file://` PAC is ignored by the app and an `http://`
  one would need opencodex alive to be fetched, so the script travels inline. When opencodex stops,
  the refused CONNECT makes Chromium fall through to the captured system chain with no restart. The
  launch watcher rebuilds the switch from the PAC file written at each start.
- **The bundled `codex app-server`** issues the account reads with its own HTTP client, which no
  Chromium switch reaches. While the switch is on, the Codex injector writes a marker-owned root
  `chatgpt_base_url` pointing at the plain-HTTP listener. It follows the other injected root keys:
  journaled by value (`injectedChatgptBaseUrl`), removed by restore, by `ocx stop` and when the
  switch goes off, and a `chatgpt_base_url` the user set is kept and never journaled. It is written in
  both loopback and provider-table routing modes, ahead of the first table.

`ocx chatgpt launch|restore|status|install-watcher` (`src/cli/chatgpt-command.ts`) follow the
configured mode; `restore` undoes either launch switch.
