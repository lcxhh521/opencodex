---
title: ChatGPT Desktop integrations (experimental)
description: Opt-in macOS cloud networking, app-server shim and local-CA TLS intercept integrations.
---

These integrations are independent and default off. Cloud networking preserves TLS;
the app-server shim filters selected fields in the local app-server's output.
Enabling one never enables another.

## Built-in cloud networking

OpenCodex can forward the desktop's encrypted connection to
`codex-cloud-backend.chatgpt.com:443` through its existing outbound proxy.
The feature is macOS-only and opt-in through `chatgptDesktop.cloudNetwork`.
It needs no Developer ID, separate application, Network Extension, local CA,
or desktop bundle modification. It does require administrator-approved
management of this one hostname's hosts mapping and resolver-cache invalidation.

**This changes resolution for all OS-resolver clients of that hostname, not only
the desktop app.** Preserve any working interim route until a separately authorized
real-machine acceptance verifies port 443, DNS caching and authenticated desktop use.

### Install, enable and inspect

Use an updated OpenCodex installation. These are real system operations, not test commands:

```bash
ocx chatgpt network install
ocx chatgpt network enable
ocx chatgpt network status
```

Installation asks for confirmation and then administrator permission through sudo.
`--yes` skips only the initial confirmation, not OS authorization.
It installs an OpenCodex-owned recovery helper and leaves routing off. It does not
restart the proxy or desktop. The helper is internal implementation, not a separately
configured proxy: its launchd job owns the fixed mapping, resolver recovery and
loopback 443 listener. It forwards opaque bytes only to the local OpenCodex entry.
The network relay, outbound proxy selection, configuration and lifecycle belong to OpenCodex.

`enable` requires the running server and calls its authenticated local management
API. It saves `chatgptDesktop.cloudNetwork: true`, leaving the other desktop flags
unchanged, and starts the integration immediately. Subsequent proxy starts read that flag.
An activation failure remains visible as configured-but-unavailable and returns failure;
it does not stop the model proxy or silently report success.

For configuration-file users:

```json
{
  "proxy": "http://127.0.0.1:8123",
  "chatgptDesktop": {
    "cloudNetwork": true
  }
}
```

Use your existing proxy setting; there is no separate cloud proxy-port configuration.
The same proxy/environment precedence as other OpenCodex transports applies, including
HTTP(S) CONNECT and SOCKS5. A missing proxy, a matching NO_PROXY bypass or a local-443/10443
proxy loop refuses activation. There is no direct fallback through the mapped hostname.

OpenCodex resolves this fixed cloud hostname through the DNS-over-HTTPS
endpoint at `https://1.1.1.1/dns-query` over the same outbound proxy. It caches IPv4
answers for their returned TTL and refreshes them when expired. The proxy tunnel
connects to the resulting IP address on port 443; the desktop keeps its original
TLS hostname and certificate verification. A failed lookup does not reuse an
expired answer or fall back to the system's DNS. Your proxy must reach both this
DNS endpoint and the cloud service.

The ordinary-user runtime binds loopback 10443 and verifies CONNECT acceptance first.
The privileged helper then binds IPv4 and IPv6 loopback 443 before applying the mapping;
the model proxy never runs as root. An occupied or unavailable listener port leaves the
mapping off. The helper cannot select a different destination or read TLS payloads.
This requires helper protocol v2: after updating from v1, reinstall the helper before enabling.
Status distinguishes intent, active runtime and failures; `applicationHandshake`
remains `unverified`. Active forwarding is not proof of a logged-in cloud session.
`ocx chatgpt status` includes cloud status. Every `ocx chatgpt launch` with
`cloudNetwork` enabled requires that runtime to be active.

### Launch through the local cloud route

After activation, save ongoing desktop work and run:

```bash
ocx chatgpt launch
```

This restarts the app with the network arguments needed to reach the helper:

- With an explicit system HTTP/SOCKS proxy, the cloud hostname bypasses that proxy
  in the desktop and reaches the local hosts mapping. Other hosts retain the
  system proxy with its direct fallback.
