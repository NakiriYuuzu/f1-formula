# Phase 1 — 零件級研發樹（Part-level R&D）規格

狀態：實作中（2026-10-10）。使用者決策：零件級研發樹；「我的車隊」用資金、「車手生涯」用研發點數指定方向；AI 車隊整季研發；`src/core/*` 只允許**增加**（新增欄位／型別，不刪不改既有語意）。

## 0. 目標與不變條件

- 取代「我的車隊」現有 4 部門（aero / power / chassis / reliability，各 0–5 級、立即購買）的研發，改成 **10 個零件**，每個零件 0–5 級，每級是一個**研發專案**：有花費、需要幾站完成、成功率；失敗只拿到部分效果。
- 車手生涯第一次有研發：玩家用每站賺到的**研發點數**決定自家車隊研發哪個零件。
- **所有 AI 車隊**在車手生涯與我的車隊賽季中都會研發（決定性、依存檔種子）。
- **零研發（全部 0）時 CarSpec 必須與現在完全相同**（逐欄位相等）——現有校準、測試、排位模擬不受影響。
- 決定性：所有隨機都用 `core/math` 的 `nextRandom`/`RngState`，種子由存檔種子、賽季、站次、車隊、零件推導；不得用 `Math.random`/`Date.now`。
- 研發效果必須同時進入 `race/world.ts`（正賽實車）與 `race/qualiSim.ts`（排位模擬、AI 配速預測）兩條 `createCarSpec` 路徑。
- 舊存檔可讀：我的車隊舊的 `rd` 部門等級遷移成零件等級；車手生涯舊存檔得到全 0 研發與 0 點數。

## 1. core 型別（`src/core/types.ts`，只增加）

```ts
/** Car parts developed in season modes (meta/development.ts); 0..5 levels each. */
export type CarPartId =
  | 'frontWing' | 'rearWing' | 'floor' | 'suspension' | 'powerUnit'
  | 'ers' | 'gearbox' | 'brakes' | 'weight' | 'reliability';
/** Achieved development per part, 0..5 (a level that only partly succeeded adds 0.5). Missing = 0. */
export type CarPartGains = Partial<Record<CarPartId, number>>;
```

`SessionConfig` 新增可省略欄位：

```ts
  /** season modes: achieved part development per team id (meta/development.ts). undefined / missing team = none */
  development?: Record<string, CarPartGains>;
```

## 2. 物理對應（`src/physics/spec.ts`）

`createCarSpec(team, setup, regulation, parts: CarPartGains = {})` —— **第 4 個參數由 `upgrade: number` 改成 `parts`**（舊的 scalar 加成只服務舊部門研發，隨之移除）。每個 gain 先夾在 0..5，非有限值當 0。`g(x)` = 該零件 gain。

| 零件 | 標籤 | 效果（每 1.0 gain） |
|---|---|---|
| frontWing | 前翼 | `frontDf *= 1 + 0.016·g`（前軸下壓力 +，約全車 +0.7%，空力平衡略往前） |
| rearWing | 尾翼 | `rearDf *= 1 + 0.005·g`；`dragArea *= 1 − 0.008·g` |
| floor | 底板 | `downforceArea *= 1 + 0.010·g`（前後等比） |
| suspension | 懸吊 | `baseMu *= 1 + 0.004·g`；`kerbGrip = clamp(原值 + 0.01·g, 0.8, 0.98)`；`tyreWearScale *= 1 − 0.02·g` |
| powerUnit | 動力單元 | `icePower *= 1 + 0.012·g` |
| ers | ERS | `ersPower`、`ersHarvestBrake`、`ersHarvestThrottle` 各 `*= 1 + 0.03·g` |
| gearbox | 變速箱 | `drivetrainEfficiency = 0.88 + 0.004·g` |
| brakes | 煞車 | `maxBrakeForce = 62000·(1 + 0.03·g)`；`ersHarvestBrake *= 1 + 0.02·g` |
| weight | 輕量化 | `mass −= 2·g`（kg；`yawInertia` 用更新後的質量計算） |
| reliability | 可靠度 | `damageScale = clamp(原 damageScale·(1 − 0.04·g), 0.6, 1.3)` |

`frontDf`／`rearDf` 指 spec.ts 目前的 `neutralBalance·(0.7 + 0.012·fw)` 與 `(1 − neutralBalance)·(0.7 + 0.012·rw)`；`aeroBalance` 仍由它們算出（所以前翼升級會讓平衡往前）。全部 5 級約為：下壓力 +10%、阻力 −4%、ICE +6%、傳動效率 0.88→0.90、質量 −10 kg —— 大致等於舊部門研發從 0 到 5 級的總幅度。

## 3. 研發模型（新檔 `src/meta/development.ts`）

