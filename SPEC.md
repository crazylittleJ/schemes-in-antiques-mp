# 古董局中局 — `GameState + Reducer` 規格 (v1)

語言無關的權威狀態規格。實作可用 TypeScript / Python / 任何語言;此文件只描述**狀態形狀、合法動作、狀態轉移、與每位玩家的可見視圖**。下方型別用 TS 風格的 pseudocode 表示,只為可讀,不綁定語言。

---

## 0. 設計原則

1. **伺服器是唯一真相 (authoritative server)。** Client 只送「意圖 (action)」,所有結算在伺服器。
2. **公開 / 私密分離。** `GameState` 明確切成 `public`(可廣播給全房)與 `secret`(只存伺服器)。隱藏身份遊戲的安全性完全靠這條:祕密欄位**永遠不可**進入同步給所有 client 的資料。
   - 對應 Colyseus:`public` → 房間的 synced Schema;`secret` 與「個人化視圖」→ 用 `client.send()` 單點發給該玩家。
3. **Reducer 純函式語意。** `reduce(state, action) -> { state', effects[] }`。`effects` 是「要私訊給某玩家的訊息」清單(例如鑑定結果、被偷襲通知)。Reducer 不直接做 I/O。
4. **動作皆驗證。** 每個 action 有前置條件;不合法則拒絕(回傳 error effect,不改 state)。

---

## 1. 常數與列舉

### 1.1 生肖獸首 (treasures)

索引 0..11 僅為獸首編號。**平票時的優先序改以「本輪抽出(顯示)順序」**——`roundAnimals` 中較前面者視為較高票(此順序玩家看得到)。

```
ANIMALS = [鼠, 牛, 虎, 兔, 龍, 蛇, 馬, 羊, 猴, 雞, 狗, 豬]   // index 0..11
```

12 獸首 = 6 真 + 6 假。分成 3 輪、每輪 4 個,**每輪恰好 2 真 2 假**。

### 1.2 角色 (roles) 與陣營 (camps)

```
RoleId = 許願 | 方震 | 黃煙煙 | 木戶加奈 | 姬云浮 | 老朝奉 | 藥不然 | 鄭國渠

GOOD 陣營(許願方）= { 許願, 方震, 黃煙煙, 木戶加奈, 姬云浮 }
BAD  陣營(老朝奉方）= { 老朝奉, 藥不然, 鄭國渠 }
```

### 1.3 依人數決定角色組

```
6 人:移除 姬云浮、鄭國渠  → GOOD{許願,方震,黃煙煙,木戶加奈} + BAD{老朝奉,藥不然}   (4+2)
7 人:移除 姬云浮          → GOOD{許願,方震,黃煙煙,木戶加奈} + BAD{老朝奉,藥不然,鄭國渠} (4+3)
8 人:全部 8 角            → GOOD(5) + BAD(3)
```

### 1.4 隊友互認規則

- 只有 `老朝奉` 與 `藥不然` 互相知道對方是誰。
- `鄭國渠` 屬 BAD,但**不知道任何隊友**。
- GOOD 全員互不相認。

### 1.5 階段 (Phase)

```
Phase =
  | LOBBY            // 開房、輸入密碼、選色/入座
  | ROLE_DEAL        // 發身份;老朝奉與藥不然收到彼此身份
  | ROUND_START      // 發 2 籌碼、揭示本輪 4 獸首(真偽隱藏)
  | TURN             // 某玩家回合(鑑定→能力→派票),重複至全員行動
  | SPEECH           // 回合結束發言(絕對發言,順時針)
  | VOTE             // 同時不公開投票(分配籌碼)
  | REVEAL           // 開票、保護前二、揭示第二高票真偽
  | IDENTITY_REVEAL  // 第三輪後若未直接獲勝:互猜身份
  | SCORING          // 計分
  | GAME_END         // 結束(已決定勝負)
```

回合內再細分子步驟(見 §6.3):`AWAIT_IDENTIFY → AWAIT_ABILITY → AWAIT_PASS`。

---

## 2. 資料模型 `GameState`