- With a system PAC, OpenCodex wraps its rules with a DIRECT exception for the
  cloud hostname and retains the original rules for other hosts. If the system PAC
  cannot be read or is too large, those other hosts use the captured system proxy
  chain, then direct access.
- With direct networking or a VPN in TUN mode, the hosts mapping supplies the local
  route without an additional desktop proxy switch.

The desktop's DIRECT route ends at the local helper; OpenCodex still forwards the
cloud connection through its configured outbound proxy. These launch arguments
also work with cloud networking alone, without the shim or local-CA intercept.
When the shim is enabled, the same launch also applies its prepared
`CODEX_CLI_PATH` override.

When used with the intercept, `ocx chatgpt launch` refreshes the PAC from the current
flags before restarting the app. You can enable cloud networking on a running
OpenCodex instance and launch the app without restarting the proxy.

If you use the optional intercept watcher, reinstall it with
`ocx chatgpt install-watcher` after changing `cloudNetwork`, `appServerShim` or
`pacFallback`. The watcher captures these settings when installed and preserves
the configured shim when its prepared launcher exists.

### Disable, recover and remove

```bash
ocx chatgpt network disable
ocx chatgpt network recover
ocx chatgpt network uninstall
```

Disable saves the flag as false and removes the owned mapping before closing listeners.
Recovery also disables intent and retries any incomplete mapping/cache cleanup.
If cleanup fails, the off flag is saved but status remains unavailable. Repeating disable
retries recovery; it does not report success solely because the flag is already off.
When the proxy is stopped, these commands can still save disabled intent and contact
the helper; an unavailable helper reports unverified recovery, never successful cleanup.
An active lease from another runtime is not revoked.

The helper holds the mapping only while its connection to the OpenCodex runtime exists.
Runtime death closes that connection and triggers recovery. The helper's launchd
configuration requests restart and boot startup; each new helper process restores the
journal before accepting a new lease. There can be a recovery interval after helper death
or a reboot: no instantaneous recovery or authenticated reconnection guarantee is claimed.
Recovery preserves unrelated hosts lines and refuses edited owned blocks for inspection.

Uninstall requires disabled routing, restores any remaining owned mapping, stops only
the cloud helper and removes its fixed files. It does not stop the model proxy.
`ocx chatgpt restore` confirms cloud recovery before its desktop relaunch, even when
the flag is already off but the recovery helper is still installed;
use `network recover` for an abandoned mapping when no desktop is installed.
A helper update is explicit: disable, run `network install` again, then enable.
Ordinary proxy updates do not execute a hidden administrator operation.

Source/npm installs bundle the small helper and copy their Bun runtime into the
root-owned installation. Standalone builds copy their executable and use its hidden
helper entry. launchd never runs code from a user-writable checkout or package tree.

### Isolated development validation

The cloud-network tests exercise the same runtime and recovery helper with temporary
hosts files, Unix sockets and ephemeral listener ports. They cover TLS forwarding,
DNS caching and failure, launch/PAC composition, process loss and journal recovery
without installing a service or changing system routing.
There is no separate sandbox command or native system-extension implementation to maintain.
Passing these checks does not verify an installed helper or a logged-in desktop
session or establish deployment acceptance.

## App-server shim (experimental)

This experiment is **macOS only and off by default**. It filters the bundled ChatGPT
app-server's JSON-RPC stdout to open known plain-quota gates. It does not increase
an account's quota or make an upstream service accept a request it refuses.

Enable it in your OpenCodex `config.json`:

```json
{
  "chatgptDesktop": { "appServerShim": true }
}
```

Then run:

```bash
ocx chatgpt launch
ocx chatgpt status
```

`launch` creates an executable launcher under the OpenCodex config directory,
quits ChatGPT if it is running, and relaunches it with
`open -a <bundle> --env CODEX_CLI_PATH=<launcher>`. The app is found by its bundle
identifier, `com.openai.codex`, so an install in `~/Applications` or on another
volume works, and another app that shares the "ChatGPT" name is never quit or
opened. Save ongoing work first: this
restarts the app. It does not require a running OpenCodex proxy.

