# FORMULA NOVA 25（新星方程式 25）— 實作規格

> F1 風格的非商業同人瀏覽器賽車遊戲。功能架構對標商業作品 F1 25 的「玩法類型」；劇情、模型、音效與音樂皆原創，
> 賽道包含 5 條原創賽道與 13 條依真實佈局重現的賽道（2026-10-04 使用者決定；含昔日分站雪邦），
> 預設名單為 2026 F1 賽季的真實車隊與車手（2026-10-29 使用者決定），另保留原創虛構名單。
> 本文件 + `src/core/types.ts` + 各模組 stub 檔即為跨模組契約。

## 0. 原創性與智慧財產規則（所有代理必須遵守）

- **真實車隊與車手**（2026-10-29 使用者決定：本作非商業、純娛樂，使用者承擔商標風險）：預設名單 `src/data/realGrid.ts` 收錄
  2026 F1 賽季的真實車隊名稱、車手姓名、車號與國籍（事實資訊），塗裝只以部位顏色近似（`livery.parts`／`finish`）。
  仍然**禁止**：F1 / FIA / Formula 1 / Grand Prix 與各車隊的官方標誌圖樣、贊助商品牌與標誌、車手肖像／照片、
  EA / Codemasters 名稱、F1 25 的 UI 版面、音效、音樂、劇情（Braking Point、Konnersport、APXGP 等名稱亦禁止）。
  製作名單須保留「與 Formula 1、FIA、車隊、車手無關聯、未獲授權」的聲明。
- **有版權的音樂**（官方主題曲、任何商業歌曲）**不得**放進 repo、`src/` 或公開部署的 `dist/`，也不得由程式從網路下載；
  非商業並不構成使用授權。遊戲內建的背景音樂只用原創曲。
- **真實賽道**（`TrackDef.real` 有值）：依真實佈局重現（中心線取自 OpenStreetMap、高程取自公開 DEM，皆為事實性地理資料），
  以地名命名（例：摩納哥市街賽道、鈴鹿賽道），**不得**使用賽道或賽事的官方標誌、贊助商名稱或品牌地標名稱
  （地標一律泛稱，例如「巨型 LED 球體」「飯店橋」）；介面文字不使用真實人物姓名（以人名命名的彎道名稱只可出現在程式註解）。
  資料來源標註（`real.source`，例如「© OpenStreetMap contributors（ODbL）」）必須保留並顯示在製作名單。
- **原創賽道**（5 條）維持原創虛構，不可「微調後」重現任何真實賽道。
- 所有 3D 模型、貼圖、音效皆以程式生成（three.js geometry、canvas 貼圖、WebAudio 合成）。**執行期不得下載任何外部資產**，
  不得從網路載入字型 / CDN；真實賽道的幾何以 `tools/import-circuit.ts` 離線匯入成 `src/data/tracks/real/*.ts` 原始碼。
  唯一例外（2026-10-29 使用者決定）：玩家在「設定 → 音效」選擇 YouTube 音樂來源並加入連結後，才從 youtube.com 載入 IFrame Player API
  並以 youtube-nocookie.com 播放器播放（`src/audio/youtube.ts`）；可加入多條連結（最多 50 條），依序輪播、整份清單循環。
  播放器不顯示（2026-10-30 使用者決定，與 YouTube API 政策「播放器必須可見、≥ 200×200 px」不符，由玩家自行承擔）：iframe 以 200×200 px
  留在頁面中但完全透明、inert、不接收指標；音樂靜音的場景與背景分頁時仍會暫停。
  內建名單：預設為 `src/data/realGrid.ts`（2026 F1 真實陣容），原創虛構名單為 `src/data/teams.ts`（「新星之路」固定使用，也可在設定選用）。
  背景音樂為原創曲，以 WebAudio 即時合成，依場景各一首：選單〈Lights Out〉、比賽〈Pole Position Anthem〉、頒獎台〈Champagne〉
  （`src/audio/musicThemes.ts`、`src/audio/musicScore.ts`）。
- **玩家自備內容**（2026-10-07 使用者決定，個人使用）：玩家可在「設定 → 名單」匯入本機名單檔（`src/meta/rosterPack.ts` 驗證，
  存在瀏覽器 localStorage），在「設定 → 音效」選擇本機音樂檔（存在 IndexedDB）或加入 YouTube 連結（存在設定）。這些是玩家自己的內容，
  **不屬於遊戲內容**，不得打包進 `src/` 或公開的 `dist/`。劇情「新星之路」固定使用原創名單。
  玩家自己的檔案可放在 `public/` 下兩個已列入 `.gitignore` 的資料夾，從同源讀取：
  `public/rosters/default.json` 是**個人預設名單**（開機時由 `src/app/defaultRoster.ts` 讀取，取代內建的 2026 陣容成為預設名單；
  沒有匯入名單、也沒有選擇原創名單時生效），`public/music/` + `bundled.json` 是**本機播放清單**（`src/audio/bundledMusic.ts`；
  單曲 `{ title, file }` 或 `{ tracks: [{ title, file, scenes? }] }`，`scenes` 為 `menu`／`race`／`results`；`musicSource` 預設 `bundled`，
  沒有檔案時安靜地改播原創曲）。`bun run build` 會把它們複製進 `dist/`，含有版權音樂的 `dist/` 不得公開散佈（CI 部署不含這兩個資料夾）。