```
GameState {

  // ── PUBLIC(可同步給全房）─────────────────────────────
  public: {
    phase: Phase
    roomPasswordHash: string            // 僅驗證用,不外送明碼
    playerCount: 6 | 7 | 8
    seatOrder: PlayerId[]               // 順時針座位(固定);長度 = playerCount
    connected: { [PlayerId]: boolean }  // 斷線/重連狀態(Colyseus onDrop/onReconnect 維護)

    roundIndex: 0 | 1 | 2
    roundAnimals: AnimalId[]            // 本輪 4 獸首,抽出順序(即平票優先序);身份公開、真偽不在此公開

    // 回合進行
    turn: {
      startPlayer: PlayerId             // 本輪起始(= 上一輪尾家;第一輪隨機)
      currentPlayer: PlayerId | null
      subStep: AWAIT_IDENTIFY | AWAIT_ABILITY | AWAIT_PASS | null
      actedPlayers: PlayerId[]          // 本輪已行動者(不含 currentPlayer)
      lastPlayer: PlayerId | null       // 尾家(本輪最後行動者)
    }

    // 發言
    speech: { order: PlayerId[], pointer: number } | null

    // 結果
    protected: { animalId: AnimalId, round: number, realRevealed: boolean }[]  // 累積被保護獸首
    revealedReal: { [AnimalId]: boolean }   // 已公開真偽的獸首(第二高票、與終局公開)
    lastTally: { [AnimalId]: number } | null // 最近一次開票的各獸首總票數(個人分配不公開)
    chips: { [PlayerId]: number }            // 各玩家「目前可用」籌碼數(分配內容保密)

    winner: GOOD | BAD | null
    log: PublicLogEntry[]               // 只記公開事件(保護了哪些、第二高票真偽…)
  }

  // ── SECRET(只存伺服器,永不進同步 Schema）──────────────
  secret: {
    roles: { [PlayerId]: RoleId }

    // 獸首真偽全表(不變式:6 真6 假;每輪 2 真2 假)
    treasures: { [AnimalId]: { round: 0|1|2, isReal: boolean } }
    roundLayout: AnimalId[][]           // roundLayout[r] = 該輪 4 獸首(抽出順序,即平票優先序)

    // 木戶加奈 / 黃煙煙 的「隨機某輪無法鑑定」
    blockedRound: { [PlayerId]: 0|1|2 } // 只對這兩角設定

    jiPermanentlyDisabled: boolean      // 姬云浮曾被偷襲 → 整場無法鑑定

    pendingGank: Set<PlayerId>          // 待生效的偷襲(於該玩家下一回合開始時消耗)

    // 本輪能力效果(每輪 ROUND_START 重置)
    roundEffects: {
      laoSwapActive: boolean            // 老朝奉本輪已發動真假互換(之後行動者受影響)
      coveredAnimal: AnimalId | null    // 鄭國渠本輪覆蓋的獸首
    }

    // 投票收集(VOTE 階段;開票前保密)
    pendingVotes: { [PlayerId]: { [AnimalId]: number } }

    // 終局互猜
    guesses: {
      laoGuessXu: PlayerId | null       // 老朝奉猜誰是許願
      yaoGuessFang: PlayerId | null     // 藥不然猜誰是方震
      goodGuessLao: { [PlayerId]: PlayerId }  // 每位好人猜誰是老朝奉
    }

    turnGanked: boolean                 // 當前 currentPlayer 本回合是否被偷襲(turn 開始時判定)
  }
}
```

---

## 3. 玩家可見視圖 (redacted view)

伺服器對「每位玩家」各算一份視圖。原則:**公開的給全部,私密的只給本人。**

| 資訊 | 可見對象 |
|---|---|
| `public.*`(階段、輪次、本輪 4 獸首身份、已保護獸首、已公開真偽、票數總計、各人剩餘籌碼、連線狀態) | 全房 |
| 自己的 `RoleId` | 僅本人 |
| 隊友身份 | 僅 `老朝奉` ↔ `藥不然`(互看);其餘看不到 |
| 自己每次鑑定看到的結果(真/贗/無法鑑定) | 僅本人 |
| `方震` 查看到的某玩家陣營 | 僅方震本人 |
| 「你被藥不然偷襲了」通知 | 僅被偷襲者 |
| 自己投票的籌碼分配 | 僅本人(開票後只公開**各獸首總票數**) |
| 獸首真偽全表、誰是誰、老朝奉/鄭國渠是否發動 | **永不外送**(僅伺服器) |

> 關鍵:老朝奉的真假互換與鄭國渠的覆蓋,在視圖上「看不出來」——受影響的玩家只是收到一個(可能被竄改的)鑑定結果。這正是隱藏資訊的核心,所以這些效果只能存在 `secret`。

---

## 4. 初始化 (Setup)

### 4.1 發身份 `dealRoles(playerCount)`