To remove the launcher and relaunch without the override:

```bash
ocx chatgpt restore
```

Restore leaves the config flag as configured. Set `chatgptDesktop.appServerShim`
to `false` or remove it to disable future explicit shim launches. Normal launches
from Dock or Spotlight do not apply the shim automatically.

If ChatGPT is not installed (no `com.openai.codex` bundle is found), `restore`
only removes the launcher: it cannot relaunch anything and exits with an error.

### Rewrite boundary

Only `account/rateLimits/updated` notifications and responses whose top-level
result contains `rateLimits`, `rateLimitsByLimitId`, or `ordinaryUsageAllowed`
are eligible. Plain `rate_limit_reached` markers are cleared; known quota gate
flags (`allowed`, `limit_reached` / `limitReached`, `ordinaryUsageAllowed`) are
opened only with plain-quota evidence (a cleared plain reached type or a window at
100%). A flag closed for a reason the payload does not show stays closed. Workspace,
credit, unknown reached-type and spend-control
restrictions keep the usage gate closed.

Displayed usage stays honest: percentages, reset times, window durations, plan
information and other display fields stay as received. Unrelated JSON-RPC
messages, nested tool output, conversation send-block metadata and malformed
lines pass through. Only changed lines are serialized again; other bytes retain
their original encoding and line endings. Stdin, stderr and the real binary's
exit status retain their direct connection to the app.

### Executable and environment security

The generated launcher has mode `0755` and embeds the current OpenCodex executable
and, for source installs, the CLI entry path. `CODEX_CLI_PATH` tells ChatGPT to
execute this launcher instead of its bundled binary directly. Keep the launcher,
its config directory, and the OpenCodex installation under your control: changing
these executable paths changes code the app runs. The launcher still `exec`s the
bundled binary of the discovered bundle; if that bundle has no app-server binary,
`launch` refuses instead of writing a launcher.

Before writing the launcher, `launch` also checks that the bundle and its
app-server binary are owned by you or root, are not writable by group or others,
and pass strict code-signature verification under OpenAI's team ID
(`2DC432GLL2`). A bundle that fails any of these checks is refused, including
one owned by another account. The launcher file is
written to a temporary file and renamed into place; an existing symbolic link at
that path is replaced, not followed.

`restore` applies the same ownership, permissions, and signature checks to the
bundle and its main app executable before quitting or opening it. It works with
the experimental flag off and without a bundled app-server binary. If trust
verification or relaunch fails, the existing launcher is kept for recovery.

Both commands also check the folders containing the bundle up to the filesystem
root. Folders owned by another account, symbolic links, and ordinary group- or
world-writable parents are refused. Root-owned administrator-group installation
folders and trusted sticky folders retain their normal permissions behavior.
These are ownership, POSIX-permission, and signature checks; native ACL and
volume ownership-policy behavior has not been verified.

The app-server shim alone installs no certificate, network listener, PAC, or background
watcher. It does not log the app's messages or environment. Status reports whether
the running ChatGPT bundle process carries the expected launcher override.

If app discovery or process inspection fails, `status` reports `unknown` rather
than `not running`. `launch` and `restore` refuse to reopen an app whose exit
cannot be confirmed; restore keeps the launcher. Resolve the inspection error
and retry. Launch checks before writing its launcher, but a later inspection can
still fail after that atomic update; the commands do not guarantee an all-or-nothing
restart transaction.

### Failure behavior and known limits

When the platform is not macOS, the OpenCodex runtime is missing, or the filter
self-test fails, the launcher runs the original binary with untouched stdout. A
missing bundled app-server binary is the exception: there is nothing to fall back
to, so the launcher exits with an error (see below).
A filter that passes the self-test and then dies mid-session closes the pipe.
What the bundled app-server does after that has not been verified; it may get
SIGPIPE or a write error and be respawned by Desktop through the same launcher.
The filter's passthrough mode limits this to an exit/crash case: a rewrite exception
passes its line through, and an unexpected rewrite-machinery failure switches the
remaining stream to raw bytes.