- 賽車外形依 FIA 2025／2026 技術規則的公開尺寸重現通用的現代 F1 賽車（不仿製任何車隊的特定車款）。
- 通用賽車術語與規則（DRS、ERS、輪胎配方顏色慣例、積分表 25-18-15…、計時紫/綠/黃色慣例）屬一般知識，可以使用。
- 遊戲名稱：`FORMULA NOVA 25` / `新星方程式 25`（`core/defaults.ts` 的 GAME_TITLE）。

## 1. 技術棧與指令

- Vite 8 + TypeScript 7（`strict`）+ three.js r186（WebGLRenderer）。**禁止新增任何依賴**（不可 `bun add`、不可改 package.json）。
- 指令：`bun run typecheck`（= `tsc --noEmit -p tsconfig.json`，只檢查 `src/`）、`bun test`（測試放 `tests/`）、`bun run build`。
- 純邏輯模組（`core`、`track`、`physics`、`race`、`ai`、`data`、`meta` 的非 DOM 部分）**不得 import three.js 或使用 DOM**，
  以便 `bun test` 無頭執行。
- **禁止**：任何 git 指令、任何瀏覽器自動化 / E2E 工具（Playwright、agent-browser、chrome-devtools 等）、啟動長駐 dev server。
  驗證只用 typecheck、bun test、build，以及無頭模擬。
- three r186 API 請以 `node_modules/three/src` 與 `node_modules/@types/three` 為準，避免已棄用 API（會在 console 出警告）。
  addons 由 `three/addons/...` 匯入。

## 2. 世界慣例（摘要，完整見 `src/core/types.ts`、`src/core/math.ts`）

- Y 軸向上，公尺。模擬在 XZ 平面；`y` 只做視覺高度。
- `yaw`：forward = (sin yaw, cos yaw)、right = (−cos yaw, sin yaw)。**向右轉 ⇒ yaw 遞減（yawRate < 0）**。
- 車模建模朝 +Z，`mesh.rotation.y = yaw` 即與模擬一致；模型本地空間 **−X 是車的右側**。
- 橫向偏移、曲率、轉向一律「+ = 右」。
- WorldState 必須是純資料（可 `structuredClone`）。固定步長 `SIM_DT = 1/120`。
- 各模組的私有狀態放在自己擁有的型別：`physics/types.ts`（CarSpec、PhysicsInternal）、`ai/types.ts`（AIState）、
  `race/types.ts`（CarRaceInternal、WorldRaceInternal）——擁有者可自由擴充欄位。`core/*` 與 `data/teams.ts` 原則上不可修改；經專案擁有者同意（2026-10），`core/*` 允許**只做增加**的修改（新增欄位、擴大列舉／範圍），不得刪除或改變既有欄位的意義（例：`Assists.pitAssist`；`CarRenderState.damage` 新增選填 `floor` / `suspension`（0..1，渲染車損用）與 `corner`（損傷顯示的那一角，來自 `CarPhysicsState.damageCorner`）；線上多人把 `playerIndex` 由 0 | 1 擴大為 `PlayerIndex` = 0 | 1 | 2 | 3，本機分割畫面仍只用 0 / 1）。

## 3. F1 25 功能對照（本作要實作的範圍）

