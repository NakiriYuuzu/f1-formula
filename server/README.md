# 配對伺服器（Cloudflare Workers + Durable Objects）

線上多人模式用的配對（signalling）伺服器。它只負責：

- 建立房間並發 6 碼房間代碼（不含容易混淆的 `0 O 1 I L`）；
- 在同一個房間的玩家之間轉送 WebRTC 連線資料（offer / answer / ICE）。

比賽資料不經過這台伺服器：玩家之間用 WebRTC 點對點連線，由房主的電腦模擬整場比賽。

| 路徑 | 說明 |
|---|---|
| `POST /rooms` | 建立房間，回傳 `{ "code": "K7MPQ2" }` |
| `GET /rooms/:code/ws` | WebSocket 進入房間；代碼不存在回 404 |
| `GET /health` | 健康檢查 |

房間規則（`src/roomLogic.ts`，純函式，`tests/net.room.test.ts` 測試）：第一個連線的人是房主、最多 4 人（房主 + 3）、滿員拒絕、房主離開就關閉房間、閒置 10 分鐘自動關閉。

## 部署

需要 Cloudflare 帳號（免費方案即可使用 Durable Objects 的 SQLite 儲存後端；若帳號不支援，請改用付費方案）。

```sh
cd server
bun install
bunx wrangler login      # 瀏覽器登入 Cloudflare
bunx wrangler deploy     # 部署；完成後會顯示網址，例如 https://formula-nova-signal.<帳號>.workers.dev
```

只允許自己的網站建立房間（選用）：在 `wrangler.toml` 的 `[vars]` 把 `ALLOWED_ORIGINS` 設成遊戲網址，例如
`"https://<帳號>.github.io"`，再部署一次。

本機試跑：`bunx wrangler dev`（預設 `http://localhost:8787`）。

## 讓遊戲使用這台伺服器

擇一：

1. **建置時設定**：在專案根目錄建置前設定環境變數 `VITE_SIGNAL_URL`，例如
   `VITE_SIGNAL_URL=https://formula-nova-signal.<帳號>.workers.dev bun run build`。GitHub Pages 的部署流程可以在
   workflow 的 build 步驟加上這個環境變數。
2. **遊戲內設定**：主選單 → 線上多人 → 配對方式選「配對伺服器」，把網址貼到「配對伺服器網址」。

不部署也能測試：配對方式選「本機測試（同一台電腦的分頁）」，在同一個瀏覽器開兩個分頁，一個建立房間、另一個輸入代碼加入。

## 已知限制

- 只有公開 STUN（Cloudflare、Google），沒有 TURN 中繼：部分嚴格 NAT（例如某些行動網路、公司網路）可能連不上。
- 沒有帳號與反作弊；房間代碼就是唯一的門檻。
- 斷線後不能重新加入同一場比賽（房主斷線則整個房間關閉）。