```ts
export const CAR_PARTS: readonly CarPartId[]; // 上表順序
export const PART_MAX_LEVEL = 5;
export type PartGroup = 'aero' | 'power' | 'chassis';
export const PART_GROUP: Record<CarPartId, PartGroup>; // frontWing/rearWing/floor=aero; powerUnit/ers/gearbox=power; 其餘=chassis
export interface PartProgress { level: number; gain: number }        // level 0..5 整數；gain 0..level，步進 0.5
export interface DevProject { part: CarPartId; level: number; roundsLeft: number; rounds: number; chance: number }
export interface TeamDevelopment { parts: Record<CarPartId, PartProgress>; projects: DevProject[]; bank: number }
export interface DevReportLine { teamId: string; part: CarPartId; level: number; success: boolean }
export interface SeasonDevelopment { teams: Record<string, TeamDevelopment>; report: DevReportLine[] }
```

專案參數（目標等級 L = 1..5，索引 L−1）：

- `PROJECT_ROUNDS = [1, 1, 2, 2, 3]`（需要完成幾站）
- `PROJECT_CHANCE = [0.95, 0.9, 0.82, 0.74, 0.65]`（成功率）
- `PARTIAL_GAIN = 0.5`（失敗：等級仍 +1，但 gain 只 +0.5；不能重做）
- 花費：`PART_COST_MONEY = [1.0, 1.5, 2.0, 2.7, 3.4]`（M，我的車隊）；`PART_COST_POINTS = [30, 45, 60, 80, 100]`（研發點數，車手生涯玩家與 AI）
- `MAX_PROJECTS = 2`（每隊同時進行的專案）；同一零件同時只能有一個專案；目標等級 = 目前等級 + 1。

必要 API（全部純函式、不改輸入）：

- `emptyTeamDevelopment(): TeamDevelopment`、`createSeasonDevelopment(teamIds): SeasonDevelopment`
- `teamGains(team: TeamDevelopment | undefined): CarPartGains`（只列 gain > 0）、`developmentGains(dev | undefined): Record<string, CarPartGains>`（給 SessionConfig.development）
- `nextProject(team, part): DevProject | null`（預覽下一級：level、rounds、chance；滿級／已有專案時 null）
- `canStartProject(team, part): boolean`（未滿級、該零件無專案、專案數 < MAX_PROJECTS）
- `startProject(dev, teamId, part): SeasonDevelopment | null`（不處理花費；不能開始時 null）
- `projectCost(level, currency: 'money' | 'points'): number`
- `advanceDevelopment(dev, args: { seed: number; playerTeamIds: readonly string[]; standings: readonly string[] /* 車隊 id，車隊積分榜順序 */ }): SeasonDevelopment`
  1. 先推進**所有**車隊的專案：`roundsLeft − 1`；到 0 時以決定性亂數擲骰（種子 = seed、teamId、零件、等級混合）→ 成功 gain +1，否則 +0.5；level +1；寫進 report。
  2. 再替**非玩家**車隊規劃：`bank += aiDevelopmentBudget(名次, 隊數)`，在 `canStartProject` 允許時用 bank 付 `PART_COST_POINTS` 開新專案（新專案至少要下一站才完成）。選零件：等級最低者優先，同級用決定性亂數，空力零件與動力單元權重較高（aero ×1.3、powerUnit ×1.2、其他 ×1.0）。
  3. 回傳新的 dev（report = 這一站完成的所有專案，含 AI）。
- `aiDevelopmentBudget(rank0: number, teamCount: number): number` = `42 × (0.85 + 0.3 × rank0 / max(1, teamCount − 1))`（領先隊 ×0.85，最後一隊 ×1.15，仿真實 F1 的風洞時數分配）
- `rolloverDevelopment(dev): SeasonDevelopment`（下一季：零件與進行中的專案、bank 保留，report 清空）
- `developmentFromRd(rd: { aero; power; chassis; reliability })`：舊部門遷移 —— aero L → frontWing / rearWing / floor；power L → powerUnit / ers；chassis L → suspension / brakes / weight / gearbox；reliability L → reliability（各 `{ level: L, gain: L }`）。
- `sanitizeDevelopment(v: unknown, teamIds: readonly string[]): SeasonDevelopment`：只保留 teamIds 內的車隊（缺的補空的），level 夾 0..5 整數、gain 夾 0..level 並四捨五入到 0.5、專案欄位驗證（壞的丟掉、同零件重複丟掉、超過 MAX_PROJECTS 截斷）、bank ≥ 0。
- `isAnyPartMaxed(team)`、`totalLevel(team)`、`totalGain(team)` 小工具。
- `PART_LABEL`／`PART_EFFECT`（zh-TW）放在 UI 的 `labels.ts`；meta 不放 UI 文字以外的中文也可以，但標籤統一在 `src/ui/menus/labels.ts`。

