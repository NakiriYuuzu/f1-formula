# FORMULA NOVA 25｜新星方程式 25

在瀏覽器裡就能玩的開輪方程式賽車遊戲。玩法類型參考商業賽車遊戲常見的模式（單場大獎賽、計時賽、車手生涯、車隊經營、劇情、分割畫面）。
車隊、車手、塗裝與劇情都是原創：10 支虛構車隊、26 位虛構車手、原創劇情。賽道共 18 條（每條都可反向，共 36 種佈局）：
**13 條依真實 F1 賽道佈局重現**（2025 賽曆的上海、鈴鹿、巴林、摩納哥、銀石、斯帕、蒙札、新加坡、奧斯汀、英特拉格斯、拉斯維加斯、亞斯濱海，以及昔日分站馬來西亞雪邦，以地名命名），
加上 5 條原創虛構賽道。賽車外形依 FIA 2025／2026 技術規則重現通用的現代 F1 賽車。3D 模型、貼圖與音效全部由程式即時生成，執行期沒有任何外部資產。

> **聲明**：本作是非商業的同人作品，與任何真實賽車系列、賽事主辦單位、賽道、車隊、車手、贊助商或遊戲發行商都沒有關聯，
> 也沒有取得授權或背書；不使用任何官方標誌、贊助商或品牌名稱，地標一律以泛稱的通用建築呈現。遊戲中的 DRS、ERS 等詞彙為一般賽車術語。
> 真實賽道的中心線取自 © OpenStreetMap contributors（ODbL），高程取自 EU-DEM、USGS NED 與 SRTM（經 OpenTopoData）。

完整內容清單（與 F1 25 的功能對照、場景、玩法、模型、建模方法、賽道與車隊資料、測試結果、已知限制）請見
[`docs/FEATURES.md`](docs/FEATURES.md)；實作規格見 [`docs/SPEC.md`](docs/SPEC.md)。

## 內容一覽

- **9 個主選單項目**：大獎賽、計時賽（幽靈車 + 本機排行）、車手生涯（真實賽曆 12 站或原創賽道 10 站）、我的車隊（第 11 隊、研發與資金）、
  新星之路（6 章劇情 + 6 個挑戰賽）、雙人分割畫面、設定、成就（12 項）、製作名單。
- **兩種規則年份**：2025 規則（DRS）與 2026 規則（車更小更輕、直線模式主動空力、Overtake 加力）。
- **駕駛模擬**：動態自行車模型、5 種輪胎配方（磨耗、溫度、溼地）、ERS 4 種模式、DRS、動態天氣與積水、進站、賽道界線罰則、車損、回溯、賽後重播、6 種鏡頭。
- **介面**：全部為繁體中文；滑鼠、鍵盤、Gamepad 與觸控皆可操作節次（手把可操作暫停選單）。手機（橫向）與平板可以用觸控玩，見下方「手機與平板」。
- **背景音樂**：一首即時合成的原創曲；也可在「設定 → 音效」改用自己的本機音樂檔，或把自己的音樂檔放進 `public/music/`
  並寫一個 `bundled.json`（`{ "title": "曲名", "file": "檔名.mp3" }`），它就是預設的背景音樂（沒有這個檔案時播原創曲）。
- **本機名單檔**：「設定 → 名單」可匯入自備的 JSON 名單檔（最多 11 隊）取代內建車隊與車手（劇情模式除外），格式見 [`docs/FEATURES.md`](docs/FEATURES.md) 第 7.1 節；
  放在 `public/rosters/default.json` 的名單檔是預設名單，開機就套用。
  名單檔與音樂檔都是玩家自己的檔案，不屬於遊戲內容；`public/rosters/`、`public/music/` 不納入版本控制，包含它們的 `dist/` 請勿公開。

## 快速開始

