---
title: ChatGPT 桌面版傳送鍵解鎖
description: 帳號用量額度用完時，讓 ChatGPT 桌面版的輸入框保持可用（macOS，需手動開啟）。
---

登入的 ChatGPT 帳號用完用量額度後，ChatGPT 桌面版會把傳送按鈕變灰，即使該對話的模型呼叫由
opencodex 路由到其他供應商。這個需手動開啟的 macOS 整合可以讓輸入框保持可用，預設關閉。

## 它改變了什麼

opencodex 為 `chatgpt.com` 執行一個本機 TLS 監聽器。app 啟動時會帶上一個 Chromium 參數，
把 `chatgpt.com` 指向這個監聽器；其他所有網域（包括它的子網域）都維持原本的路徑。請求會帶著
app 自己的憑證轉發到真正的 `chatgpt.com`，WebSocket（例如語音聽寫）也會一併轉發。不記錄、
不儲存任何內容。

除以下兩個端點外，所有回應都原樣透傳：

- 對話中繼資料（`/backend-api/conversation/init` 與對話串流）：移除由用量額度造成的傳送鎖；
- 用量快照（`/backend-api/wham/usage`）：打開「已達上限」的開關。

其他原因的傳送鎖（例如需要訂閱）會保留，並在 `ocx chatgpt status` 中列出。顯示的用量
（百分比、重置時間、橫幅）不會被修改，OpenAI 伺服器仍會對其自身的請求執行所有限制。

在某些版本上，傳送按鈕跟隨的是 app 內建 Codex 伺服器回報的帳戶狀態，而這個伺服器用自己的 HTTP 用戶端
取得這些資訊，解析規則和 PAC 檔案都管不到它。這種情況由下文的實驗性 app-server 中介層處理。

## 設定

1. 在 `~/.opencodex/config.json` 中開啟此功能，然後重新啟動 opencodex：

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   監聽器使用代理連接埠加 200（預設 `10300`）。設定 `chatgptDesktop.port` 可改用其他連接埠。

2. 信任本機憑證授權單位（只需一次）。此指令會要求輸入登入密碼，請自行執行：

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   沒有這項信任，app 無法載入帳戶、用量和設定頁面。如果你使用自訂的 opencodex 目錄，
   `ocx chatgpt status` 會列出適合你環境的準確指令。

3. 透過 opencodex 啟動 app：

   ```bash
   ocx chatgpt launch
   ```

4. 選用：讓一般的 Dock 與 Spotlight 啟動也使用該路徑：

   ```bash
   ocx chatgpt install-watcher
   ```

   watcher 在 app 每次啟動時執行，opencodex 啟動時也會執行一次。如果 app 是以一般方式開啟的，它會在
   啟動後立即結束 app 並帶上路徑重新開啟。登入時如果 app 比 opencodex 先開啟，它會在 opencodex 執行
   起來後立即這樣做。為了不把你已經用了一陣子的 app 關掉，它只重新啟動最近五分鐘內啟動的 app（讀不到
   啟動時長時按剛啟動處理）；`ocx chatgpt launch` 則不管啟動了多久都會重新啟動。opencodex 未執行時它
   什麼都不做。此指令會要求確認；`--yes` 可以非互動式確認。

## 網路環境

不需要設定任何 VPN 或代理規則。預設模式下，每次 app 啟動時，都會依系統代理選擇啟動參數：

| 環境 | app 的啟動參數 |
|---|---|
| 無代理 | 只有 `chatgpt.com` 路徑。 |
| VPN 系統代理模式 | 路徑、帶直連備援的系統代理，以及只針對 `chatgpt.com` 的略過。 |
| VPN TUN 模式 | 只有路徑；本機回送流量不會進入通道。 |
| PAC 檔案 | 只有路徑。PAC 檔案可能讓 `chatgpt.com` 繼續走代理，輸入框因此可能仍被鎖定，但其他功能不受影響。 |

opencodex 透過自己的 `proxy` 設定連到真正的 `chatgpt.com`，與它的其他對外流量一致。

## opencodex 停止後仍能使用 app

