import http from 'http';
import path from 'path';
import express from 'express';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GudongRoom } from './GudongRoom';

const port = Number(process.env.PORT) || 2567;
const app = express();

// 健康檢查(Render 用)
app.get('/healthz', (_req, res) => res.send('ok'));

// 提供打包後的前端;SPA fallback(排除 colyseus 的 matchmaking 路由)
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^(?!\/(matchmake|colyseus)).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const httpServer = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
gameServer.define('gudong', GudongRoom);

gameServer.listen(port).then(() => {
  console.log(`古董局中局 伺服器啟動於 :${port}`);
});
