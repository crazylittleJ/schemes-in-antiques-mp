import http from 'http';
import path from 'path';
import express from 'express';
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GudongRoom } from './GudongRoom';

const port = Number(process.env.PORT) || 2567;
const app = express();

// 健康檢查(Render 用)
app.get('/healthz', (_req, res) => res.send('ok'));

// 房間 1~5 占用狀態(登入畫面用)
app.get('/rooms', async (_req, res) => {
  try {
    const list = await matchMaker.query({ name: 'gudong' });
    res.json(list.map((r: any) => ({ slot: r.metadata?.slot, clients: r.clients, maxPlayers: r.metadata?.maxPlayers, started: r.metadata?.started, ended: r.metadata?.ended })));
  } catch { res.json([]); }
});

// 提供打包後的前端;SPA fallback(排除 colyseus 的 matchmaking 路由)
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^(?!\/(matchmake|colyseus)).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    pingInterval: 2000,   // 每 2 秒 ping 一次
    pingMaxRetries: 2,    // 連續 2 次無回應即視為斷線(約 4–6 秒偵測到),讓重整後能盡快接管座位
  }),
});
gameServer.define('gudong', GudongRoom).filterBy(['slot']);

gameServer.listen(port).then(() => {
  console.log(`古董局中局 伺服器啟動於 :${port}`);
});
