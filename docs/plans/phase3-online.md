# Phase 3 — 線上多人 v1 規格

狀態：v1 已實作（2026-10-10；瀏覽器以本機測試兩個視窗實測過；見 progress.md）。使用者決策：WebRTC 點對點、**房主運算**（host-authoritative）、2–4 名真人 + AI 補位、房間代碼配對、配對伺服器用 **Cloudflare Workers + Durable Objects**（程式放 `server/`；**部署前必須先問使用者**）、客戶端自己的車做本機預測。第一版範圍：一場大獎賽週末（練習／排位／正賽）。

## 0. 原則

- **網路無關的核心**：協定編解碼、房間狀態機、輸入鎖存、快照插值、鏡像世界（mirror world）更新、斷線接管全部寫成純邏輯，可在 bun 測試中用**記憶體內傳輸（loopback transport）**完整測試；WebRTC／WebSocket 只是薄薄的傳輸層實作（bun 沒有 RTCPeerConnection，這層無法在 CI 測，要寫得非常簡單）。
- 房主跑完整 `stepWorld`（含 AI）；客戶端**不跑**其他車的物理。
- 既有單機／分割畫面行為不得改變（所有既有測試照常通過）。
- 決定性仍然重要：房主決定 `SessionConfig.seed` 並分享整份 config。
- `src/core/*` 只增加：`playerIndex` 由 `0 | 1` 擴大為 `0 | 1 | 2 | 3`（`PlayerIndex` 型別）、新增欄位皆可省略。
- 不在程式碼中寫死任何金鑰；配對伺服器網址由 `import.meta.env.VITE_SIGNAL_URL`（建置時）或設定畫面輸入。

## 1. 配對伺服器（`server/`，Cloudflare Workers + Durable Objects）

- `server/src/index.ts`（Worker）：`POST /rooms` → 建立房間、回傳 6 字元代碼（字母表排除易混淆字元 `0O1IL`）；`GET /rooms/:code/ws`（WebSocket upgrade）→ 轉給該房間的 Durable Object。
- `server/src/room.ts`（Durable Object `Room`）：成員清單（host + 最多 3 位客人）、轉送 `offer` / `answer` / `ice` / `leave` 訊息（只做轉送，不碰遊戲資料）、房主離開 → 通知所有人並關房、閒置 10 分鐘自動關閉、滿員拒絕、代碼不存在 404。
- **房間邏輯寫成純函式** `server/src/roomLogic.ts`（狀態 + 訊息 → 新狀態 + 要送出的訊息），由 `tests/net.room.test.ts` 測試（bun 直接 import server/src 的純檔案）。
- `server/wrangler.toml`、`server/tsconfig.json`、`server/package.json`（`wrangler` 為 devDependency），`server/README.md`（zh-TW 部署步驟：`bunx wrangler login`、`bunx wrangler deploy`、把網址填進 `VITE_SIGNAL_URL`）。根目錄的 `tsconfig.json`／vite 建置不包含 `server/`，GitHub Pages 部署流程不變。
- **本機開發替代**：`src/net/signal/broadcast.ts` 用 `BroadcastChannel` 當配對通道（同一台電腦、同一個網址開兩個分頁即可連線，不需要伺服器），設定畫面可選「本機測試（同一台電腦的分頁）」。

## 2. 用戶端網路層（新目錄 `src/net/`）

- `transport.ts`：介面 `NetTransport { send(channel: 'state' | 'reliable', data: ArrayBuffer | string): void; onMessage; onClose; close() }`，`state` 通道 = 不保證順序、不重送（WebRTC `ordered: false, maxRetransmits: 0`），`reliable` = 有序可靠。`loopback.ts` 提供記憶體內實作（可設定延遲、掉包率、重複、亂序，用決定性種子），供測試使用。
- `signal/`：`SignalClient` 介面 + `cloudflare.ts`（WebSocket 到 Worker）+ `broadcast.ts`（BroadcastChannel）。
- `peer.ts`：WebRTC 包裝（`RTCPeerConnection`，STUN：`stun:stun.cloudflare.com:3478`、`stun:stun.l.google.com:19302`；建立兩個 data channel；把它包成 `NetTransport`）。不提供 TURN（說明：嚴格 NAT 可能連不上）。
- `protocol.ts`：
  - **輸入封包**（客→主，`state` 通道，60 Hz）：`seq`（uint16 環繞）、`tick`、量化的 throttle / brake（uint8）、steer（int8）、按鈕位元（overtakeHeld）、**一次性動作計數器**（shiftUp / shiftDown / drsPressed / ersCycle / limiterToggle 各一個 uint8 累計計數；房主比較計數差值觸發，所以掉包不會漏、重複封包不會重複觸發）。最近 3 筆輸入冗餘附帶以抗掉包。
  - **快照封包**（主→客，`state` 通道，30 Hz；2026-10-30 起拆成「全車畫面」與「接收者自車狀態（float64）」兩個各自一個封包的訊息，見 docs/FEATURES.md §3.13）：`tick`、世界時間、每台車的量化渲染狀態（參考 `src/app/replay.ts` 的打包欄位，加上 `groundPitch`、安全車位姿、賽事管制旗號），以及「接收者自己那台車」的完整物理狀態子集（位置、速度、yaw、yawRate、gear、rpm、轉向角、ERS、輪胎溫度／磨耗、limiter…）和**最後處理的輸入 seq**（供預測回放）。
  - **可靠訊息**（JSON）：大廳（加入、玩家資料：名稱、車隊／車手選擇、設定、輔助、準備）、開賽（完整 `SessionConfig` + 玩家席位對應）、事件（`GameEvent` 加序號，客戶端依序號去重）、指令（進站請求／取消、ERS 模式、退賽）、HUD 鏡像狀態（5 Hz：計時、名次、進站、罰則、輪胎、旗號、天氣、session 狀態）、節次結束／成績、下一節、房主暫停／繼續、斷線通知。
  - 所有編解碼都要有往返測試與壞封包防護（長度不符、NaN → 丟棄）。