預設模式下，已接管的 app 依賴監聽器：opencodex 停止期間，它對 `chatgpt.com` 的請求都會失敗。PAC 備援
改為用產生的 PAC 檔案啟動 app，讓 app 自行切換回原本的路由：

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` 只有與 `unblockSend` 同時開啟才生效。此時 opencodex 還會在監聽器連接埠加一（預設 `10301`）
上監聽，並在每次啟動時重寫主目錄下的 `chatgpt-unblock.pac`。PAC 先把 `chatgpt.com` 送給 opencodex，
其他主機則依系統的路由走：

| 環境 | 其他主機，以及 opencodex 停止期間的 `chatgpt.com` |
|---|---|
| 無代理，或 VPN TUN 模式 | 直連。 |
| VPN 系統代理模式 | 系統代理，然後直連。 |
| PAC 檔案 | 系統 PAC（嵌入產生的檔案中）。 |

opencodex 停止後，app 不需重新啟動就會沿這條路由繼續運作；只有傳送解鎖會暫停，直到 opencodex 恢復。路由在
opencodex 啟動時讀取：切換 VPN 模式後，請重新啟動 opencodex 並執行 `ocx chatgpt launch`。如果當時設定了系
統 PAC 卻讀取不到，或者大到無法傳給 app（PAC 是放在一個啟動參數裡傳過去的，編碼後限制在 512 KiB 以內），其
他主機會先走系統代理（如果有），再直連，opencodex 會印出警告。

開啟或關閉 `pacFallback` 後，請重新啟動 opencodex、執行 `ocx chatgpt launch`；如果在用 watcher，還要重新
執行 `ocx chatgpt install-watcher`。

## app-server 中介層（實驗性）

中介層過濾內建 Codex 伺服器的 JSON-RPC 輸出，只放開已知的一般額度鎖。它不會增加帳戶額度，也不會讓上
游服務接受它拒絕的請求。它僅支援 macOS，預設關閉，有兩種用法：

- **單獨使用。** 設定 `{ "chatgptDesktop": { "appServerShim": true } }`，然後執行
  `ocx chatgpt launch`。opencodex 會在它的目錄裡寫一個可執行的啟動腳本，ChatGPT 在執行時先把它結束，
  再用 `open -a <bundle> --env CODEX_CLI_PATH=<launcher>` 重新開啟。app 是依 bundle 識別碼
  `com.openai.codex` 找到的，所以裝在 `~/Applications` 或其他磁碟上也能用，名稱同樣叫「ChatGPT」的其
  他 app 絕不會被結束或開啟。app 會重新啟動，請先儲存手邊的工作。不需要 opencodex 代理在執行。從 Dock
  或 Spotlight 正常開啟不會帶上中介層。`ocx chatgpt restore` 會刪除啟動腳本，並不帶該變數重新開啟 app。
- **和傳送解鎖一起用。** `unblockSend` 和 `appServerShim` 都開啟時，opencodex 每次啟動都會準備好啟動
  腳本，`ocx chatgpt launch` 和 watcher 都會透過它啟動 app。如果下文的檢查拒絕了這個 bundle，
  opencodex 會印出警告，攔截照常運作，只是不帶中介層。

只處理 `account/rateLimits/updated` 通知，以及頂層結果裡含有 `rateLimits`、`rateLimitsByLimitId` 或
`ordinaryUsageAllowed` 的回覆。一般額度的 `rate_limit_reached` 標記會被清除；鎖的旗標（`allowed`、
`limit_reached` / `limitReached`、`ordinaryUsageAllowed`）只有在看到一般額度用盡的證據時才會放開：也
就是這個標記，或者某個用到 100% 的視窗。回覆裡看不出原因的鎖保持關閉，工作區、點數、未知原因和消費上
限造成的限制也保持關閉。顯示的用量保持原樣，其他訊息逐位元組原樣通過。標準輸入、標準錯誤和原程式的結
束碼都和 app 直接相連。

寫啟動腳本之前，opencodex 會檢查 bundle 和其中的 app-server 程式：屬於你本人或 root，群組和其他使用
者不可寫，並且能以 OpenAI 的團隊 ID（`2DC432GLL2`）通過嚴格的程式碼簽章驗證。任何一項不滿足都會被拒
絕。啟動腳本的權限是 `0755`，內嵌目前的 opencodex 程式路徑，先寫到暫存檔再改名替換，所以該位置上的符
號連結會被替換，而不會被順著寫過去。請把啟動腳本、它所在的目錄和 opencodex 的安裝位置都放在自己的控
制之下：改動這些路徑，就等於改變了 app 執行的程式碼。

不是 macOS、找不到 opencodex 的執行環境，或者過濾器自我檢測失敗時，啟動腳本會直接執行原程式，輸出不
做任何改動。如果 app 更新後 app-server 程式本身被移動或刪除，啟動腳本會印出一則提示
`ocx chatgpt launch` 和 `ocx chatgpt restore` 的訊息後結束，在你執行其中一條之前，app 無法啟動它的伺
服器。過濾器通過自我檢測後如果在工作階段中途結束，伺服器的輸出管道會被關閉，之後 app 會怎樣尚未驗證。
單行超過 8 MiB 的輸出不解析，原樣通過。中介層依賴 app 遵守 `CODEX_CLI_PATH` 以及目前的訊息格式，這些
都可能隨更新改變。

## 查看狀態

```bash
ocx chatgpt status
```

它會回報：功能是否開啟、連接埠上的監聽器是否屬於 opencodex、憑證是否受信任、watcher 狀態、執行中的
app 是否帶有路徑，以及被刻意保留的傳送鎖。開啟 app-server 中介層後，它還會顯示啟動腳本是否存在，以及
目前執行的 app 是否透過它啟動。

## 關閉

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore` 會以原生網路重新開啟已接管的 app。之後把 `chatgptDesktop.unblockSend` 設為 `false` 並重新
啟動 opencodex。此憑證授權單位與 opencodex 的 Claude 整合共用；只有兩者都不使用時才移除它的信任。
`restore` 也會不帶 app-server 中介層重新開啟 app，並刪除它的啟動腳本；同時把 `appServerShim` 也設為
`false`。

## 疑難排解

- **帳戶、用量或設定頁面載入不出來：** 憑證未受信任。重新執行第 2 步；`ocx chatgpt status`
  會顯示信任狀態。
- **傳送按鈕仍是灰色：** 查看 `ocx chatgpt status`。app 可能沒有帶著路徑執行（執行
  `ocx chatgpt launch`），或者鎖的原因不是用量額度，會列在「send blocks kept」下。
- **路徑正常但傳送按鈕仍是灰色：** 鎖可能來自內建的 Codex 伺服器，而不是路徑涵蓋的頁面。開啟
  `chatgptDesktop.appServerShim`，執行 `ocx chatgpt launch`，再查看 `ocx chatgpt status`
  （「app-server shim」這一行會顯示目前的 app 是否是透過它啟動的）。如果 opencodex 啟動時警告中介層
  沒有準備好，或者 `launch` 拒絕了它，提示裡會寫明 bundle 沒通過哪一項檢查。
- **opencodex 停止後 app 什麼都載入不出來：** 預設模式下，已接管的 app 依賴監聽器。重新啟動 opencodex，
  或執行 `ocx chatgpt restore`；開啟 PAC 備援後，app 會自行切換回原本的路由。