| F1 25 功能 | 本作對應 | 負責 |
|---|---|---|
| 2025 賽季賽車、10 隊 20 車手 | 預設 2026 F1 真實陣容 11 隊 22 位車手 + 6 位候補（data/realGrid.ts）；原創名單 10 支虛構車隊、20 位車手 + 6 位候補（data/teams.ts） | 已提供 |
| 2026 賽季包：較小較輕的新車、主動空力、Overtake 模式 | `regulation: '2026'`：尺寸/重量/動力分配改變；直線模式（主動空力，前後翼同時開）取代 DRS；1 秒內可用 Overtake 加力 | physics / race / render |
| 新物理與操控 | 動態自行車模型 + 簡化 Pacejka 輪胎、空力下壓、重量轉移近似 | physics |
| 賽道（含 LiDAR 掃描重建） | 5 條原創賽道，程式化建模（高度起伏、路緣石、碎石區、護欄、看台、維修區） | track / render |
| 反向賽道 | 每條賽道皆可反向（共 10 種佈局） | track |
| Grand Prix（自訂單場） | 大獎賽：自選賽道/車隊/圈數/天氣/AI 難度/規則/賽制（練習→排位→正賽） | menus / race |
| Time Trial | 計時賽：個人最佳 + 幽靈車 + 本機排行 | race / menus / render |
| Driver Career | 車手生涯：自創車手、加入車隊、10 站賽季、積分榜、評價成長、隊友對比、車輛研發（每站賺研發點數，指定自家車隊的零件研發）、AI 車隊整季研發 | menus(meta) |
| My Team（車隊經營） | 我的車隊：自建第 11 隊、塗裝、零件級研發（10 個零件 × 5 級研發專案，花資金、需數站完成、有成功率）、對手車隊整季研發、資金、簽第二車手 | menus(meta) |
| Braking Point 劇情 | 原創劇情模式「新星之路」6 章 + 挑戰賽（目標制） | menus(meta) |
| F1 World 挑戰 | 挑戰賽清單（同目標系統） | menus(meta) |
| 分割畫面多人 | 本機雙人分割畫面（可加 AI） | app / render / hud / input |
| 線上 / LAN / 跨平台 | **不實作**（需伺服器）— 文件說明 | — |
| 塗裝自訂（號碼、圖樣） | 塗裝編輯器：三色 + 5 種圖樣 + 車號 | menus / render |
| 頒獎台與過場 | 3D 頒獎台場景、開賽燈號 | render / menus |
| 天氣與動態天氣 | 晴/陰/小雨/大雨、動態變化、賽道積水與乾燥、雨滴與水霧 | race / render |
| 輪胎（軟/中/硬/半雨/全雨） | 配方抓地、磨耗、溫度窗口、溼地交叉點 | physics |
| ERS / DRS | ERS 四種模式 + 電池；DRS 偵測點 1 秒規則、第 3 圈起開放、雨天停用 | physics / race |
| 進站 | MFD 指定換胎；真實 F1 規則：引道不限速、限速線之間 80 km/h，玩家手動開維修道並按限速器（超速正賽 +5 秒），只有停進維修格自動；「進站自動駕駛」輔助與 AI 走完整自動駕駛；停站 2–3.5 秒、修好所有受損部位 | race / hud |
| 罰則 | 賽道界線警告（3 次 → +5 秒）、碰撞損傷 | race |
| 排位 | 單圈排位（One-shot）/ 短排位（3 圈）；AI 成績模擬；決定發車順序 | race / menus |
| 練習賽 | 計時練習 | race |
| 輔助系統 | 轉向/煞車/ABS/TC/自排/行車線/ERS/DRS 輔助 + 三種預設 | physics / render |
| 賽車設定 | 前後翼、差速器、煞車平衡、懸吊、車高、胎壓 | menus / physics |
| 回溯（Flashback） | 倒帶 5 秒（可設定次數） | app |
| 重播 | 賽後重播：電視轉播鏡頭、播放/暫停/拖曳/倍速 | app / render / hud |
| 鏡頭 | 追焦、遠追焦、T-cam、座艙（含 Halo、方向盤）、鼻錐、電視轉播 | render |
| 車隊無線電 | 原創工程師訊息（中文） | race / hud |
| 控制器 / 震動 | 鍵盤 + Gamepad（標準映射）+ 震動 | input |
| 成就 | 本機成就 12 項 | menus(meta) |
| VR / HDR / Workshop / 雲端存檔 / 反作弊 | **不實作** — 文件說明 | — |

## 4. 原創內容清單

### 4.1 賽道（track agent 設計控制點；全部虛構）
| id | 名稱 | 環境 | 時段 | 特色 | 目標長度 |
|---|---|---|---|---|---|
| `porto-lumen` | 流明港街道賽 Porto Lumen Street Circuit | city（港口街道） | night | 街道賽，牆近，90° 彎多，港邊長直道 | 4.4–4.8 km，寬 12 |
| `mirage-sands` | 蜃樓沙漠賽道 Mirage Sands Autodrome | desert | dusk | 兩條超長直道 + 重煞髮夾彎，柏油緩衝區 | 5.2–5.5 km，寬 15 |
| `highland-ridge` | 高原嶺賽道 Highland Ridge Raceway | temperate | day | 高速連續彎、起伏（±10 m）、碎石區 | 5.5–5.9 km，寬 13 |
| `koyo-hills` | 紅葉丘陵賽道 Kōyō Hills Circuit | autumn | day | 技術型 S 彎、髮夾彎、起伏 | 4.9–5.2 km，寬 12 |
| `isola-verde` | 翠島海岸賽道 Isola Verde Coastal Circuit | coastal | day | 中速彎、減速彎組、海岸線 | 4.3–4.6 km，寬 13 |

