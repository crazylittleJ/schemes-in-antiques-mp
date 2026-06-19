import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開發時前端跑在 5173,WebSocket 連到本機 2567 的 Colyseus。
// 正式環境前端由伺服器同源提供,自動連同源。
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: 'dist' },
});
