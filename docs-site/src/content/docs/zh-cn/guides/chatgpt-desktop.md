---
title: ChatGPT 桌面版发送键解锁
description: 账号用量额度用完时，让 ChatGPT 桌面版的输入框保持可用（macOS，需手动开启）。
---

登录的 ChatGPT 账号用完用量额度后，ChatGPT 桌面版会把发送按钮置灰，即使该对话的模型调用由
opencodex 路由到其他提供商。这个需手动开启的 macOS 集成可以让输入框保持可用，默认关闭。

## 它改变了什么

opencodex 为 `chatgpt.com` 运行一个本地 TLS 监听器。app 启动时会带上一个 Chromium 参数，
把 `chatgpt.com` 指向这个监听器；其他所有域名（包括它的子域名）都保持原来的路径。请求会带着
app 自己的凭据转发到真正的 `chatgpt.com`，WebSocket（例如语音听写）也会一并转发。不记录、
不存储任何内容。

除以下两个接口外，所有响应都原样透传：

- 对话元数据（`/backend-api/conversation/init` 和对话流）：去掉由用量额度导致的发送锁；
- 用量快照（`/backend-api/wham/usage`）：打开“已达上限”的开关。

其他原因的发送锁（例如需要订阅）会保留，并在 `ocx chatgpt status` 中列出。显示的用量
（百分比、重置时间、横幅）不会被修改，OpenAI 服务器仍会对其自身的请求执行所有限制。

在某些版本上，发送按钮跟随的是 app 内置 Codex 服务器报告的账户状态，而这个服务器用自己的 HTTP 客户端
获取这些信息，解析规则和 PAC 文件都管不到它。这种情况由下文的实验性 app-server 中间层处理。

## 设置

1. 在 `~/.opencodex/config.json` 中开启该功能，然后重启 opencodex：

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   监听器使用代理端口加 200（默认 `10300`）。设置 `chatgptDesktop.port` 可以换用其他端口。

2. 信任本地证书颁发机构（只需一次）。该命令会要求输入登录密码，请自己运行：

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   没有这项信任，app 无法加载账户、用量和设置页面。如果你使用了自定义的 opencodex 目录，
   `ocx chatgpt status` 会打印适合你环境的准确命令。

3. 通过 opencodex 启动 app：

   ```bash
   ocx chatgpt launch
   ```

4. 可选：让普通的 Dock 和聚焦搜索启动也使用该路径：

   ```bash
   ocx chatgpt install-watcher
   ```

   watcher 在 app 每次启动时运行，opencodex 启动时也会运行一次。如果 app 是以普通方式打开的，它会在
   启动后立即退出 app 并带上路径重新打开。登录时如果 app 比 opencodex 先打开，它会在 opencodex 运行
   起来后立即这样做。为了不把你已经用了一阵的 app 关掉，它只重启最近五分钟内启动的 app（读不到启动时
   长时按刚启动处理）；`ocx chatgpt launch` 则不管启动了多久都会重启。opencodex 未运行时它什么都不做。
   该命令会请求确认；`--yes` 可以非交互式确认。

## 网络环境

不需要配置任何 VPN 或代理规则。默认模式下，每次 app 启动时，都会根据系统代理选择启动参数：

| 环境 | app 的启动参数 |
|---|---|
| 无代理 | 只有 `chatgpt.com` 路径。 |
| VPN 系统代理模式 | 路径、带直连回退的系统代理，以及只针对 `chatgpt.com` 的绕过。 |
| VPN TUN 模式 | 只有路径；本机回环流量不会进入隧道。 |
| PAC 文件 | 只有路径。PAC 文件可能让 `chatgpt.com` 继续走代理，输入框因此可能仍被锁定，但其他功能不受影响。 |

opencodex 通过自己的 `proxy` 设置访问真正的 `chatgpt.com`，与它的其他出站流量一致。

## opencodex 停止后仍能使用 app