- 控制點 `points[0]` 位於主直道正中央（起終點線）；主直道（含延伸）≥ 900 m，維修道入口/出口都在主直道範圍內。
- 不得自我交叉；非相鄰路段中心線距離 ≥ 兩側半寬總和 + 12 m；最小彎道半徑 ≥ 15 m。
- 每條 2–3 個 DRS 區；3 個計時段；反向佈局自動換算 DRS、計時段、維修道。

### 4.1b 真實賽道（`src/data/tracks/real/*.ts`，`TrackDef.real` 有值）
| id | 名稱 | id | 名稱 | id | 名稱 |
|---|---|---|---|---|---|
| `shanghai` | 上海國際賽車場 | `suzuka` | 鈴鹿賽道（立體交叉） | `bahrain` | 巴林薩基爾賽道（夜賽） |
| `monaco` | 摩納哥市街賽道（街道、隧道） | `silverstone` | 銀石賽道 | `spa` | 斯帕-法蘭柯香賽道 |
| `monza` | 蒙札賽道 | `singapore` | 濱海灣市街賽道（街道、夜賽） | `cota` | 奧斯汀賽道 |
| `interlagos` | 英特拉格斯賽道 | `las-vegas` | 拉斯維加斯大道賽道（街道、夜賽） | `yas-marina` | 亞斯濱海賽道（黃昏） |
| `sepang` | 雪邦國際賽車場（熱帶，昔日分站） | | | | |

- 幾何以 `tools/import-circuit.ts` 從 OpenStreetMap + DEM 匯入；DRS、計時段、維修道依 2025 資料；地標用 `real.features`
  （名稱清單見 `src/render/track/features.ts`）。為遊戲限制做的偏差寫在各檔檔頭。
- 驗收用 `validateTrackDef(def)`（`src/track/validate.ts`，與 `tests/track.real.test.ts` 同一套規則）：長度在官方值 ±2%、坡度 ≤ 20%、
  半徑 ≥ 9 m、路寬 10–16 m、DRS 1–4 區（150–2300 m）、計時段各 15–55%、參考圈速 60–125 s、非相鄰路面邊緣 ≥ 3 m（立體交叉除外）、
  維修區 ≥ 380 m 且曲率 ≤ 1/250。立體交叉：兩段路面在平面重疊且高差 ≥ 6 m 時上層為 `BuiltTrack.deck`。
- 生涯／我的車隊預設「隨機賽曆」：每季從所有賽道（真實＋原創，正反向）以存檔種子抽 12 站不重複賽道。「真實賽曆」依 2025 賽曆順序排列（雪邦不在 2025 賽曆，只出現在大獎賽／計時賽／分割畫面）；原創賽道仍可在所有模式選擇。
- 環境（`Biome`）新增 `tropical`（熱帶：油棕、雨林、濕熱霧氣、綠色丘陵），用於雪邦。

### 4.2 遊戲模式與畫面（menus agent；全部 zh-TW）
啟動畫面 → 主選單（大獎賽、計時賽、車手生涯、我的車隊、新星之路（劇情 + 挑戰賽）、雙人分割畫面、設定、成就、製作名單）→
各模式設定頁（賽道選擇含小地圖預覽與反向切換、車隊/車手選擇、圈數、天氣、時段、規則年份、AI 難度、輔助、賽制）→
賽車設定頁（SETUP_RANGES 滑桿 + 起步胎）→ 載入畫面 → 比賽 → 成績 / 頒獎台 → 下一節 / 重播 / 返回樞紐。
生涯樞紐：賽程（10 站：5 賽道正反向）、車手/車隊積分榜、下一站、車手評價、車輛研發（研發點數）。我的車隊樞紐：車隊名稱/塗裝、資金、研發中心（10 個零件依空力/動力/底盤分組的研發專案）、第二車手簽約。兩個樞紐都顯示上站研發報告摘要；研發畫面另列上站研發報告與對手研發進度。

## 5. 模組分工（擁有者只能寫自己的路徑；可讀所有檔案）