The experiment depends on the bundled binary path, the app honoring
`CODEX_CLI_PATH`, and current RPC field shapes. Updates may change these. A moved
or removed OpenCodex installation fails the launcher preflight and runs the
original binary. Run `ocx chatgpt launch` again after relocating the installation.
If an app update moves or removes the bundled app-server binary itself, the
launcher cannot start it: it prints a message naming `ocx chatgpt launch` and
`ocx chatgpt restore` on stderr and exits, and Desktop cannot start its
app-server until you run one of them. A single output line longer than 8 MiB is
passed through unparsed rather than buffered.

This standalone shim does not rewrite conversation metadata or route model calls.
Other app gates or upstream refusals can still prevent sending. Evidence reported
on an exhausted Plus account also used an intercept, so it does not establish
that this shim alone resolves every desktop send lock.

## Local-CA TLS intercept (experimental candidate)

The separate `chatgptDesktop.unblockSend` experiment terminates TLS for the
`chatgpt.com` apex host on loopback, relays the account's cookies and credentials,
and rewrites known quota send gates in conversation metadata and usage responses.
It is **off by default**, macOS only, and independent of `appServerShim`:

```json
{
  "chatgptDesktop": {
    "unblockSend": true,
    "port": 10300
  }
}
```

`port` is optional; its default is the running proxy's public port plus 200
(`10100` → `10300`). A derived port outside the TCP range requires an explicit
free port. Client-role processes do not start the intercept. A bind or certificate
failure warns without stopping the proxy's other services.

Start OpenCodex with this config, then run `ocx chatgpt status`. The listener
creates or reuses the local authority shared with the Claude intercept. **You
must trust this CA yourself** in the macOS login keychain before launching the
intercepted app. Status prints the exact command; with the default config path:

```bash
security add-trusted-cert -r trustRoot -p ssl -k "$HOME/Library/Keychains/login.keychain-db" "$HOME/.opencodex/claude-intercept/ca.pem"
ocx chatgpt launch
ocx chatgpt status
```

Use the certificate path reported by status if your OpenCodex home differs. The
CLI prints the trust command and never runs it. Trusting a local CA changes the
login keychain's TLS trust: anyone controlling its private key can issue trusted
certificates. The listener sees the decrypted account traffic, including cookies,
authorization headers and message content that it relays. Protect the config
directory and CA key. The relay does not log request bodies or credentials.
`restore` removes launch overrides; it does **not** remove CA trust or delete the
shared authority. Remove trust manually through Keychain Access when you no
longer need it, accounting for other integrations using the same authority.

Launch restarts ChatGPT with
`--host-resolver-rules=MAP chatgpt.com 127.0.0.1:<port>`. Explicit system HTTP/SOCKS
proxies get an apex-host bypass while other hosts retain the proxy with a direct
fallback; TUN/direct networking needs only the resolver rule. An existing system
PAC cannot be combined with that bypass. When cloud networking is also enabled,
OpenCodex instead wraps the PAC with DIRECT exceptions for chatgpt.com and the
cloud hostname while retaining the resolver rule. Without cloud networking or
PAC fallback, a system PAC may prevent the intercept from seeing traffic.
With `pacFallback` (below), the app uses the generated PAC instead of the resolver rule.

If both flags are true, `ocx chatgpt launch` applies the existing app-server shim
and the intercept together. The shim alone still works without a running proxy.
The intercept requires OpenCodex's identity-confirmed listener. When OpenCodex
stops, an app still carrying the resolver rule cannot reach `chatgpt.com`; run
`ocx chatgpt restore` to relaunch with native networking, or use PAC fallback.

### PAC fallback: keep the app working when OpenCodex stops