## 4. 研發點數（車手生涯）

`careerRoundPoints(args: { position: number | null /* 1-based，DNF/退賽 = null */; aheadOfTeammate: boolean; sprintPosition?: number | null }): number`
= 30（基本）+ `max(0, 26 − 2·(position − 1))` + （贏隊友 6）+ 衝刺賽 `max(0, 9 − sprintPosition)`。中段（P10、贏隊友）≈ 44，與 AI 平均預算 42 相當；冠軍 ≈ 62。

## 5. 存檔與賽季流程

- **我的車隊** `MyTeamSave`：新增 `development: SeasonDevelopment`（roster 所有車隊 + 'myteam'），移除 `rd`（只在 sanitizer 讀舊值做遷移）。`myTeamRating` 一律用 0 級的基礎評分（不再隨研發成長），`upgradeBonus`／`teamUpgradeBonus`／`purchaseUpgrade`／`rdUpgradeCost`／部門等級相關函式移除或改寫；新函式 `startMyTeamProject(save, part): MyTeamSave | null`（扣 `PART_COST_MONEY`、開專案；資金不足／不能開始 → null）。成就「研發極限」改成「任一零件滿級」（`isAnyPartMaxed`）。
- **車手生涯** `CareerSave`：新增 `development: SeasonDevelopment` 與 `rdPoints: number`。新函式 `startCareerProject(save, part): CareerSave | null`（扣 `PART_COST_POINTS`）。
- 正賽結果寫入後（`applyCareerRace`／`applyMyTeamRace`）：車手生涯先加點數（`careerRoundPoints`），兩種模式都呼叫 `advanceDevelopment`（playerTeamIds = 玩家車隊；standings = 寫入後的車隊積分榜；seed 由存檔 seed、賽季、站次混合）。
- 下一季（`startNextCareerSeason`／`startNextMyTeamSeason`）：`rolloverDevelopment`。
- `careerRequest`／`myTeamRequest` → `RoundRequestArgs.development` → `SessionRequest.development` → `buildSessionConfig` 寫進 `SessionConfig.development`（`developmentGains(dev)`）。大獎賽／計時賽／分割畫面／劇情不帶（undefined）。
- `race/world.ts` 與 `race/qualiSim.ts`：`createCarSpec(team, setup, regulation, config.development?.[team.id] ?? {})`；AI 用的 `aiCarTeam` 縮差只作用在評分，零件 gain 照樣疊加。
- sanitizer：缺 `development` → 我的車隊用 `developmentFromRd(舊 rd)`，車手生涯用全 0；roster 換了（名單檔）→ 只保留現有車隊。

## 6. UI（`src/ui/menus/**`，zh-TW 台灣用語）

- **我的車隊研發畫面**（`screens/rnd.ts` 改寫）：資金、研發槽「研發中 n/2」；依「空力／動力／底盤」分組列出 10 個零件：等級（0–5 點）、效率（gain/level，例如「Lv3・效率 2.5」）、效果說明、進行中專案（剩幾站、成功率）、按鈕「研發 Lv{n}｜{花費} M｜{站數} 站｜成功率 {x}%」（資金不足／滿級／槽滿 → 停用並說明原因）；「上站研發報告」（自家與對手完成的項目，成功／部分成功）；「對手研發進度」（各隊總等級排序）。
- **車手生涯**：新畫面 `screens/careerRnd.ts`（同樣的零件清單，用研發點數），車手生涯大廳加「車輛研發（點數 N）」入口；大廳顯示上站研發報告摘要。
- `labels.ts`：`PART_LABEL`、`PART_EFFECT`、`PART_GROUP_LABEL`。舊的 `RD_LABEL` 若不再使用就移除。

## 7. 測試（bun test）

- `tests/meta.development.test.ts`：常數表、`startProject` 規則（滿級、同零件、槽數）、`advanceDevelopment` 推進／成功與部分成功（固定種子）／決定性（同種子同結果）／AI 會用 bank 開專案且新專案不會當站完成／預算依名次、`rolloverDevelopment`、`sanitizeDevelopment`（壞資料、換名單）、`developmentFromRd`、`careerRoundPoints`。
- physics：零 gain 時 spec 與不帶參數**逐欄位相等**；每個零件只動到對應欄位且方向正確；全 5 級在 `pointMassLap`（或 `maxCornerSpeed`＋極速）上明顯變快但不誇張（記錄數值）。
- meta：我的車隊舊存檔遷移、`startMyTeamProject` 扣錢、正賽後研發推進、下一季保留；車手生涯點數入帳、`startCareerProject`、`SessionConfig.development` 帶到 world 的 spec（AI 車隊也一樣）、排位模擬用到研發。
- 既有測試：凡是測舊 `rd`／`upgradeBonus`／`teamUpgradeBonus`／`purchaseUpgrade` 的，改成測新行為（不要刪測試意圖）。