| 代理 | 擁有路徑 | 依賴（唯讀） |
|---|---|---|
| track | `src/track/**`, `src/data/tracks/**`, `tests/track*.test.ts` | core |
| physics | `src/physics/**`, `tests/physics*.test.ts` | core |
| render | `src/render/**` | core, track 契約 |
| menus | `src/ui/menus/**`, `src/meta/**`, `tests/meta*.test.ts` | core, data, track 契約, race 契約 |
| hud | `src/ui/hud/**` | core, track/race 契約 |
| audio-input | `src/audio/**`, `src/input/**`, `tests/input*.test.ts` | core |
| race-ai（第二階段） | `src/race/**`, `src/ai/**`, `tests/race*.test.ts`, `tests/ai*.test.ts`, `tests/headless*.test.ts` | core, track, physics |
| integration（第三階段） | `src/app/**`, `src/main.ts`, `index.html`, `src/ui/app.css`；可修正任何模組的整合錯誤 | 全部 |
| net（線上多人，2026-10） | `src/net/**`, `server/**`, `tests/net*.test.ts`（`docs/plans/phase3-online.md`） | core, race, ai, meta, physics 契約 |

規則：
- 保留 stub 的匯出名稱與簽章（可新增匯出、可新增**選用**參數）。stub 的 `NI(...)` 全部要換成真實實作。
- 型檢時其他代理的檔案可能還在施工；只修自己路徑內的錯誤：`bun run typecheck 2>&1 | grep '^src/<你的路徑>'`。
- 每個模組需在檔頭註解說明用途；註解精簡、命名清楚。不留 `TODO`、不留 `console.log`（`console.warn/error` 可用於真正錯誤）。
- 資源釋放：three 的 geometry/material/texture、DOM 監聽器、AudioNode 都要在 dispose/destroy 時清掉。

## 6. 各模組需求與驗收

### 6.1 track
- `buildTrack`：centripetal Catmull-Rom 閉合曲線，取樣間距 ~2 m（`spacing` 可調），算切線、右向量、曲率（+右）、半寬、
  高度（平滑）、路緣石（|曲率| 夠大的彎道兩側或內外側，寬 ~1.2–1.6 m）、緩衝區寬度與材質（街道賽 2–4 m 牆；一般 10–25 m；
  高速彎外側碎石）、**自動夾限緩衝區**避免護欄穿入鄰近路段、維修道幾何（`pit.laneOffset` = side × (halfWidth + ~9)，
  `wallOffset` = side × (halfWidth + ~3)，入口/出口各 ~120 m 漸變）、維修道所在側的緩衝區在維修區範圍內需 ≥ laneOffset + 5。
- 行車線：在路寬內（留 1.3 m 車身邊距）用迭代最小曲率法求 `racingLine`；`speedProfile` 用 REFERENCE_CAR（含下壓力）
  先算彎道極速，再做正向加速 / 反向煞車兩段傳遞（閉合迴圈收斂），`referenceLapTime` = Σ ds / v。
- `corners`：依曲率與速度谷值偵測彎道並編號。
- `projectToTrack` 有 hint 時只在 ±40 個樣本窗口搜尋，無 hint 用空間格網全域搜尋；回傳 surface（asphalt/kerb/runoff 材質/pitlane）。
- `getLayoutOutline`：正規化小地圖折線。反向佈局：點序反轉、`s=0` 仍是同一條起終點線、DRS/計時段/維修道換算到新方向。
- 測試（`tests/track.test.ts`）：所有佈局都能建置；原創賽道長度在 4.2–6.2 km（真實賽道見 §4.1b）；閉合連續（相鄰樣本距離 ≈ spacing）；不自交且間距符合 4.1；
  投影往返（poseAt→projectToTrack 誤差 < 0.05 m）；referenceLapTime 在 70–110 秒；DRS / 計時段 / 維修道在反向後順序正確。

### 6.2 physics
- 動態自行車模型（前後軸側向力用簡化 Pacejka，含下壓力增加的法向力、前後空力平衡、簡化縱向重量轉移、低速（< 3 m/s）
  平滑混入運動學模型以避免奇異）；8 速變速箱、轉速、換檔時間、自排升降檔、引擎制動；ERS（2025：120 kW、4 MJ、煞車回收；
  模式 none/medium/hotlap/overtake；2026：350 kW 電能、ICE 降低、`overtakeHeld` 且 `overtakeAvailable` 時額外輸出）；
  DRS / 主動空力開啟時降阻（2026 同時降低下壓力）；煞車或離開區域即關閉；`drsAssist` 自動開。
- 輔助：轉向輔助（高速降低轉角 + 反打穩定）、煞車輔助（`assistTargetSpeed`）、ABS、TC（off/medium/full）、自排、限速器（80 km/h）。
- 輪胎：配方基礎抓地（soft 1.0 / medium 0.975 / hard 0.95 / inter / wet）、磨耗（rules 可關；軟胎約 15–20 圈、中性 25–30、硬胎 35–45）、
  溫度窗口（過冷/過熱降抓地）、溼地：光頭胎在 wetness 1 時 ~0.55，半雨胎 0.3–0.6 最佳，全雨胎 > 0.6 最佳；草地/碎石低抓地 + 高阻力；路緣石略低抓地。
