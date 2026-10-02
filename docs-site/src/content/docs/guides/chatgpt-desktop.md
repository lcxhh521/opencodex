---
title: ChatGPT Desktop Send Unblock
description: Keep the ChatGPT desktop app's composer usable when the account's usage quota runs out (macOS, opt-in).
---

When the logged-in ChatGPT account runs out of usage quota, the ChatGPT desktop app greys out
its send button, even for conversations whose model calls opencodex routes to other providers.
This opt-in macOS integration keeps the composer usable. It is off by default.

## What it changes

opencodex runs a local TLS listener for `chatgpt.com`. The app is launched with a Chromium
switch that sends `chatgpt.com` to that listener; every other host, including its subdomains,
keeps its normal route. Requests are relayed to the real `chatgpt.com` with the app's own
credentials, and WebSockets (such as voice dictation) are relayed as well. Nothing is logged or
stored.

Responses are passed through unchanged except for two endpoints:

- conversation metadata (`/backend-api/conversation/init` and the conversation stream): send
  locks caused by usage quota are removed;
- the usage snapshot (`/backend-api/wham/usage`): the "limit reached" gate is opened.

Send locks with any other reason, such as a subscription requirement, are kept, and
`ocx chatgpt status` lists them. Displayed usage (percentages, reset times, banners) is never
changed, and OpenAI's servers still enforce every limit on their own requests.