1. 取 §1.3 對應人數的角色集合,洗牌後一一指派給 `seatOrder` 上的玩家 → `secret.roles`。
2. 對身為 `木戶加奈`、`黃煙煙` 的玩家,各隨機抽一個輪次 `0|1|2` 存入 `secret.blockedRound`。
3. `effects`:私訊每位玩家自己的角色;私訊 `老朝奉`、`藥不然` 對方的身份。

### 4.2 獸首配置 `layoutTreasures()`

不變式:

- 全 12 獸首恰好 **6 真 6 假**。
- 切成 3 組(= 3 輪),每組 4 個,**每組恰好 2 真 2 假**。
- 每組內**維持抽出順序**(不另排序)→ `roundLayout[r]`(此順序即顯示順序與平票優先序)。

產生方式(等價於原 repo 的做法):先決定每輪的 `[真,真,假,假]` 並各自洗牌,再把 12 獸首隨機分派到三組、組內排序。結果寫入 `secret.treasures` 與 `secret.roundLayout`。

### 4.3 起始

- `phase = ROUND_START`,`roundIndex = 0`,`chips[p] = 0`(ROUND_START 會 +2)。
- 第一輪 `startPlayer` = 隨機一名玩家。

---

## 5. Action 清單

| Action | 發送者 | Payload | 階段 |
|---|---|---|---|
| `CREATE_GAME` | 房主 | `{ password, playerCount }` | LOBBY |
| `JOIN_GAME` | 任意 | `{ name/color, password }` | LOBBY |
| `START_GAME` | 房主 | `{}`(人數已滿) | LOBBY → ROLE_DEAL |
| `IDENTIFY` | currentPlayer | `{ animalIds: AnimalId[] }`(許願可 2 個,其餘 1 個) | TURN/AWAIT_IDENTIFY |
| `VIEW_FACTION` | currentPlayer(方震) | `{ targetId }` | TURN/AWAIT_IDENTIFY |
| `USE_ABILITY` | currentPlayer | 見 §6.4 | TURN/AWAIT_ABILITY |
| `SKIP_ABILITY` | currentPlayer | `{}` | TURN/AWAIT_ABILITY |
| `PASS_TURN` | currentPlayer | `{ targetId }`(本輪未行動者) | TURN/AWAIT_PASS |
| `SPEECH_DONE` | 發言中玩家 | `{}` | SPEECH |
| `SUBMIT_VOTE` | 任意玩家 | `{ allocation: {AnimalId: count} }` | VOTE |
| `GUESS_XU` | 老朝奉 | `{ targetId }` | IDENTITY_REVEAL |
| `GUESS_FANG` | 藥不然 | `{ targetId }` | IDENTITY_REVEAL |
| `GUESS_LAO` | 每位好人 | `{ targetId }` | IDENTITY_REVEAL |

部分轉移為**自動**(伺服器內部觸發,非玩家送出):`ROUND_START`、進入 `SPEECH`/`VOTE`/`REVEAL`、終局判定、`SCORING`。

---

## 6. Reducer 語意

### 6.1 `ROUND_START`(自動)

```
chips[p] += 2  for all p           // 拿兩個籌碼進擋板
roundAnimals = roundLayout[roundIndex]   // 揭示本輪 4 獸首(身份公開,真偽隱藏)
roundEffects = { laoSwapActive: false, coveredAnimal: null }
turn = { startPlayer, currentPlayer: startPlayer, actedPlayers: [], lastPlayer: null, subStep: null }
onTurnBegin(currentPlayer)
phase = TURN
```

### 6.2 `onTurnBegin(p)`(內部)

```
if p ∈ pendingGank:
    pendingGank.delete(p)
    if roles[p] == 姬云浮: jiPermanentlyDisabled = true   // 永久失能
    turnGanked = true
    effect → 私訊 p:「你被藥不然偷襲了」
    subStep = AWAIT_PASS          // 本回合不可鑑定、不可發動能力,只能派票
else:
    turnGanked = false
    subStep = AWAIT_IDENTIFY
```

### 6.3 回合三步驟

**步驟一 — 鑑定 / 查陣營(`AWAIT_IDENTIFY`)**

- `IDENTIFY { animalIds }`
  - 前置:`turnGanked == false`;角色非方震;`animalIds` ⊆ 本輪 4 獸首;長度 = (許願 ? 1或2 : 1)。
  - 對每個 `a` 算 `resolveAppraisal(state, p, a)`(§7),結果**私訊** p。
  - `subStep = AWAIT_ABILITY`。