- 損傷：前翼損傷降低前軸下壓、尾翼降低後軸；`damageMultiplier` 0 時無損傷。
- 油料：質量影響加速；`fuelPerKm` ≈ 0.33 kg/km。
- 尺寸：2025 長 5.6 m、寬 2.0 m、軸距 3.6 m、乾重 800 kg；2026 長 5.4 m、寬 1.9 m、軸距 3.4 m、乾重 770 kg。
- 碰撞：護欄（推回、移除法向速度、摩擦減速、回傳衝量）、車對車（兩圓近似或 OBB，衝量交換、無穿透）。
- 測試（`tests/physics.test.ts`）：直線極速（2025 無 DRS）320–345 km/h、DRS +8–18 km/h；0–100 km/h 2.4–3.4 s（TC full）；
  300→100 km/h 煞車距離 < 120 m；右轉向使車往右（yaw 遞減）；100 m 半徑穩態轉彎可達 ≥ 2.8 g；
  隨機輸入 60 秒無 NaN；靜止不漂移；溼地抓地符合上述；磨耗率符合；ERS 電量不超出 0..1。

### 6.3 race-ai（依賴 track + physics 完成後）
- `createWorld`：依 config 放車（正賽：起跑線後方雙排錯位，間隔 8 m；計時/練習/排位：從起跑線前 ~400 m 的飛馳圈開始或維修道出口）、
  依圈數加油、AI 狀態、維修區位置（各隊 box 位置）。
- `stepWorld`：燈號（5 燈每秒 1 盞 → 隨機 0.5–2.5 s 熄燈；熄燈前車輛鎖定但可轉速），每步：投影 → AI/玩家輸入 → physics →
  護欄/車對車碰撞（含損傷與事件）→ 計時（圈、計時段、最佳、個人/全場紫綠判定）→ 名次與差距（以檢查點時間估算）→
  DRS（正賽第 3 圈起；偵測點落後前車 < 1.0 s；雨天 wetness > 0.4 停用；練習/排位/計時賽自由使用；2026 主動空力全員可用、Overtake 依 1 秒規則）→
  賽道界線（四輪越界於彎道 → 警告並作廢單圈；3 次後每次 +5 s）→ 維修道自動駕駛（入口→車道→停站→出口，限速，換胎/修翼）→
  天氣演進（預報、雨量、積水滯後、乾燥）→ 方格旗與完賽 → 無線電訊息事件（中文原創）。
- AI：沿 `racingLine` + `speedProfile` 的 pure-pursuit 轉向與速度追蹤（依難度/技能/輪胎/天氣/燃油調整）、超車（側移 2.5–3.5 m 並保持）、
  防守、跟車避撞、煞車點誤差（依 consistency）、DRS/ERS 使用、進站策略。第 2 階段（`docs/plans/phase2-ai.md`）：循跡煞車、路緣石、
  配速模式、自然失誤、溼地差距；進攻階段（假動作、交叉超車）、DRS 列車、防守規則；比賽時間模型（不停／1–4 停，磨耗上限 0.72／0.82，
  不進入 0.85 懸崖）、undercut／overcut／cover、安全車／VSC 進站（新胎下限保護）、天氣預報、車隊指令（玩家永遠不被要求讓車）。
  進站損失 `estimatePitLoss` 在 race 契約（MFD 與 AI 共用）。
- 可重現：同 seed、同輸入 ⇒ 完全相同結果；`snapshotWorld` 後分別推進兩份應完全一致。
- 測試：每個佈局 20 台 AI 跑 3 圈（難度 90，晴天）：全部完賽、無 NaN、沒有車卡住 > 10 s、最佳圈在 referenceLapTime 的 0.95–1.25 倍、
  有超車事件；雨天一場（有人換雨胎）；進站流程（停站時間與損失 18–32 s）；賽道界線罰則；DRS 規則；決定性測試；排位模擬排序合理。

### 6.4 render
- `GameRenderer`：WebGLRenderer、ACES tone mapping、sRGB、陰影（品質分級）、像素比 × resolutionScale、resize。
- 賽道場景（依 biome / timeOfDay / weather）：天空（three addons Sky 或漸層天球 + 太陽/月亮）、霧、地形高度場（`heightAt`）、
  柏油帶（canvas 噪聲貼圖、白邊線、起跑格線、方格起終點線）、紅白路緣石、草地/碎石/柏油緩衝區、護欄（輪胎牆/鋼板護欄/水泥牆 + 防護網）、
  維修道（路面、維修牆、車庫建築與 11 個隊伍車庫、維修格）、起跑燈架（5 組紅燈，依 frame.startLights）、看台 + 觀眾（instanced）、
  樹木/仙人掌/路燈/建築（依 biome，instanced）、原創虛構廣告看板、煞車距離牌（100/150/200）、DRS 區標線、彎道標誌、夜賽燈柱。
  柏油上有沿行車線、煞車區較深的膠痕帶（`rubberIntensity`）；medium 以上柏油/路緣石/草地/碎石/水泥牆加程式化法線與粗糙度細節貼圖（溼地降低法線強度）。
