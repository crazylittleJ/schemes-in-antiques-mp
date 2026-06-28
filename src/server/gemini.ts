// v2.0.0 — Gemini 呼叫(generateContent REST)
// 只用一支 fetch,要求結構化 JSON 輸出 {result, thought}。沒有金鑰時回 null,呼叫端退回啟發式。
import { loadConfig } from './config';

export interface SpeechOut { result: string; thought?: string; }

export async function geminiSpeech(systemPrompt: string, userPrompt: string): Promise<SpeechOut | null> {
  const cfg = loadConfig();
  if (!cfg.geminiApiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent?key=${cfg.geminiApiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 256,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { result: { type: 'STRING' }, thought: { type: 'STRING' } },
        required: ['result'],
      },
    },
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000); // 8s 逾時 → 退回啟發式
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (typeof parsed?.result !== 'string') return null;
    return { result: parsed.result, thought: parsed.thought };
  } catch {
    return null;
  }
}

// 通用結構化呼叫:給定 responseSchema,回傳解析後的物件;沒金鑰或失敗回 null。
export async function geminiJSON(systemPrompt: string, userPrompt: string, schema: any): Promise<any | null> {
  const cfg = loadConfig();
  if (!cfg.geminiApiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent?key=${cfg.geminiApiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.6, maxOutputTokens: 256, responseMimeType: 'application/json', responseSchema: schema },
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}