需要 [bun](https://bun.sh)，以及支援 **WebGL 2** 的瀏覽器（最新版 Chrome、Edge、Firefox 或 Safari，並開啟硬體加速）。
電腦、手機與平板的瀏覽器都可以；在手機或平板上試玩開發版的方法見「手機與平板」。

```sh
bun install        # 安裝依賴（three、vite、typescript）
bun run dev        # 開發伺服器：http://127.0.0.1:5173/
bun run dev:lan    # 同上，但區網內的手機或平板也連得到（HTTP）
bun run dev:lan:https  # 區網 HTTPS（體感轉向需要），先執行 tools/lan-cert.sh
bun run build      # 型別檢查 + 正式建置，輸出到 dist/
bun run preview    # 在本機預覽 dist/ 的建置結果
bun test           # 執行全部自動測試（1,540 個，約 6 分鐘）
bun run typecheck  # 只做型別檢查
```

`dist/` 使用相對路徑（`base: './'`），可放在任何靜態網站伺服器的子目錄下。請不要直接用 `file://` 開啟 `index.html`，瀏覽器會擋下模組腳本。

## 操控

| 動作 | 鍵盤（P1） | 鍵盤（P2，分割畫面） | Gamepad |
|---|---|---|---|
| 油門／煞車 | W／S（或 ↑／↓） | ↑／↓ | RT／LT |
| 轉向 | A／D（或 ←／→） | ←／→ | 左搖桿 |
| 升檔／降檔 | E／Q | .／, | RB／LB |
| DRS／直線模式 | 空白鍵 | / | A |
| Overtake 加力（按住） | 左 Shift | 右 Shift | L3 |
| 切換 ERS 模式 | X | ; | X |
| 切換鏡頭 | C | \ | Y |
| 後視（按住） | V | ' | R3 |
| 回溯 | R | — | B |
| MFD（進站與 ERS） | M | ] | Back／View |
| 請求進站（Box） | B | [ | 十字鍵 上 |
| 維修道限速器 | L | — | 十字鍵 下 |
| 暫停 | Esc 或 P | — | Start／Menu |
| 全螢幕／隱藏 HUD | F／H | — | — |

- 按鍵可在「設定 → 按鍵（P1）／按鍵（P2）」重新綁定。分割畫面時，P2 清單裡的按鍵只屬於 P2，所以 P1 請用 WASD。
- 選單：方向鍵移動、Enter 確認、Esc 返回，也可以用滑鼠。
- MFD 開啟時：1–4 切換 ERS 模式、5 切換下一組輪胎、6 Box／取消。
- 重播：空白鍵播放／暫停、←／→ 前後 5 秒、↑／↓ 調整播放速度。

## 手機與平板

> 以下功能已經寫好並通過自動測試，但還沒有在真實的手機或平板上跑過，版面也還沒在瀏覽器裡檢查過。見 [`docs/FEATURES.md`](docs/FEATURES.md) 第 10 節。

- **方向**：手機只能橫向玩。手機轉成直向時，畫面蓋上「請將手機轉為橫向」並自動暫停（線上比賽照常進行）。平板直向、橫向都可以；iPad 的窄視窗（Slide Over、三分之一寬的 Split View）也算平板，不會出現轉向提示。
- **選單**：直接點選。觸控時不顯示按鍵提示，返回用頁首右側的「返回」。預覽後再選的清單（賽道、車隊、車手）點第一下預覽、再點同一項才選定。
- **比賽中**：左上是系統列（暫停、鏡頭、MFD、Box、回溯），左下與右下各一個拇指區。油門與煞車在右下，按住就踩，和鍵盤一樣漸進踩到底；一根拇指可以從煞車滑到油門，不必抬起。DRS／直線模式、升降檔、限速器只在用得到時出現。ERS 模式與進站選項在 MFD 裡點選。完整清單在「暫停 → 操作說明」的「觸控」頁，也見 [`docs/FEATURES.md`](docs/FEATURES.md) 第 3.12 節。
- **轉向方式**（「設定 → 操控與按鍵 → 轉向方式」，比賽中可從暫停選單的「設定」切換）：
  - **拖曳**（預設）：手指在左下區域落下的位置是搖桿中心，左右拖曳轉向。
  - **體感**：像轉方向盤一樣，在螢幕平面上左右轉動裝置。螢幕與地平線平行就是直行，不必校正。煞車移到左下，右下只剩油門。螢幕往後躺得太平時轉向逐漸失效，並顯示「請將裝置立起」。
  - **按鈕**：按住左下的 ◀ ▶，和鍵盤一樣漸進轉向。
- **體感轉向的權限**：iPhone 與 iPad 要先允許網頁使用動作感測器。標題畫面「點一下開始」、在設定選「體感」，或比賽中點左下的「啟用體感轉向」都會跳出詢問；允許之前先用拖曳。被拒絕、裝置沒有動作感測器，或網頁不是 HTTPS 時，設定會改回原本的轉向方式並說明原因；存檔裡已經選了體感時，比賽中提示一次「體感轉向無法使用，改用拖曳」並改用拖曳。
- **全螢幕**：Android 與 iPad 在「設定 → 畫面與 HUD → 全螢幕」切換（手機進入全螢幕時，瀏覽器支援的話也會鎖定橫向）。iPhone 的 Safari 不能讓網頁全螢幕：在 Safari 按「分享 → 加入主畫面」，之後從主畫面的圖示開啟，就沒有網址列與工具列。

### 在手機或平板上試玩開發版

手機或平板要和電腦在同一個區域網路。

- **版面與觸控**（HTTP 就夠）：執行 `bun run dev:lan`，在裝置上開 `http://<電腦的區網 IP>:5173/`。
- **體感轉向**：動作感測器只在安全連線（HTTPS 或 `localhost`）下可用。
  - iPhone 與 iPad：
    1. 執行 `tools/lan-cert.sh`（只需要 `openssl`）。第一次執行會建立本機憑證機構 `.cert/ca.crt`，再簽一張涵蓋這台電腦區網 IP、`<電腦名稱>.local` 與 `localhost` 的憑證到 `.cert/lan.crt`。`.cert/` 不納入版本控制。這個憑證機構有名稱限制，只能簽 `localhost`、`.local` 名稱與私有 IPv4 位址，簽不出公開網站的憑證。
    2. 用 AirDrop 把 `.cert/ca.crt` 傳到裝置，開啟後到「設定 → 一般 → VPN 與裝置管理」安裝描述檔。
    3. 到「設定 → 一般 → 關於本機 → 憑證信任設定」，對「FORMULA NOVA LAN dev CA」開啟完全信任。
    4. 執行 `bun run dev:lan:https`，在裝置上開 `https://<電腦的區網 IP>:5173/` 或 `https://<電腦名稱>.local:5173/`。缺少 `.cert/lan.key` 或 `.cert/lan.crt` 時，開發伺服器不會啟動並提示先執行 `tools/lan-cert.sh`。

    電腦的 IP 變了就重跑 `tools/lan-cert.sh`；憑證機構會保留，裝置不必重新信任。
  - Android（不需要憑證）：用 USB 連接並開啟 USB 偵錯，執行 `adb reverse tcp:5173 tcp:5173` 與 `bun run dev`，在手機上開 `http://localhost:5173/`。

## URL 快速開始

在網址加上參數就能跳過選單直接開賽（測試用）：

```text
http://127.0.0.1:5173/?quick=race&layout=koyo-hills-rev&laps=5&weather=dynamic&reg=2026&ai=90
```

| 參數 | 可用值 | 預設 |
|---|---|---|
| `quick` | `race`（正賽）、`quali`（排位，接著正賽）、`practice`（練習）、`tt`（計時賽）、`split`（雙人分割畫面正賽 + 8 台 AI） | 不帶此參數就是正常開機 |
| `layout` | 真實賽道：`shanghai`、`suzuka`、`bahrain`、`monaco`、`silverstone`、`spa`、`monza`、`singapore`、`cota`、`interlagos`、`las-vegas`、`yas-marina`、`sepang`；原創賽道：`porto-lumen`、`mirage-sands`、`highland-ridge`、`koyo-hills`、`isola-verde`；加上 `-rev` 為反向 | 第一個佈局（`porto-lumen`） |
| `laps` | 1–200 | 3 |
| `weather` | `clear`、`overcast`、`lightRain`、`heavyRain`、`dynamic` | `clear` |
| `reg` | `2025`、`2026` | `2025` |
| `ai` | 0–110 | 85 |
| `seed` | 任意整數（同一個種子 + 相同輸入 = 相同結果） | 目前時間 |
| `sc` | 正賽事故頻率（黃旗、虛擬安全車、安全車）：`off`（關閉）、`reduced`（減少）、`standard`（標準）、`increased`（增加） | `standard` |
| `redflag` | `1`：正賽嚴重事故可能出紅旗、`0`：不出紅旗 | `1` |
| `formation` | `1`：正賽起跑前先跑暖胎圈、`0`：直接起跑 | `0` |
| `sprint` | `1`：以衝刺賽進行（只限 `race`、`split`；圈數為 `laps` 的三分之一、至少 2 圈，給衝刺賽積分） | 不帶此參數就是一般正賽 |
| `wake` | `1`：正賽空氣動力尾流擬真（吸尾流、髒空氣）、`0`：關閉 | `1` |
| `autopilot` | `1`：玩家車由 AI 控制器駕駛（自動化測試／觀戰用；分割畫面兩位玩家的車都會自動駕駛） | 不帶此參數就由玩家操作 |

無效的值會被忽略並使用預設值。快速開始時 P1 駕駛 Nordlys Racing 的 Hsu（分割畫面 P2 為同隊的 Dahl），輔助為「進階」預設。

瀏覽器主控台另有兩個測試掛鉤：`window.render_game_to_text()`（以 JSON 描述目前畫面與節次狀態）與 `window.advanceTime(ms)`（決定性推進模擬）。

## 專案結構

```text
index.html             單一 <canvas id="game"> + <div id="ui-root">
src/
  main.ts              開機：WebGL 2 檢查、錯誤覆蓋層、啟動 App
  core/                共用型別、數學與座標慣例、預設值（設定、輔助、按鍵、賽車設定範圍）
  data/                虛構車隊與車手（teams.ts）、5 條原創賽道控制點（tracks/）、13 條真實賽道（tracks/real/）
  track/               樣條取樣、行車線、參考速度、彎道、路緣石／緩衝區／護欄、維修道、投影查詢、立體交叉、真實賽道驗證（validate.ts）
  physics/             車輛規格、底盤力學、動力系統與 ERS、輪胎、碰撞與損傷
  race/                節次流程、起跑燈號、計時、名次、DRS、進站、罰則、天氣、無線電、成績
  ai/                  AI 駕駛、攻防、進站策略、難度
  meta/                節次組裝、生涯、我的車隊、劇情、賽季、計時賽紀錄、成就、本機存檔
  render/              three.js 渲染：賽道場景、展示間／頒獎台、賽車模型、賽道景物與真實賽道地標、特效、鏡頭
  ui/menus/            所有選單畫面
  ui/hud/              節次 HUD、暫停選單、MFD、重播控制列
  audio/               WebAudio 即時合成的引擎聲、音效與原創背景音樂
  input/               鍵盤、Gamepad、觸控（拖曳、體感、按鈕轉向）、震動
  app/                 App 狀態機、節次執行、回溯、重播、URL 快速開始、測試掛鉤、線上房間控制、裝置判斷（手機／平板、轉向提示、全螢幕）
  net/                 線上多人：連線協定、房主／客戶端節次、大廳、WebRTC、配對客戶端
server/                線上多人的配對伺服器（Cloudflare Workers + Durable Objects，部署見 server/README.md）
tools/import-circuit.ts  真實賽道離線匯入工具（OpenStreetMap 中心線 + DEM 高程 → 控制點；設定在 tools/circuits.json）
tools/lan-cert.sh      區網 HTTPS 憑證（在手機上測體感轉向用，見「手機與平板」）
tests/                 bun 自動測試（物理、賽道、比賽規則、AI、無頭整場比賽、存檔、輸入、音訊、整合、渲染）
docs/SPEC.md           實作規格與原創性規則
docs/FEATURES.md       完整內容清單
progress.md            開發紀錄
```

- 技術：Vite 8、TypeScript 7（strict）、three.js r186、bun。執行期唯一依賴是 three。
- 純邏輯模組（core、data、track、physics、race、ai、meta）不使用 three.js 或 DOM，可以用 `bun test` 無頭跑完整場比賽。
- 進度存在瀏覽器的 localStorage（鍵名以 `formula-nova:` 開頭）；清除瀏覽器資料會刪除存檔。

## 線上多人

主選單 → 線上多人：2–4 名玩家（AI 補位），一人建立房間、其他人輸入 6 碼房間代碼加入。房主的電腦模擬整場比賽，玩家之間以 WebRTC 點對點連線。

- **本機測試（不需要伺服器）**：配對方式選「本機測試（同一台電腦的分頁）」，在同一個瀏覽器開兩個分頁（同一個網址，例如 `bun run dev` 的 `http://localhost:5173/`），一個建立房間、另一個輸入代碼加入。
- **跨網路**：部署 `server/` 的配對伺服器（`cd server && bun install && bunx wrangler login && bunx wrangler deploy`，詳見 [`server/README.md`](server/README.md)），把網址填到「配對伺服器網址」，或建置時設定 `VITE_SIGNAL_URL`。
- 限制：沒有 TURN 中繼（嚴格 NAT 可能連不上）、沒有反作弊、斷線不能重新加入。

## 未實作

跨平台連線、VR、HDR、社群工作坊、雲端存檔、反作弊（需要伺服器或專用硬體）。
詳見 [`docs/FEATURES.md`](docs/FEATURES.md) 第 1 節與第 10 節。