- 維修站人員（`render/track/pitCrew.ts`，編排為純函式 `pitCrewMath.ts`）：每個維修格 16 人（每輪風槍/拆胎/裝胎、前後千斤頂、兩名扶車），隊色 instanced；
  閒置時在車庫前排成兩列，隊車進維修道時就位，停站時依時間軸頂車（車身抬高）→ 拆胎 → 裝胎 → 放車，放行時退開；離維修區 420 m 外隱藏。
- 行車線顯示（off/corners/full，綠→黃→紅依加減速）。
- 車模（程式化，全部 three geometry；合併同材質以降低 draw call）：單體殼、鼻錐、多片前翼 + 端板、前後懸吊連桿、輪胎（側壁配方色環）+ 輪圈 +
  煞車碟（煞車發紅光）、側箱、引擎蓋 + 鯊魚鰭、進氣口、Halo、車手頭盔（隊色）、底板 + 擴散器、尾翼主翼 + 可動 DRS 翼片（2026 前翼也可動）、
  雨燈（雨天閃爍）、後視鏡、方向盤（座艙鏡頭）、塗裝（canvas 貼圖：三色 + 圖樣 + 車號 + 隊名縮寫）。前輪轉向、輪子轉動。
  損傷外觀（`render/car/carDamage.ts`，依 `CarRenderState.damage`）：受損角 `damage.corner`（`CarPhysicsState.damageCorner`）＝損傷比之前
  所有撞擊加總還多的那次撞擊的接觸角（撞牆取朝牆的那一角、車對車取實際接觸點；懸吊彎了以後只看懸吊彎曲量，撞斷後固定，懸吊完好時看翼／底板損傷）。
  前翼先往受損角那側彎垂、超過 0.5 斷裂缺件；尾翼翼片下垂並往該側扭曲；懸吊受損時受損角的車輪外傾/偏擺/外推、車身往該角下沉，
  幅度與損傷成正比（和抓地損失一樣線性），損傷到 1 撞斷時才變成斷裂姿態（線上快照的損傷量化也不會把未斷的懸吊送成 1）；漆面刮痕與裸露碳纖維隨損傷與每次重擊累積（整場保留，進站只換翼）。
  2026 規格車更短更窄。幽靈車半透明。
- 特效：雨滴（跟隨鏡頭）、溼地水霧（車後）、輪胎煙（鎖死/打滑）、碰撞火花、碰撞碎片（重擊噴出碳纖維/塗裝碎片，翼片斷裂掉落大塊殘骸，彈跳後留在路面一段時間）、
  刹車碟發光、溼路面反光（降 roughness）。
- 鏡頭：chase / chaseFar / tcam / cockpit / nose / tv（電視轉播：沿賽道固定機位自動切換），後視（lookBack），平滑跟隨、速度感 FOV、可選震動、強度可調的速度模糊（post chain 徑向模糊，隨跟隨車速增強，0% 關閉，電視鏡頭不套用）。
- 分割畫面：每個 ViewSpec 各自相機與 viewport（scissor），CSS 座標左上原點。
- `ShowroomScene`：轉台展示車 + 頒獎台模式。
- 品質：low/medium/high/ultra 影響陰影解析度、物件密度、特效數量；20 台車 high 畫質目標 60 fps（draw call < 500）。
  另含：軟陰影半徑（`shadowRadius`）、柏油貼圖解析度、表面細節貼圖（medium 起）、場景反射探針（medium 起，從賽道上方擷取場景做環境反射，
  失敗則退回天空）、環境光遮蔽（high/ultra，GTAO 乘在場景上，依時段/雲量調整，正交鏡頭不套用）；post 另有輕微色散與底片顆粒（座艙鏡頭不加色散）。

### 6.5 hud（DOM + CSS，使用 tokens.css 變數，zh-TW）
- 速度（依 units）/ 檔位 / 轉速條 + 換檔燈、ERS 電量與模式、Overtake 指示、DRS 狀態（可用/開啟）、限速器、燃油、輪胎（配方、磨耗%、溫度色）、
  損傷示意、圈數 / 計時段（紫綠黃）/ 目前圈時 / 上圈 / 最佳 / 與最佳或幽靈的即時差、名次、計時塔（全部車輛、差距/間隔切換、進站標記）、
  小地圖（canvas，track outline + 車點）、練習/排位倒數、天氣圖示、無線電訊息、通知（賽道界線、罰秒、最快圈、最後一圈、方格旗）、
  起跑燈號覆蓋、暫停選單（繼續、重新開始、回溯、設定、鏡頭、行車線、結束節次/退賽、離開）、MFD（下一次進站輪胎、Box 請求/取消、ERS 模式）、
  重播控制列、FPS。