## 8. 文件

`docs/FEATURES.md`（3.9 生涯／我的車隊、1.1 對照表、測試清單）、`docs/SPEC.md`（功能矩陣、meta 摘要）、`progress.md` 追加紀錄。

## 9. 審查後補充（2026-10-10）

- **車隊實力排序**（`meta/development.ts`，只新增）：`GAIN_STRENGTH = 0.004`（1.0 gain ≈ 0.08% 圈速 ≈ 自家評分 0.004，以 `predictLapTime` 實測）；`developmentStrength(gains)` = Σ gain × `GAIN_STRENGTH`（每隊相同）；`teamsByStrength(teams, dev)` = 依 `teamStrength + developmentStrength` 排序。用在：`buildSessionConfig` 沒有排位時的發車順序（`ratingGridOrder` 第 4 個選用參數 `devStrength`）、`sponsorTarget`、`expectedPosition(teamId, roster, development?)`（`applyCareerRace` 傳入當站的研發）。全部 0 級時三者都與原本完全相同。
- **UI**：`RankRow.rank`（對手研發進度同分同名次 1、1、3…）；`idleSlotsNote(team, funds, currency)` → 樞紐研發入口的「研發槽閒置 n/2」（有空槽且有零件能立即開始時）；按鈕停用的零件卡本身 `tabindex=0`，兩張表包進 `scrollRegion`，`focusNearPart` 找不到可按的按鈕時聚焦剛開始研發的零件卡。
- **待使用者決策（審查發現，與本規格衝突，未改動）**：我的車隊長期是最慢的車（基礎車 0.86 + 人類車隊用原始評分；AI 全部滿級時仍落後 vanta 2.2–3.7%）；約 8 季後全部滿級（§3 換季全部保留）；車手生涯研發點數偏向領先者（§4 公式）；AI 平均分配零件（§3 選零件規則）；煞車零件幾乎不影響圈速（§2 煞車效果）。詳見 progress.md 2026-10-10 Phase 1 紀錄。

## 10. 平衡決策（2026-10-10，規格作者裁定 §9 的待決事項；取代 §2–§5 中衝突的條文）

- **D1 我的車隊評分成長**：`myTeamRating(save)` 依各組零件的**平均 gain**（0..5，可為小數）套用原本的部門評分公式 `departmentRating(powerUnit, dept, L)`（aero = frontWing/rearWing/floor、power = powerUnit/ers/gearbox、chassis = suspension/brakes/weight、reliability = reliability）。零件效果照常疊加在評分之上（與所有車隊相同）。理由：我的車隊從 0.86 起步，必須能在數季內追上前段；舊存檔遷移後（rd L → 零件 L）評分與舊制相同。目標：兩個研發槽持續滿載的我的車隊約 4–6 季進入前 3 快，長期上限與頂尖車隊相當。`teamsByStrength`／`sponsorTarget`／發車順序自然跟著評分成長。
- **D2 換季規則調整**：`rolloverDevelopment` 讓**每個零件降一級**：`level = max(0, level − 1)`、`gain = min(level, max(0, gain − 1))`；進行中的專案改指向新的下一級（`level = part.level + 1`，`roundsLeft = min(roundsLeft, PROJECT_ROUNDS[新等級 − 1])`，`rounds`／`chance` 依表），bank 保留、report 清空。所有車隊（含玩家）一樣。大廳在新賽季顯示一行「新賽季規則調整：所有零件下降一級」。目標：多季模擬中 AI 平均總等級穩定在中段（約 15–30 / 50），不會全部滿級，預算多的車隊仍較高。（審查後效果改為按比例保留、改指向的專案退還差額，見 10.4；待規格作者確認。）
- **D3 生涯研發點數**：`careerRoundPoints({ teamRank0, teamCount, position, fieldSize, aheadOfTeammate, sprintPosition })` = `round(aiDevelopmentBudget(teamRank0, teamCount) × (0.85 + 0.25·posScore + (aheadOfTeammate ? 0.05 : 0) + sprintBonus))`；`posScore = position ? (fieldSize − position) / max(1, fieldSize − 1) : 0`；`sprintBonus = sprintPosition ? 0.05 · (fieldSize − sprintPosition) / max(1, fieldSize − 1) : 0`。teamRank0 = 寫入本站結果後玩家車隊的車隊積分名次（0 起算）。理由：與 AI 一樣「領先者較少」，表現只在 0.85–1.2× 之間調整。
- **D4 煞車零件**：`CarSpec` 新增 `brakeGrip`（`physics/types.ts`，physics 自有型別）= `1 + 0.006·g`（5 級 +3%）。`physics/chassis.ts` 的煞車力上限（前後軸的 ABS 上限、鎖死門檻與鎖死後的力）改用 `fmax × brakeGrip`，摩擦圓計算剩餘側向能力時把煞車用量除以 `brakeGrip`（煞到 `fmax × brakeGrip` 才算用滿）；`maxBrakeDecel` 的軸向煞車上限也乘上 `brakeGrip`（AI 能力模型因此反映）。`maxBrakeForce` 每級 +3% 保留。`brakeGrip = 1` 時物理結果必須與現在完全相同（逐位元）。說明文字：「煞車減速度最多 +3%、最大煞車力 +15%」。
- **D5 AI 選零件**：依價值加權：`PART_AI_WEIGHT = { frontWing 1.6, floor 1.5, powerUnit 1.5, rearWing 1.3, ers 1.2, suspension 1.1, gearbox 1.0, brakes 1.0, weight 0.9, reliability 0.6 }`；分數 = `weight / (1 + 0.35·level) × (0.9 + 0.2·rand)`；選分數最高且可開始的零件，bank 不夠付就存起來（本站不再開新專案）。目標：AI 以相同點數得到的圈速效果 ≥ 依價值貪婪分配的 90%。（實作時權重已依實測調整，見 10.1。）

