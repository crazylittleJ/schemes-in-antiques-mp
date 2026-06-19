# 古董局中局 — 多人連線版

把單機「傳手機」版改成每人各自手機連線、重整不掉、出門也能玩。
權威伺服器(Colyseus)+ React 前端,打包成**單一 Render web service**。

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
- 引擎已涵蓋 SPEC.md 全部規則與邊角(老朝奉互換、藥不然連帶偷襲方震→許願、姬云浮永久失能、木戶/黃封鎖輪、動態派票、平票生肖序、計分與勝負)。
