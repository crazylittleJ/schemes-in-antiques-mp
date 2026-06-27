// v2.0.0 — 設定載入
// Google API key 不進版控:優先讀環境變數 GEMINI_API_KEY(Render 上設定),
// 否則讀專案根目錄的 config.json(已加入 .gitignore,不會推上 GitLab)。
import fs from 'fs';
import path from 'path';

export interface AppConfig {
  geminiApiKey: string | null;
  geminiModel: string; // 預設用便宜的 flash-lite
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  let fileCfg: any = {};
  try {
    const p = path.resolve(process.cwd(), 'config.json');
    if (fs.existsSync(p)) fileCfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    /* 忽略壞掉的 config.json,退回環境變數 */
  }
  cached = {
    geminiApiKey: process.env.GEMINI_API_KEY || fileCfg.geminiApiKey || null,
    geminiModel: process.env.GEMINI_MODEL || fileCfg.geminiModel || 'gemini-2.5-flash-lite',
  };
  return cached;
}

export const hasGemini = (): boolean => !!loadConfig().geminiApiKey;