### 10.1 實作與最終常數（2026-10-10）

- **D1**：`myTeamRating(save)`（`meta/myTeam.ts`）= 各部門 `departmentRating(powerUnit, dept, 平均 gain)`；`RD_CAP = 0.99`，部門分組 `RD_DEPARTMENT_PARTS`（aero = 前翼／尾翼／底板、power = 動力單元／ERS／變速箱、chassis = 懸吊／煞車／輕量化、reliability = 可靠度），平均 gain 可為小數（整數時與舊公式逐位相同）。為了讓舊存檔遷移後評分與舊制相同，`developmentFromRd` 的變速箱改由**動力**部門等級遷移（§3 原文是底盤）；測試逐一比對 4 種動力單元 × 6⁴ 種部門組合。
- **D2**：`rolloverDevelopment(dev, playerTeamIds = [])`：`SEASON_LEVEL_LOSS = 1`，level − 1；gain **按比例保留**＝`round(gain × 新等級 ÷ 原等級 × 2) ÷ 2` 夾在 0..level（原本的 gain − 1 見 10.4）；進行中專案改指向新等級（`roundsLeft = min(原值, PROJECT_ROUNDS[新等級 − 1])`），改指向後較便宜的差額由 `rolloverRefund(team, currency)` 算出：AI 車隊退回 bank（點數），玩家車隊由 `startNextCareerSeason`（研發點數）／`startNextMyTeamSeason`（資金，收入明細「研發專案降級退費」）退回。兩個樞紐在新賽季第一站前顯示「新賽季規則調整：所有零件下降一級」（`seasonRuleNote`），研發畫面的規則說明也加上這一條。
- **D3**：`careerRoundPoints({ teamRank0, teamCount, position, fieldSize, aheadOfTeammate, sprintPosition })` 照公式；`applyCareerRace` 用寫入本站後的車隊積分榜名次、`fieldSize` = 本站正賽出賽車數。名次分數夾在 0..1，非有限值／< 1 的名次算 0。
- **D4**：`CarSpec.brakeGrip = 1 + 0.006·g(brakes)`；`chassis.ts` 前後軸 ABS 上限 × brakeGrip、鎖死門檻與鎖死後的力用 `fmax × brakeGrip`、摩擦圓的煞車用量 ÷ brakeGrip；`maxBrakeDecel` 的軸向上限 × brakeGrip。未鎖死時的煞車滑移（前輪 slip、後輪 slipRatio 的煞車項，進入滑移功率、輪胎磨耗與發熱）也以 `fmax × brakeGrip` 為準（煞車力 ÷ brakeGrip，見 10.4）。說明文字「每級最大煞車力 +3%、煞車回收電能 +2%；滿級時煞車減速度最多 +3%、最大煞車力 +15%」。
  - 逐位元相同的證明：改 `chassis.ts` 前後各跑一次完整物理無頭正賽（`createWorld` + `stepWorld`，20 台車全由 AI 駕駛，偶數車 ABS 開、奇數車 ABS 關，人類那台全踩煞車製造鎖死；porto-lumen 2025 晴天 5 圈 57,902 步、monaco 2026 小雨 4 圈 46,358 步，後者另有前翼／動力單元／底板／懸吊／輕量化研發），每 1000 步把整個 world（JSON，去掉新欄位 brakeGrip）串接雜湊：前後 103 個檢查點全部相同（porto-lumen `4eb26a4a`、monaco `3526a31f`、合計 `5c982877`）；兩隊煞車 5 級時雜湊不同（`1a116e1e`），確認新路徑有被執行。