- `VIEW_FACTION { targetId }`(僅方震,取代鑑定)
  - 私訊方震:`camp(targetId)`(只回 GOOD/BAD)。
  - `subStep = AWAIT_ABILITY`。

**步驟二 — 發動能力(`AWAIT_ABILITY`)**

- `USE_ABILITY {...}`(見 §6.4)或 `SKIP_ABILITY`。被偷襲的回合此步直接略過。
- 完成後 `subStep = AWAIT_PASS`。

**步驟三 — 派票(`AWAIT_PASS`)**

```
remaining = seatOrder \ actedPlayers \ {currentPlayer}
if remaining 非空:
    PASS_TURN { targetId ∈ remaining }
    actedPlayers.add(currentPlayer)
    currentPlayer = targetId
    onTurnBegin(targetId)
else:   // 沒有可派的人 → 當前玩家是尾家
    actedPlayers.add(currentPlayer)
    lastPlayer = currentPlayer
    enterSpeech()
```

> 動態派票:回合順序由玩家指定,不是固定座位。「尾家」= 本輪最後行動者;下一輪起始 = 本輪尾家(§8 設定)。

### 6.4 各角色能力(`USE_ABILITY`)

| 角色 | Payload | 效果 |
|---|---|---|
| `老朝奉` | `{}` | `roundEffects.laoSwapActive = true`。本輪**在他之後行動**的玩家鑑定時真假互換(GOOD 受影響、BAD 與姬云浮不受影響;見 §7)。 |
| `藥不然` | `{ targetId }` | `applyGank(targetId)`:`pendingGank.add(targetId)`;**若 target 是方震,則許願一併加入** `pendingGank`。 |
| `鄭國渠` | `{ animalId }` | `roundEffects.coveredAnimal = animalId`。本輪在他之後鑑定該獸首者,只會看到「無法鑑定」。 |
| 其餘角色 | — | 無可發動能力,步驟二一律 `SKIP_ABILITY`。 |

`gank` 在 target 的**下一個回合開始**消耗(可能落在本輪稍後或下一輪)。

---

## 7. 核心解析:`resolveAppraisal(state, p, animalId)`

回傳 `REAL | FAKE | UNIDENTIFIABLE`。**優先序**(由上到下,先命中者勝):

```
1. 無法鑑定能力判定 canIdentifyThisTurn(p) == false → UNIDENTIFIABLE
       canIdentifyThisTurn(p):
         if roles[p] ∈ {木戶加奈, 黃煙煙} and roundIndex == blockedRound[p]: return false
         if roles[p] == 姬云浮 and jiPermanentlyDisabled: return false
         return true
   (被偷襲的回合不會走到這裡:onTurnBegin 已把 subStep 跳到 AWAIT_PASS。)

2. 鄭國渠覆蓋:roundEffects.coveredAnimal == animalId → UNIDENTIFIABLE
       (能呼叫本函式代表 p 正在行動 = 在鄭國渠發動之後,故必受影響。)

3. base = treasures[animalId].isReal ? REAL : FAKE

4. 老朝奉真假互換:
       if roundEffects.laoSwapActive
          and camp(p) == GOOD
          and roles[p] != 姬云浮:
              base = (base == REAL ? FAKE : REAL)
       // 顯示值被換,但 treasures[].isReal 的「本質」不變(保護/計分用本質)

5. return base
```

要點:

- **本質不變**:互換只改「玩家看到的顯示」,計分與保護一律用 `treasures[].isReal`。
- **BAD 全員**(老朝奉、藥不然、鄭國渠)免疫互換。
- **姬云浮**免疫互換(步驟 4),但仍受偷襲永久失能(步驟 1)與覆蓋(步驟 2)影響。
- 覆蓋優先於互換(看不到的東西無從互換)。

---

## 8. 發言、投票、開票

### 8.1 `enterSpeech()`

```
i = indexOf(seatOrder, lastPlayer)
speech.order = rotate(seatOrder, i + 1)   // 從尾家「左手邊」起,順時針一圈
speech.pointer = 0
phase = SPEECH
```

`SPEECH_DONE` → `pointer++`;`pointer == playerCount` → `enterVote()`。發言為社交/絕對發言階段,**不改變遊戲狀態**(可搭配計時器)。

### 8.2 `VOTE`

`SUBMIT_VOTE { allocation }`:

- 前置:`allocation` 的 key ⊆ 本輪 4 獸首;`sum(values) <= chips[p]`;value 為非負整數。
- 存入 `secret.pendingVotes[p]`(保密)。
- 當全員(`playerCount` 人)皆已送出 → `reveal()`。