默认模式下，已接管的 app 依赖监听器：opencodex 停止期间，它对 `chatgpt.com` 的请求都会失败。PAC 回退
改为用生成的 PAC 文件启动 app，让 app 自行回退：

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` 只有与 `unblockSend` 同时开启才生效。此时 opencodex 还会在监听器端口加一（默认 `10301`）
上监听，并在每次启动时重写主目录下的 `chatgpt-unblock.pac`。PAC 先把 `chatgpt.com` 发给 opencodex，
其他主机则按系统的路由走：

| 环境 | 其他主机，以及 opencodex 停止期间的 `chatgpt.com` |
|---|---|
| 无代理，或 VPN TUN 模式 | 直连。 |
| VPN 系统代理模式 | 系统代理，然后直连。 |
| PAC 文件 | 系统 PAC（嵌入生成的文件中）。 |

opencodex 停止后，app 无需重启就会沿这条路由继续工作；只有发送解锁会暂停，直到 opencodex 恢复。路由在
opencodex 启动时读取：切换 VPN 模式后，请重启 opencodex 并运行 `ocx chatgpt launch`。如果当时设置了系统
PAC 却读取不到，或者大到无法传给 app（PAC 是放在一个启动参数里传过去的，编码后限制在 512 KiB 以内），其
他主机会先走系统代理（如果有），再直连，opencodex 会打印警告。

开启或关闭 `pacFallback` 后，请重启 opencodex、运行 `ocx chatgpt launch`；如果在用 watcher，还要重新运行
`ocx chatgpt install-watcher`。

## app-server 中间层（实验性）

中间层过滤内置 Codex 服务器的 JSON-RPC 输出，只放开已知的普通额度锁。它不会增加账户额度，也不会让上
游服务接受它拒绝的请求。它仅支持 macOS，默认关闭，有两种用法：

- **单独使用。** 设置 `{ "chatgptDesktop": { "appServerShim": true } }`，然后运行
  `ocx chatgpt launch`。opencodex 会在它的目录里写一个可执行的启动脚本，ChatGPT 在运行时先把它退出，
  再用 `open -a <bundle> --env CODEX_CLI_PATH=<launcher>` 重新打开。app 是按 bundle 标识
  `com.openai.codex` 找到的，所以装在 `~/Applications` 或其他磁盘上也能用，名字同样叫“ChatGPT”的其他
  app 绝不会被退出或打开。app 会重启，请先保存手头的工作。不需要 opencodex 代理在运行。从 Dock 或
  Spotlight 正常打开不会带上中间层。`ocx chatgpt restore` 会删除启动脚本，并不带该变量重新打开 app。
- **和发送解锁一起用。** `unblockSend` 和 `appServerShim` 都开启时，opencodex 每次启动都会准备好启动
  脚本，`ocx chatgpt launch` 和 watcher 都会通过它启动 app。如果下文的检查拒绝了这个 bundle，
  opencodex 会打印警告，拦截照常工作，只是不带中间层。

只处理 `account/rateLimits/updated` 通知，以及顶层结果里含有 `rateLimits`、`rateLimitsByLimitId` 或
`ordinaryUsageAllowed` 的回复。普通额度的 `rate_limit_reached` 标记会被清除；锁的标志（`allowed`、
`limit_reached` / `limitReached`、`ordinaryUsageAllowed`）只有在看到普通额度用尽的证据时才会放开：也
就是这个标记，或者某个用到 100% 的窗口。回复里看不出原因的锁保持关闭，工作区、点数、未知原因和消费上
限造成的限制也保持关闭。显示的用量保持原样，其他消息逐字节原样通过。标准输入、标准错误和原程序的退出
码都和 app 直接相连。

写启动脚本之前，opencodex 会检查 bundle 和其中的 app-server 程序：属于你本人或 root，组和其他用户不
可写，并且能以 OpenAI 的团队 ID（`2DC432GLL2`）通过严格的代码签名校验。任何一项不满足都会被拒绝。启
动脚本的权限是 `0755`，内嵌当前的 opencodex 程序路径，先写到临时文件再改名替换，所以该位置上的符号链
接会被替换，而不会被顺着写过去。请把启动脚本、它所在的目录和 opencodex 的安装位置都放在自己的控制之
下：改动这些路径，就等于改变了 app 运行的代码。

不是 macOS、找不到 opencodex 的运行环境，或者过滤器自检失败时，启动脚本会直接运行原程序，输出不做任
何改动。如果 app 更新后 app-server 程序本身被移动或删除，启动脚本会打印一条提示 `ocx chatgpt launch`
和 `ocx chatgpt restore` 的信息后退出，在你运行其中一条之前，app 无法启动它的服务器。过滤器通过自检
后如果在会话中途退出，服务器的输出管道会被关闭，之后 app 会怎样尚未验证。单行超过 8 MiB 的输出不解析，
原样通过。中间层依赖 app 遵守 `CODEX_CLI_PATH` 以及当前的消息格式，这些都可能随更新变化。

## 查看状态

```bash
ocx chatgpt status
```

它会报告：功能是否开启、端口上的监听器是否属于 opencodex、证书是否受信任、watcher 状态、运行中的 app
是否带有路径，以及被有意保留的发送锁。开启 app-server 中间层后，它还会显示启动脚本是否存在，以及当前
运行的 app 是否通过它启动。

## 关闭

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore` 会以原生网络重新打开已接管的 app。之后把 `chatgptDesktop.unblockSend` 设为 `false` 并重启
opencodex。该证书颁发机构与 opencodex 的 Claude 集成共用；只有两者都不使用时才移除它的信任。
`restore` 也会不带 app-server 中间层重新打开 app，并删除它的启动脚本；同时把 `appServerShim` 也设为
`false`。

## 故障排查

- **账户、用量或设置页面加载不出来：** 证书未受信任。重新执行第 2 步；`ocx chatgpt status`
  会显示信任状态。
- **发送按钮仍是灰色：** 查看 `ocx chatgpt status`。app 可能没有带着路径运行（运行
  `ocx chatgpt launch`），或者锁的原因不是用量额度，会列在 “send blocks kept” 下。
- **路径正常但发送按钮仍是灰色：** 锁可能来自内置的 Codex 服务器，而不是路径覆盖的页面。开启
  `chatgptDesktop.appServerShim`，运行 `ocx chatgpt launch`，再查看 `ocx chatgpt status`
  （“app-server shim” 这一行会显示当前 app 是否是通过它启动的）。如果 opencodex 启动时警告中间层没有
  准备好，或者 `launch` 拒绝了它，提示里会写明 bundle 没通过哪一项检查。
- **opencodex 停止后 app 什么都加载不出来：** 默认模式下，已接管的 app 依赖监听器。重新启动 opencodex，
  或运行 `ocx chatgpt restore`；开启 PAC 回退后，app 会自行回退。