- **D5**：`planAiProjects` 照公式（分數 = 權重 ÷（1 + 0.35·level）×（0.9 + 0.2·亂數），付不起最佳零件就存款）。**權重已調整**：§10 原權重實測只達依價值貪婪分配的 81.0%（3 條賽道）／82.8%（8 個佈局 × 兩種規則），未達 ≥ 90% 的目標；改為依實測每 1.0 效果圈速壓縮到 0.4–1.6 的 `PART_AI_WEIGHT = { frontWing 1.6, suspension 1.5, floor 1.3, powerUnit 1.3, ers 1.1, rearWing 0.8, gearbox 0.8, weight 0.7, brakes 0.5, reliability 0.4 }`（懸吊實測僅次於前翼，原權重 1.1 低估；尾翼只有變速箱的價值，原權重 1.3 高估）。`AI_LEVEL_DECAY` 0.35 與 ±10% 雜訊未改。

### 10.2 實測（/tmp 探針，直接 import repo 原始碼；每季 12 站；圈速以 `predictLapTime` 難度 90、同一位參考車手、porto-lumen／highland-ridge／monaco 三條合計）

（(a)(b)(e) 與 10.3 是原本 D2「gain − 1」時的數字；換季改為按比例後的實測見 10.4。）

**(a) 我的車隊**（Helion，8 個種子；兩個研發槽一直開最高價值且付得起的零件；收入用真實的 `raceIncome`／`seasonPrize`，每站 P10／P12；其他車依車速排名次；我的車隊用自己的評分，AI 車隊用 AI 縮差評分）

| 季 | 季內平均車速名次（/11） | 季末名次（各種子） | 季末距第 1 | 季末距第 3 | 我的車隊總等級／效果 | 空力評分 | AI 平均總等級 | 資金 M |
|---|---|---|---|---|---|---|---|---|
| 1 | 10.9 | 10/8/7/7/11/11/7/9 | +0.63% | +0.46% | 18 / 17.0 | 0.926 | 10.5 | 42.6 |
| 2 | 9.2 | 5/4/1/3/10/7/5/5 | +0.32% | +0.17% | 24 / 22.0 | 0.948 | 15.4 | 40.1 |
| 3 | 6.5 | 1/2/1/1/5/4/4/1 | +0.05% | −0.12% | 28 / 24.9 | 0.955 | 17.6 | 33.2 |
| 4 | 4.0 | 全部第 1 | 0.00% | −0.32% | 33 / 28.8 | 0.960 | 18.8 | 27.6 |
| 5 | 3.8 | 1/1/1/6/1/1/1/1 | +0.03% | −0.16% | 34 / 28.4 | 0.955 | 20.0 | 20.1 |
| 6 | 5.4 | 4/3/1/9/5/2/1/1 | +0.13% | −0.02% | 36 / 28.7 | 0.951 | 20.7 | 16.2 |
| 7 | 6.4 | 5/3/2/11/7/2/1/1 | +0.26% | +0.08% | 36.4 / 28.2 | 0.946 | 21.2 | 10.3 |
| 8 | 8.1 | 9/5/7/11/10/4/9/7 | +0.50% | +0.29% | 36 / 26.6 | 0.941 | 21.7 | 6.7（研發槽開始閒置） |

資金補到不會斷（真正「持續滿載」）時第 1–6 季相同，之後仍下滑：季內平均名次第 7 季 6.6、第 8 季 7.7、第 10 季 8.7、第 12 季 9.7；等級停在 36–39，效果卻從 28.8 掉到 24.7。靜態上限：全部零件 5 級的我的車隊（評分 0.99）對上全部 5 級的 AI 車隊排第 3、距最快 0.16%。若改成依車速名次拿成績（P(2·名次 − 1)），第 3 季後各種子兩極化：領先的種子資金暴增並保持第 1，落後的種子因贊助目標達不到而缺錢、掉到第 11。

**(b) AI 平衡**（10 隊全 AI、10 季、5 個種子；車隊積分依車速名次）：季末平均總等級 10.5、15.3、17.6、19.0、20.0、20.7、21.3、21.6、22.0、22.2（季初換季後 5.2 → 14.0），沒有車隊滿級（季末最高 25.8）；第 4–10 季每季預算最多的 corvid（約 570 點）平均 23.9 級，最少的 vanta（約 442 點）18.4 級，同季最富與最窮差約 4–7 級。

**(c) 車手生涯**（3 個種子；玩家每站固定名次，其餘依車速；點數全部花在最高價值零件；車速名次以 AI 車評分 + 零件比較）