- `host.ts`：`HostSession` —— 包住本機 `SessionRuntime`（或其世界步進）；每個遠端玩家一個輸入緩衝（依 seq 排序、套用最新、計數差觸發一次性動作）；固定步長時把遠端輸入放進 `inputs[playerIndex]`；30 Hz 廣播快照、5 Hz HUD 鏡像、事件立即可靠送出；處理指令（呼叫現有 `requestPit` / `cancelPit` / `setErsMode` / `retireCar`）。
- `client.ts`：`ClientSession` —— 用房主給的 `SessionConfig` 在本機 `createWorld` 建一個**鏡像世界**（不步進 AI／他車），每個快照更新鏡像中各車的位姿與渲染欄位、HUD 鏡像更新計時／名次等欄位；渲染用 100 ms 插值緩衝的 `RenderFrame`；**自己的車**：保留未確認輸入，收到權威狀態後從該狀態用 `stepCarPhysics` 回放未確認輸入（本機預測 + 校正），誤差用平滑修正（> 3 m 直接瞬移）。HUD／音效／場景沿用現有程式（讀鏡像世界與 RenderFrame）。

## 3. Session／App 整合

- `SessionRuntime` 加模式：`local`（現狀）、`host`、`client`。`host`／`client` 時：**停用回溯**、暫停只由房主觸發並廣播（客戶端按暫停只開本機選單、不停世界）、切到背景分頁不自動暫停世界、正賽所有真人完賽後由房主快轉並送成績、客戶端不自己快轉。
- 玩家編號擴大到 4：`isHuman`、`playerCarIds`、`inputs` 陣列、`getPlayerCarId` 等依 `PlayerIndex` 運作；每台電腦只有一個本機視角（線上模式不與分割畫面混用）。
- **斷線**：客人斷線 → 房主把該車改由 AI 駕駛（沿用 AI 控制器，車名旁標示「AI 代駕」），比賽繼續；房主斷線 → 客戶端顯示「房主已離線」並回到主選單；重連不在 v1 範圍。
- 週末流程：房主依 `weekendQueue` 推進節次，每節開始送新 config；排位結果決定正賽起跑順序（房主算）。

## 4. 選單（`src/ui/menus/**`）

- 主選單新增「線上多人」→ `OnlineScreen`：建立房間／加入房間（輸入代碼）／配對方式（Cloudflare 伺服器網址或「本機測試」）。未設定伺服器網址時說明如何設定。
- `LobbyScreen`：房間代碼（可複製）、玩家清單（名稱、車隊／車手、準備狀態、延遲 ms）、房主的賽事設定（賽道、圈數、天氣、AI 數量與難度、規則年份、週末賽制、規則）、每位玩家選車隊／車手（不可重複）、賽車設定與輔助（各自本機）、準備／開始（全員準備後房主可開始）、離開。
- 斷線、房間已滿、代碼錯誤、連線失敗（可能是 NAT）都有清楚的 zh-TW 訊息。

## 5. 測試（bun；不需要瀏覽器）

- `tests/net.protocol.test.ts`：輸入／快照／可靠訊息編解碼往返、量化誤差界限、壞封包丟棄、一次性動作計數器在掉包／重複／亂序下恰好觸發一次。
- `tests/net.room.test.ts`：房間純邏輯（建立、加入、滿員、轉送、房主離開關房、閒置）。
- `tests/net.session.test.ts`：用 loopback（含延遲 80 ms、掉包 5%、亂序）連接 1 個 HostSession + 2 個 ClientSession 跑一場短正賽：客戶端輸入確實驅動房主上的對應車輛、鏡像世界的車輛位置與房主差距在插值容忍內、事件不漏不重、進站指令有效、客人斷線 → AI 接管且比賽完成、所有人收到相同成績、本機預測的自車誤差有界。
- 既有測試全部通過（玩家編號擴大不影響單機與分割畫面）。

## 6. 文件

`docs/FEATURES.md` 1.3 多人列（線上多人 ✅/🟡、LAN 說明、限制：無 TURN、無反作弊、無重連）、新增「線上多人」章節（架構、頻寬估計、操作方式）；`docs/SPEC.md`（模組表新增 net、server）；`server/README.md`；`README.md` 加一段如何開本機測試與部署配對伺服器；`progress.md` 追加紀錄。