- 分割畫面兩個 region 各一套精簡 HUD。只在數值改變時寫 DOM。

### 6.6 menus + meta
- 第 4.2 節所有畫面；滑鼠 + 鍵盤（方向鍵 / Enter / Esc）操作；焦點可見；原創視覺（使用 tokens.css，非模仿任何商業遊戲 UI）。
- 設定：畫質、解析度比例、陰影、FPS、FOV、音量、單位、預設鏡頭、震動、速度模糊強度、轉向靈敏度、死區、按鍵重新綁定（P1/P2）、HUD 元件開關。
- meta：`save.ts`（版本化 localStorage、壞資料回預設）、生涯（自創車手 DriverDef id `'player'`、取代所選車隊一位車手、10 站、
  積分（POINTS_TABLE）、車手/車隊積分榜、AI 也依模擬成績累積積分、研發點數）、我的車隊（第 11 隊 TeamDef id `'myteam'`、資金、研發專案、
  簽約候補車手；評分固定為基礎車 + 動力單元）、劇情 6 章 + 挑戰賽 6 個（StoryObjective）、計時賽紀錄 + 幽靈、成就 12 項。
- 零件級研發 `meta/development.ts`（車手生涯與我的車隊共用，規格見 `docs/plans/phase1-rnd.md`）：10 個零件各 0–5 級，每級一個研發專案
  （站數、成功率、失敗只得一半效果；每隊同時 2 個）；所有 AI 車隊依車隊積分榜分配的預算整季研發；正賽後 `advanceDevelopment` 推進，
  下一季保留。各隊已達成的效果經 `SessionConfig.development` 傳入 `createCarSpec(team, setup, regulation, parts)`（`race/world.ts` 實車與
  `race/qualiSim.ts` 排位模擬／AI 配速都用），全部 0 級時規格與沒有研發時逐欄位相同。
- 週末流程：排位結果 → 依成績（AI 用 `race.simulateLapTimes`）排發車順序 → 正賽。

### 6.7 audio-input
- 引擎：每台發聲車一組合成器（V6 點火頻率 = rpm/60×3 的鋸齒/方波 + 諧波 + waveshaper + 依油門的低通），玩家車 + 最近 4 台 AI（距離衰減、
  簡易都卜勒），座艙/鼻錐/T-cam 為車內音色；輪胎尖叫（帶通噪聲依 slip）、風切（速度）、雨聲、碰撞、換檔、起跑嗶聲、熄燈、方格旗、UI 音效。
  無 AudioContext（無頭）時所有方法安全 no-op。
- 輸入：鍵盤（可重綁）+ Gamepad 標準映射（RT 油門、LT 煞車、左搖桿轉向、A=DRS、X=ERS、B=回溯、Y=鏡頭、LB/RB 降/升檔、Start=暫停、
  Back=MFD、十字鍵上=Box、R3=後視）；數位轉向平滑（含回正）；one-shot 鎖存；P2 路由；視窗失焦時 reset；文字輸入時暫停擷取。

### 6.8 integration（app）
- `App` 狀態機：boot → menu → loading → session（running/paused）→ results/replay → menu；單一 canvas + `#ui-root`。
- 固定步長累加器（SIM_DT，每幀最多 8 步），one-shot 輸入只送進第一步；事件每幀 drain 給 HUD / audio。
- 回溯：每 0.5 s 存快照、保留 20 s，倒帶 5 s；重播：30 Hz 錄 RenderFrame，賽後播放（電視鏡頭、拖曳、倍速）。
- 分割畫面、鏡頭切換、暫停、全螢幕（F）、HUD 切換（H）、錯誤覆蓋層（未捕捉錯誤顯示在畫面上）。
- 測試掛鉤：`window.render_game_to_text()`（JSON：模式、節次、玩家車位置/速度/檔位/名次/圈數、前後車、燈號、天氣；註明座標系）、
  `window.advanceTime(ms)`（以 SIM_DT 決定性推進並渲染一次）；URL 快速啟動：`?quick=race|quali|practice|tt|split&layout=<id>&laps=N&weather=<kind>&reg=2025|2026`。

## 7. 驗收總則
- `bun run typecheck`、`bun test`、`bun run build` 全數通過，無 three.js 棄用警告。
- 不得留下 stub `NI(...)`。不得有 `any` 濫用（必要時 `unknown` + 型別守衛）。
- 一切文字介面為繁體中文（台灣用語），技術詞可保留英文（DRS、ERS、Box）。
