# 古董局中局 — 多人連線版

把單機「傳手機」版改成每人各自手機連線、重整不掉、出門也能玩。
權威伺服器(Colyseus)+ React 前端,打包成**單一 Render web service**。

## v2.0.0:AI 玩家與聊天
- **AI bots**:房主可在大廳「+ 加入 AI 玩家」。AI 由 12 位人設中抽出(含會說人話的動物),顯示為 `Leo(AI)` 並帶頭像。
- **至少 1 位真人**:開局強制至少 1 名真人;遊戲中若已無任何真人在場,房間自動關閉(不讓 bot 空跑佔資源)。
- **保留暱稱**:這 12 個名字(及其 `(AI)` 變體)一律保留給 AI,真人無法使用(無論當局是否真的加入 AI)。
- **每輪聊天**:發言階段 AI 依「角色 + 人設」發言,訊息以通訊軟體氣泡呈現、頭像在側,**累積記錄到遊戲結束**。真人只有在**輪到自己發言**時才能輸入,可多句與 AI 互動。
- **發言生成**:有設定 Google Gemini 金鑰時用 Gemini 生成;沒有金鑰則退回 persona 啟發式發言(離線也能玩)。
- **金鑰設定(不進版控)**:設環境變數 `GEMINI_API_KEY`(Render 上設定),或在專案根目錄放 `config.json`(已 gitignore)。範本見 `config.example.json`;模型預設 `gemini-2.5-flash-lite`,可用 `GEMINI_MODEL` 覆寫。
- 機制要點:bot 只看「自己看得到的資訊」(自己的角色 + 私訊 + 公開盤面 + 聊天),不碰祕密狀態;所有 bot 動作都先經引擎 `applyAction` 驗證才採用,天然不犯規。投票沿用真機制(投籌碼保護獸首),非投人。

## 技術棧
- 伺服器:Colyseus 0.16(Node/TS)— 房間、重連、廣播
- 前端:Vite + React + TypeScript + `colyseus.js`
- 遊戲引擎:`src/engine/` 純函式,語言無關,對應 `SPEC.md`,附測試
- 狀態:記憶體(單一房間、一次一局即夠);免費層

## 結構
```
src/engine/    遊戲規則(types / engine / smoke.test) — 已驗證
src/server/    Colyseus:schema(公開狀態)/ GudongRoom / index(同源服務前端)
client/        Vite + React 前端
SPEC.md        GameState + reducer 規格 v1
```

## 安全模型(隱藏身份的關鍵)
- 伺服器是唯一真相。client 只送「意圖」,`GudongRoom` 注入經驗證的座位 id,忽略前端自稱身份。
- **公開狀態**(輪次、本輪獸首、誰行動、保護結果)→ 同步 Schema,全房可見。
- **祕密資訊**(身份、真偽、能力發動、個人鑑定結果)→ 只用 `client.send()` 單點發給該玩家,**永不進同步 Schema**。

## 本機開發
```bash
npm install
npm run test          # 跑引擎測試(應 130 passed）
npm run dev:server    # 伺服器 :2567
npm run dev:client    # 前端 :5173(會自動連 ws://localhost:2567)
```
開多個瀏覽器分頁,第一個進房者輸入密碼+人數即房主,其餘輸入相同密碼加入,房主按「開始遊戲」。

## 部署到 Render(單一 service)
1. 推到 GitHub。
2. Render → New → Web Service,連這個 repo(內含 `render.yaml`)。
3. Build:`npm install && npm run build`;Start:`npm start`;Plan:Free。
4. 完成後給大家網址即可。第一個連入的人吃一次約一分鐘冷啟動,之後遊戲進行中有連線就不會休眠。

## 重連(重整不掉)
- 前端把 `room.reconnectionToken` 存 localStorage;重整/鎖屏回來自動 `client.reconnect()`。
- 伺服器 `onLeave` 用 `allowReconnection(client, 60)` 保留座位 60 秒,回來後補送該玩家的私訊歷史。
- 升級到 Colyseus 0.17 可改用 `onDrop/onReconnect`,握手更快。

## 密碼
`GudongRoom.onAuth()` 驗證房間密碼;不符即拒絕加入,同時擋掉公開網址被陌生人連上叫醒免費 instance。

## 已知範圍 / 後續
- 前端目前是「能完整跑完一局」的功能版 UI,刻意樸素好讓你重新設計樣式。
- 引擎已涵蓋 SPEC.md 全部規則與邊角(老朝奉互換僅影響其後的好人且姬云浮免疫、藥不然連帶偷襲方震→許願、姬云浮永久失能、木戶/黃封鎖輪、動態派票、平票以本輪出現順序為優先序、計分與勝負)。

---

## v2.0.0 — AI 玩家與對話

**加入 AI bot**:在大廳由房主按「+ 加入 AI 玩家」即可加入電腦玩家(從 12 位人設中抽出,顯示為 `Leo(AI)` 等;動物角色也說人話)。可移除、可混合真人與 AI。

- **至少 1 位真人**:不允許純 AI 開局;遊戲進行中若所有真人都離開,房間會自動關閉(不讓 bot 空跑佔資源)。
- **不允許旁觀者**:每個連線都是入座玩家。
- **保留暱稱**:12 個 AI 名字(及其 `(AI)` 變體)真人不可使用,無論當局是否真的加入 AI。
- **bot 不可被接管**:斷線重連 / 同名接管只作用於真人座位,人類不會接管 bot 席。

**對話面板(通訊軟體風格)**:遊戲開始後底部出現對話面板,顯示每位玩家的頭像與發言,**累積記錄到遊戲結束**。每一輪發言階段,AI 會依自己的「角色 + 人設」發言;真人**只有輪到自己發言**時才能輸入訊息與 AI 互動。

**AI 發言金鑰(可選)**:預設用內建的「人設啟發式」發言,**零 API、可直接部署**。若要改用 Google Gemini 生成更自然的發言:
- Render 上設定環境變數 `GEMINI_API_KEY`(建議),或
- 本機放 `config.json`(已 gitignore,不會上 GitLab),格式見 `config.example.json`。
- 可用 `GEMINI_MODEL` 指定模型(預設 `gemini-2.5-flash-lite`)。沒有金鑰或呼叫逾時/失敗時自動退回啟發式發言,不影響遊戲流程。

> 人設與發言規則改寫自友人的 n8n 工作流(好人守護真品揪內鬼、壞人顛倒真假帶風向);**投票仍是本遊戲的「投籌碼保護獸首」機制**,未沿用該流程的狼人殺式「投人」。
