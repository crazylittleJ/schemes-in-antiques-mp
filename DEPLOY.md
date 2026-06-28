# 部署到 Render(免費,單一 service)

這份 repo 已內建 `render.yaml`,部署走 Render 的 **Blueprint** 流程最省事。
免費層:連 GitHub repo → 自動偵測 Node → 給你一個 HTTPS 網址,不需信用卡。
(免費 web service 閒置 15 分鐘會休眠,下次請求約一分鐘喚醒;每個 workspace 每月 750 小時額度,玩一局綽綽有餘。)

---

## 步驟 0 — 先把 repo 推上 GitHub

Render 一定要從 Git repo 部署。解壓後,在專案資料夾裡:

```bash
git init
git add .
git commit -m "古董局中局 多人連線版"

# 先到 github.com 開一個新的「空」repo(不要勾 add README),取得網址後:
git remote add origin https://github.com/<你的帳號>/gudong-mp.git
git branch -M main
git push -u origin main
```

之後每次改完 code,只要:

```bash
git add .
git commit -m "說明這次改了什麼"
git push
```

Render 會自動重新建置並部署(見步驟 3)。

---

## 步驟 1 — 用 Blueprint 部署(推薦)

1. 登入 [render.com](https://render.com)(用 GitHub 帳號登入最快)。
2. 右上 **New → Blueprint**。
3. 連接 GitHub、選 `gudong-mp` 這個 repo。
4. 幫 Blueprint 命名、分支選 `main`,按 **Apply / Deploy Blueprint**。
   Render 偵測到 `render.yaml` 後會自動建立一個 **free plan 的 web service**:
   - Build:`npm install && npm run build`
   - Start:`npm start`
   - Health Check:`/healthz`
   - 這些都不用手動填。
5. 等幾分鐘建置完成,點進該 service 取得網址,形如
   `https://gudong-xxxx.onrender.com`。

> 若 Blueprint 介面說找不到 `render.yaml`,通常是還沒 push 上去;確認步驟 0 完成後按 **Retry**。

---

## 步驟 2 —(備案)手動建立 Web Service

若不想用 Blueprint,可改:**New → Web Service** → 選 repo,手動填:

| 欄位 | 值 |
|---|---|
| Runtime | `Node` |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Instance Type | **Free** |
| Health Check Path（Advanced） | `/healthz` |

按建立即可。

---

## 步驟 2.5 — 設定 Gemini API 金鑰(讓 AI 玩家用 Gemini 發言/投票)

AI bot 不需要金鑰也能玩(會用內建的 persona 啟發式發言與決策樹投票)。
**有設定 `GEMINI_API_KEY` 時**,AI 的發言與投票會改由 Google Gemini 生成(更生動、會回嘴);呼叫失敗或逾時會自動退回啟發式,不會卡關。

本 repo 的 `render.yaml` 使用 `fromGroup: GuDong` 這個**環境變數群組**,設定方式:

1. Render 左側 **Env Groups → New Environment Group**,名稱輸入 `GuDong`。
2. 在群組裡新增變數:
   - Key:`GEMINI_API_KEY`,Value:你的 Google Gemini API 金鑰([Google AI Studio](https://aistudio.google.com/apikey) 可免費取得)。
   - (選用)`GEMINI_MODEL`,預設 `gemini-2.5-flash-lite`;想換模型再填。
3. 儲存後,Blueprint 部署時會自動把這個群組掛到 service 上(因為 `render.yaml` 寫了 `fromGroup: GuDong`)。已部署的話按一次 **Manual Deploy / Clear cache & deploy** 生效。

> 金鑰**不要**寫進程式或推上 Git。本機開發可改放專案根目錄的 `config.json`(已 gitignore;範本見 `config.example.json`),或設環境變數 `GEMINI_API_KEY`。

**用量**:免費層 Gemini(flash-lite)每分鐘/每日有額度上限。一局 6–8 人、3 輪,AI 發言+回嘴+投票大約數十次呼叫,屬於很小的用量;若同時開很多房或頻繁遊玩才需要留意額度,屆時呼叫失敗也只是自動退回啟發式,遊戲仍可進行。

---

## 步驟 3 — 部署後

- 打開 `onrender.com` 網址就是遊戲大廳。
  **第一個進房的人**設密碼 + 人數當房主;其他人用**同一個網址、輸入同密碼**加入,房主按「開始遊戲」。
  前端會自動連同源的 WebSocket,不需改任何設定。
- **冷啟動**:很久沒人用時,第一個連入者等約一分鐘喚醒服務;之後有人連著、有 socket 訊息往來就不會休眠,一局玩到底不會斷。
- **更新 code**:push 到 `main`,Render 預設自動重建並部署,不用再進 dashboard。

---

## 常見狀況

- **建置要等三五分鐘**:免費層正常現象,耐心一下。
- **台灣連線有點延遲**:Render 預設單一地區(美國);回合制桌遊基本感覺不出來。要更低延遲再考慮付費換地區,或自架(見下)。
- **想要永遠在線、零冷啟動且免費**:把這個專案跑在自己的機器(例如 Raspberry Pi)上,再用 Cloudflare Tunnel 對外,即可 $0 且不休眠。需要的話可另外給你步驟。

---

## 本機開發(對照用)

```bash
npm install
npm run test        # 測試:引擎 172 + bot 全自動整局 2551,全綠
npm run dev:server  # 伺服器 :2567
npm run dev:client  # 前端 :5173(自動連 ws://localhost:2567)
```