PAC fallback launches the app with a generated PAC script instead of the resolver
rule, so the app falls back on its own. The script is passed inline (a `data:` URL)
because the app ignores a `file://` PAC and an `http://` one would need OpenCodex
running to be fetched:

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` only takes effect together with `unblockSend`. Config diagnostics
warn when PAC fallback is enabled on its own; the saved flags are left unchanged.
OpenCodex normally also listens on the listener port plus one (`10301` by default),
or port `65534` when the listener uses `65535`. This CONNECT entry splices onto the
TLS listener. OpenCodex rewrites `chatgpt-unblock.pac` in its home
directory at every start, before the `chatgpt-unblock.ready` marker. Before restarting an
app, the launcher prepares the PAC argument; if the file cannot be read and encoded,
is empty, or is not a regular file, it leaves the running app untouched. The PAC sends
`chatgpt.com` to that entry first. With `cloudNetwork` enabled, its fixed cloud
hostname uses DIRECT to reach the helper's hosts mapping. The remaining hosts
follow the system route:

| Setup | Other hosts, and `chatgpt.com` while OpenCodex is stopped |
|---|---|
| No proxy, or VPN in TUN mode | Direct. |
| VPN in system-proxy mode | The system proxy, then direct. |
| PAC file | The system PAC, embedded in the generated file. |

When OpenCodex stops, the app keeps working on that route without a restart; only
the send unblock pauses until OpenCodex is back. The route is captured at startup
and refreshed by explicit launch or watcher installation: after changing the VPN
mode, run `ocx chatgpt launch`. If a system PAC is set but cannot be read, or
is too large to pass to the app (the PAC travels inside one launch argument,
limited to 512 KiB once encoded), other hosts follow the system proxy, if there is
one, then go direct; startup reports this fallback with a warning. After turning `pacFallback` on
or off, restart OpenCodex, run `ocx chatgpt launch`, and run
`ocx chatgpt install-watcher` again if you use the watcher. `restore` undoes a PAC
launch the same way as a resolver-rule one.

### Intercept rewrite boundary

Only `/backend-api/conversation/init`, `/backend-api/conversation` and
`/backend-api/f/conversation` (including child paths), plus the exact
`/backend-api/wham/usage` and `/backend-api/wham/usage/stream` paths are rewritten.
Conversation metadata loses known quota `send` / `tpp_send` blocks and exhausted
send progress entries. Unknown and subscription/policy/workspace reasons remain;
status reports preserved reasons. Usage rewriting reuses the shim's gate helpers,
keeping workspace, credit and spend-control gates and usage display intact. Other
HTTP responses pass through; WebSocket upgrades, voice and dictation relay
without rewriting through direct, HTTP CONNECT or shared SOCKS5 transport.

### Optional intercept launch watcher

```bash
ocx chatgpt install-watcher --yes
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

Installation without `--yes` asks in an interactive terminal. The launchd agent
watches the app's Electron `SingletonLock` and the `chatgpt-unblock.ready` marker. In watch
mode, it restarts an app launched without intercept switches only while the listener answers as
OpenCodex and the app is no more than five minutes old; a missing or unparseable process age
counts as fresh, and explicit `ocx chatgpt launch` is not age-limited. This can interrupt
startup work; it does nothing while the listener is unavailable. It manages
**intercept launches** and preserves the cloud routing and shim settings captured
at installation. Run an explicit `ocx chatgpt launch` first to prepare the shim;
the watcher carries its `CODEX_CLI_PATH` only while that launcher exists and is
executable. It does not install a shim or act as a cloud-only launch watcher. A loaded
watcher must be uninstalled before `restore`, so it cannot put the switches back.
In PAC-fallback mode the watcher also waits for the CONNECT entry and launches
with the PAC switch instead of the resolver rule.

### Evidence and decision limits

[#6196](https://github.com/lidge-jun/opencodex/issues/6196) reported zero established
listener connections over about 20 hours on current Desktop builds: the bundled
app-server performs the gate reads and may bypass Chromium's resolver rule.
The later exhausted-Plus-account report used the shim, intercept and restart
together and does not isolate the intercept's effectiveness. This candidate
conflicts with the maintainer's provider-aware admission design, which rejects
local CA installation and quota-data rewriting; maintainers may close it.