### 8.3 `reveal()`(開票)

```
tally[a] = Σ_p pendingVotes[p][a]          // 各獸首總票數
for p: chips[p] -= sum(pendingVotes[p])    // 用掉的扣除;未用的留到下一輪(ROUND_START 再 +2)

// 排序:票數降冪;平票時以 roundAnimals「出現順序」靠前者視為較高
ranked = sortByVotesDescThenAppearanceOrder(roundAnimals)
top1 = ranked[0]; top2 = ranked[1]

protected += { top1, round, realRevealed: false }   // 第一高票:真偽此時不公開
protected += { top2, round, realRevealed: true  }   // 第二高票:此時公開真偽
revealedReal[top2] = treasures[top2].isReal

lastTally = tally
roundEffects = reset
nextStartPlayer = lastPlayer                // 尾家成為下一輪起始
clear pendingVotes
phase = REVEAL → 接 §9 轉移
```

> 兩個都被「保護」並計入計分(若為真各 +1);差別只在**第二高票當下公開真偽,第一高票暫不公開**(終局再揭曉)。

---

## 9. 階段機(轉移總表)

```
LOBBY --START_GAME--> ROLE_DEAL --auto--> ROUND_START --auto--> TURN
TURN  --(全員行動完)--> SPEECH --(發言完)--> VOTE --(全員投票)--> REVEAL

REVEAL:
  if roundIndex < 2:
      roundIndex++; startPlayer = nextStartPlayer
      --auto--> ROUND_START ...
  else (第三輪結束):
      protectedRealCount = count(protected where treasures[a].isReal)
      if protectedRealCount >= 6:
          winner = GOOD; --> GAME_END           // 直接找回六真品,即勝
      else:
          --> IDENTITY_REVEAL

IDENTITY_REVEAL --(所有必填猜測到齊)--> SCORING --auto--> GAME_END
```

---

## 10. 計分與勝負(`SCORING`)

好人方(許願陣營)總分:

```
score  = protectedRealCount                              // 每保護一個真品 +1(上限 6)
score += (guesses.laoGuessXu   != playerOf(許願)) ? 2 : 0 // 許願未被老朝奉找到 +2
score += (guesses.yaoGuessFang != playerOf(方震)) ? 1 : 0 // 方震未被藥不然找到 +1

goodFoundLao = count(g ∈ GOOD where guesses.goodGuessLao[g] == playerOf(老朝奉))
threshold    = ceil(goodCount / 2)                        // 「過(含)半數」
score += (goodFoundLao >= threshold) ? 1 : 0              // 過半好人找到老朝奉 +1

winner = (score >= 6) ? GOOD : BAD
```

`GAME_END` 時可公開全部真偽、全部身份、最終分數。

---

## 11. 待確認 / 開放問題

寫程式前建議對照官方 app 行為確認這幾點(目前先採註明的預設):

1. **原 repo 的兩個 50% 隨機 flag**:`isLaiEffected`、`isXuDisplayFirstDirectorFactionInfo` 用途不明(可能是某個邊角規則或方震/老朝奉顯示順序的處理)。本規格未納入,需確認是否為正式規則。
2. **發言方向**:本規格把「尾家左手邊」定為座位順時針的下一位。請確認你們桌面實體的左/右與順時針定義一致。
3. **方震查陣營**:本規格只回 GOOD/BAD(陣營),不回具體角色。確認是否如此。
4. **鄭國渠覆蓋對象**:本規格允許覆蓋本輪 4 獸首中任一個。確認是否有「不能覆蓋已被鑑定過的」之類限制。
5. **老朝奉互換範圍**:本規格設為「僅當輪、對之後行動者」。確認不是跨輪持續。
6. **被偷襲回合**:本規格設為「不可鑑定、不可發動能力,但仍須派票」。確認偷襲是否也禁止派票(若禁止,則需由系統自動代為派給隨機未行動者)。
7. **「過(含)半數」門檻**:本規格採 `ceil(goodCount/2)`(4 好人→2、5 好人→3)。確認邊界。
8. **平票超過兩名並列**:本規格一律以「票數降冪、生肖索引升冪」全排序後取前二,可涵蓋多重平票。確認無其他特例。

---

*下一步(階段二):把本規格落成 Colyseus `GudongRoom` —— `public` 對應 synced Schema、`secret` 與 effects 對應 `client.send()`、`onDrop/onReconnect` 接重連、`onAuth` 接密碼。*