On some builds the send button follows what the app's built-in Codex server reports about your
account, and that server fetches it with its own HTTP client, which neither the resolver rule nor a
PAC file reaches. The experimental [app-server shim](#app-server-shim-experimental) covers that
case.

## Setup

1. Enable the feature in `~/.opencodex/config.json` and restart opencodex:

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   The listener uses the proxy port plus 200 (`10300` by default). Set
   `chatgptDesktop.port` to choose another port.

2. Trust the local certificate authority once. The command asks for your login password, so
   run it yourself:

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   Without this trust the app cannot load account, usage or settings pages. If you use a
   custom opencodex home, `ocx chatgpt status` prints the exact command for your setup.

3. Launch the app through opencodex:

   ```bash
   ocx chatgpt launch
   ```

4. Optional: make normal Dock and Spotlight launches use the route too:

   ```bash
   ocx chatgpt install-watcher
   ```

   The watcher runs each time the app starts, and again when opencodex starts. If the app was
   opened normally, it quits the app right after launch and reopens it with the route. When the
   app opens at login before opencodex is up, it does this as soon as opencodex is running. To
   avoid quitting an app you have been using for a while, it only restarts an app that started
   in the last five minutes (an app whose age cannot be read counts as just started);
   `ocx chatgpt launch` restarts the app whatever its age. It does nothing while opencodex is
   not running. The command asks for confirmation; `--yes` confirms non-interactively.

## Network setups

No VPN or proxy rules are needed. In the default mode the launch arguments are chosen from the
system proxy each time the app starts:

| Setup | What the app is launched with |
|---|---|
| No proxy | The `chatgpt.com` route only. |
| VPN in system-proxy mode | The route, the system proxy with a direct fallback, and a bypass for `chatgpt.com` only. |
| VPN in TUN mode | The route only; loopback traffic never enters the tunnel. |
| PAC file | The route only. The PAC file may keep `chatgpt.com` on the proxy, so the composer can stay locked, but nothing else breaks. |

opencodex reaches the real `chatgpt.com` through its own `proxy` setting, like all its other
outbound traffic.

## Keep the app working when opencodex stops

In the default mode a routed app depends on the listener: while opencodex is stopped, its
`chatgpt.com` requests fail. PAC fallback launches the app with a generated PAC script instead,
so the app falls back on its own. The script is passed inline (a `data:` URL) because the app
ignores a `file://` PAC and an `http://` one would need opencodex running to be fetched:

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` only takes effect together with `unblockSend`. opencodex then also listens on the
listener port plus one (`10301` by default) and rewrites `chatgpt-unblock.pac` in its home
directory at every start. The PAC sends `chatgpt.com` to opencodex first, and every other host
the way the system routes it:

| Setup | Other hosts, and `chatgpt.com` while opencodex is stopped |
|---|---|
| No proxy, or VPN in TUN mode | Direct. |
| VPN in system-proxy mode | The system proxy, then direct. |
| PAC file | The system PAC, embedded in the generated file. |

When opencodex stops, the app keeps working on that route without a restart; only the send unblock
pauses until opencodex is back. The route is captured when opencodex starts: after changing the
VPN mode, restart opencodex and run `ocx chatgpt launch`. If a system PAC is set but cannot be
read at that moment, or is too large to pass to the app (the PAC travels inside one launch
argument, limited to 512 KiB once encoded), other hosts follow the system proxy, if there is one,
then go direct, and opencodex prints a warning.

After turning `pacFallback` on or off, restart opencodex, run `ocx chatgpt launch`, and run
`ocx chatgpt install-watcher` again if you use the watcher.

## App-server shim (experimental)

The shim filters the built-in Codex server's JSON-RPC output to open known plain-quota gates. It
does not increase an account's quota or make an upstream service accept a request it refuses. It
is macOS only and off by default, and works in two ways:

- **On its own.** Set `{ "chatgptDesktop": { "appServerShim": true } }` and run
  `ocx chatgpt launch`. opencodex writes an executable launcher in its home directory, quits
  ChatGPT if it is running, and relaunches it with `open -a <bundle> --env CODEX_CLI_PATH=<launcher>`.
  The app is found by its bundle identifier, `com.openai.codex`, so an install in `~/Applications`
  or on another volume works, and another app that shares the "ChatGPT" name is never quit or
  opened. Save ongoing work first: this restarts the app. It does not need a running opencodex
  proxy. Normal Dock or Spotlight launches do not apply the shim. `ocx chatgpt restore` removes the
  launcher and relaunches without the override.
- **With send unblock.** With `unblockSend` and `appServerShim` both on, opencodex prepares the
  launcher at every start, and `ocx chatgpt launch` and the watcher start the app through it. If the
  checks below refuse the bundle, opencodex prints a warning and the intercept keeps working
  without the shim.

Only `account/rateLimits/updated` notifications and responses whose top-level result contains
`rateLimits`, `rateLimitsByLimitId` or `ordinaryUsageAllowed` are eligible. Plain
`rate_limit_reached` markers are cleared; the gate flags (`allowed`, `limit_reached` /
`limitReached`, `ordinaryUsageAllowed`) open only with plain-quota evidence, that marker or a window
at 100%. A flag closed for a reason the payload does not show stays closed, and workspace, credit,
unknown and spend-control restrictions keep the gate closed. Displayed usage stays as received, and
every other message passes through byte for byte. Stdin, stderr and the real binary's exit status
keep their direct connection to the app.

Before writing the launcher, opencodex checks that the bundle and its app-server binary are owned by
you or root, are not writable by group or others, and pass strict code-signature verification under
OpenAI's team ID (`2DC432GLL2`). A bundle that fails any of these is refused. The launcher has mode
`0755`, embeds the current opencodex executable, and is written to a temporary file and renamed into
place, so a symbolic link at that path is replaced rather than followed. Keep the launcher, its
directory and the opencodex installation under your control: changing these paths changes code the
app runs.

When the platform is not macOS, the opencodex runtime is missing, or the filter's self-test fails,
the launcher runs the original binary with untouched stdout. If an app update moves or removes the
bundled app-server binary itself, the launcher prints a message naming `ocx chatgpt launch` and
`ocx chatgpt restore` and exits, and the app cannot start its server until you run one of them. A
filter that passes the self-test and then dies mid-session closes the server's output pipe; what the
app does after that has not been verified. A single output line longer than 8 MiB is passed through
unparsed. The shim depends on the app honoring `CODEX_CLI_PATH` and on the current message shapes,
which updates may change.

## Check the state

```bash
ocx chatgpt status
```

It reports whether the feature is on, whether the listener on the port is opencodex's, whether
the certificate is trusted, the watcher state, whether the running app carries the route, and
any send locks that were kept on purpose. With the app-server shim on it also reports whether its
launcher exists and whether the running app was started through it.

## Turn it off

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore` reopens a routed app with native networking and without the app-server shim, and removes
the shim's launcher. Then set `chatgptDesktop.unblockSend` (and `appServerShim`) to `false` and
restart opencodex. The certificate authority is
shared with opencodex's Claude integrations; remove its trust only if you use neither.

## Troubleshooting

- **Account, usage or settings pages do not load:** the certificate is not trusted. Run
  step 2 again; `ocx chatgpt status` shows the trust state.
- **The send button is still grey:** check `ocx chatgpt status`. The app may be running
  without the route (run `ocx chatgpt launch`), or the lock may have a reason other than usage
  quota, which is listed under "send blocks kept".
- **The send button stays grey with the route working:** the lock may come from the built-in Codex
  server rather than from the pages the route covers. Turn on `chatgptDesktop.appServerShim`, run
  `ocx chatgpt launch`, and check `ocx chatgpt status` (the "app-server shim" line says whether the
  running app was started through it). If opencodex warned at start that the shim was not
  prepared, or `launch` refuses it, the reason names the check the bundle failed.
- **The app cannot load anything after opencodex stops:** in the default mode a routed app
  depends on the listener. Start opencodex again or run `ocx chatgpt restore`, or turn on
  PAC fallback so the app falls back on its own.