| 車隊（起始車速名次） | 完賽 | 每站點數 第 1／3／5 季 | 同車隊積分名次的 AI 預算 | 車隊積分名次 | 車速名次（季內平均）第 1／3／5 季 |
|---|---|---|---|---|---|
| vanta（1） | P3 | 38.4／41.6／42.5 | 35.8／37.4／38.1 | 1.3／2.7／2.0 | 1.1／3.0／3.5 |
| vanta | P10 | 36.2／40.4／41.6 | 37.3／40.8／41.5 | 2.3／4.3／5.0 | 1.3／3.7／4.6 |
| vanta | P18 | 33.2／36.5／37.6 | 37.4／41.9／43.0 | 2.3／5.3／6.3 | 1.5／4.4／5.8 |
| helix（5） | P3 | 43.2／43.7／44.2 | 38.6／39.0／39.3 | 3.7／3.7／3.7 | 4.8／5.9／7.7 |
| helix | P10 | 41.1／42.4／44.0 | 41.3／41.6／42.7 | 5.0／5.3／6.0 | 4.9／6.0／8.3 |
| helix | P18 | 36.1／40.9／41.8 | 41.4／46.2／46.7 | 5.0／8.7／9.0 | 5.1／8.0／8.8 |
| corvid（10） | P3 | 43.2／43.5／44.4 | 38.7／38.9／39.5 | 3.7／3.3／4.0 | 10／10／10 |
| corvid | P10 | 44.0／44.3／44.6 | 42.7／43.1／43.4 | 6.0／6.3／7.0 | 10／10／10 |
| corvid | P18 | 45.0（每季） | 48.3 | 10 | 10／10／10 |

玩家點數為同名次 AI 預算的 0.87–1.12 倍（舊公式冠軍 62–70 點、P15 36 點）；預算向落後車隊傾斜，前段與中段車隊都會被後面的車隊追近，最慢的 corvid 即使總等級較高（23 對 AI 平均 19.5）也追不上評分差距。

**(d) 煞車零件 5 級**：`maxBrakeDecel` +2.93%（0 m/s）… +2.62%（90 m/s，煞車力上限開始作用）；完整物理直線煞車 300→100 km/h：ABS 開 80.94 → 78.85 m（−2.59%，2026 −2.53%），ABS 關 −2.20%（2026 −2.17%）；`predictLapTime` 36 個佈局 × 兩種規則 × 前段／後段 AI 車平均快 0.143%（0.084–0.210%；之前約 0）。單一零件滿級（同一組）：前翼 0.91%、懸吊 0.83%、底板 0.62%、動力單元 0.59%、ERS 0.48%、變速箱 0.30%、尾翼 0.29%、輕量化 0.25%、煞車 0.14%、可靠度 0。

**(e) AI 分配效率**（每站 42 點、5 季含換季、整段每站圈速增益平均）：8 個佈局 × 兩種規則 × 前段／後段 AI 車、10 個種子 — 實際 AI 路徑 98.8%（原 §10 權重 82.8%、舊規則「最低等級優先」約 66%）；只看 3 條探針賽道、中段 AI 車、2025、12 個種子 — 90.8%（原權重 81.0%）。基準為「依價值」與「依價值 ÷ 點數」兩種貪婪分配中較好者。

### 10.3 與目標的差距（D2 部分已由 10.4 處理）

- **我的車隊長期上限**：進入前 3 快的時間符合（季末第 3–4 季、季內平均第 4–5 季），但持續滿載也撐不住：第 7 季起季內平均名次退到 6–10。主因是 D2 的 `gain − 1`：部分成功留下的效率缺口（level − gain）換季時不會縮小，只會隨每次 Lv4／Lv5 專案（成功率 74%／65%）累積，越常把零件推到高等級的隊伍損失越多（我的車隊等級 36→39 時效果 28.8→24.7）；加上 P10／P12 的收入在車變快、贊助目標變嚴後不夠支撐。唯一可調的 §10 常數（效果的換季扣除量，必須是 0.5 的倍數）試過 0.5：缺口每季回補 0.5，持續滿載的我的車隊第 4 季起每季都第 1、領先第 3 名 0.6–0.85%（依車速拿成績時資金到第 12 季 850 M），變成壓倒性領先，同樣不符「與頂尖車隊相當」，所以保留 §10 的 1。需要決定：例如按比例扣效果（gain × (level − 1) ÷ level，取 0.5 的倍數）、或部分成功可在換季時補回。

### 10.4 審查後修正（2026-10-10，待規格作者確認 D2 的效果公式）

- **D2 效果按比例保留**：審查重現了 10.3 的問題，且不只我的車隊——`gain − 1` 讓效率缺口（level − gain）換季時完全保留，所有車隊的實際效果長期流失。AI 單獨模擬（10 隊、依車速名次算積分、3 個種子）：季末平均總等級穩定（第 6 季 20.7 → 第 20 季 22.8），季末平均效果卻 17.3 → 11.4（效率 0.83 → 0.50），第 11–20 季預算最多的 corvid 26.4 級、效果卻只有 13.8，最少的 vanta 19.8 級／12.4；我的車隊（資金無限、兩槽滿載、依自家圈速價值選零件、依車速拿成績）第 17 季起 4 個種子全部最後（11/11），換任何選零件策略都一樣。改成按比例後（`rolloverDevelopment`，見 10.1）：
  - AI：季末平均總等級第 3 季 18.1 → 第 10 季 23.0 → 第 20 季 23.9（最高 29，沒有車隊滿級），季末平均效果第 6 季 19.0 → 第 20 季 20.2（穩定）；第 11–20 季預算最多的 corvid 27.5 級／效果 23.1，最少的 vanta 20.2 級／17.4。
  - 我的車隊（同上設定，第 1–20 季）：季內平均車速名次 10.9、6.9、3.7、2.0，之後第 5–16 季 1.9–4.1、第 17–20 季 4.4–5.6；季末等級 39、效果約 30–32，不再流失。
  - 「gain − 0.5」的變體（10.3 試過）會讓我的車隊從第 4 季起每季都是第 1、領先第 3 名 0.6–1.2%，所以不採用。
  - 測試：`tests/meta.development.test.ts` 的多季測試改跑 12 季，另外斷言季末效果 ÷ 等級 ≥ 0.8、第 12 季效果不低於第 6 季、預算多的車隊效果也較高（原公式在第 8 季效率掉到 0.77，因此這個測試會失敗）。
- **換季改指向的退費**：原本在最後一站後（或跨季仍在進行）的專案，換季時改指向較低等級但花費不退（例：Lv4 底板在季末開 Lv5 花 100 點，換季後變成 80 點的 Lv4 專案，比換季後才開多花 20 點；我的車隊 0.7 M；AI 每個專案 15–20 點）。現在退回差額（`rolloverRefund`），季末開專案與新賽季才開完全相同；研發畫面的規則說明加上「效率按比例保留；進行中的專案改為研發新的下一級，並退還費用差額」。
- **D4 滑移正規化**：未鎖死煞車的滑移改以 `fmax × brakeGrip` 為準，與摩擦圓一致。`brakeGrip = 1` 時 `x ÷ 1 = x`，與 HEAD 的 `chassisSubstep` 隨機比對 40 萬個子步 0 筆不同。煞車 5 級、ABS 開、300→100 km/h 一次煞車的輪胎磨耗由 +1.6% 變成 −0.2%（ABS 關的 +5.4% 來自 D4 規定的鎖死力 × brakeGrip，未改）。
- **D1 上升速度（待決定，未改）**：依自家圈速價值選零件的玩家（Helion、真實收入、依車速拿成績、8 個種子、按比例換季）季內平均車速名次第 1–4 季 10.9、7.8、4.8、2.8，季末第 2 季 5/8 個種子已在前 3、第 3 季 6/8 第 1；之後第 5–12 季 2.8–4.2。比 10.2(a)（AI 權重選零件）快約一季，也比目標「約 4–6 季進入前 3」早。若要放慢，可選的做法（評分只算平均 gain 的一部分、或評分成長取代零件效果）都會改動 D1 明定的公式與「舊存檔遷移後評分與舊制相同」，所以留給規格作者決定。固定 P10／P12 收入時第 4–8 季平均名次 2.7–3.3，第 9 季起資金用完而下滑（第 10 季 8.4），與 10.3 的收入問題相同。
- **D5 分配效率**（依審查的獨立基準：每站 42 點、5 季含換季與退費、4 條賽道、3 台車 × 兩種規則 × 6 個種子，基準取三種貪婪分配中最好者）：按比例換季後平均 93.3%，各組 2025 corvid 92.7%、helix 93.0%、vanta 91.5%，2026 corvid 91.2%、helix 95.0%、vanta 96.3%，最差單一種子 87.7%（原 D2 時平均 92.2%、2025 corvid 89.6%、最差 80.8%）。每組都 ≥ 90%，不另外依規則年份分兩組權重。

## 11. 規格作者確認（2026-10-10）

- **接受** §10.4 的 D2 修正：換季時等級 −1、效率按比例保留（`gain' = round(gain × (L−1)/L × 2)/2`），季末開的專案改指向新等級並退還費用差額。理由：「效率 −1」會讓部分成功的損失永久累積，長期研發效果減半（有實測證據）。
- **接受** D1 實測：會依價值選零件的玩家約第 3 季進入前 3（目標原寫 4–6 季）。這是對懂研發的玩家的合理獎勵，且長期上限在前段而非壓倒性領先；目標改為「約 3–5 季」。
- §9／§10.3／§10.4 的待決事項至此全部結案。
