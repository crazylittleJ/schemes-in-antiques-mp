// v2.0.0 — 發言提示詞(改寫自友人 Good/Bad 共用提示;情報改對應真實機制:鑑定真偽 + 保護獸首)
import { Camp, RoleId, ANIMALS } from '../engine/types';
import { ROLE_STYLE } from './personas';

export interface SpeechContext {
  displayName: string;          // 例:Leo(AI)
  role: RoleId;
  camp: Camp;
  roundIndex: number;           // 0..2
  roundAnimals: number[];       // 本輪獸首 id
  myIntel: string;              // 本輪自己的鑑定/查驗結果(自然語句)
  chatHistory: string;          // 近期聊天逐字(含人類與其他 AI)
}

const campStrategy = (camp: Camp) =>
  camp === 'GOOD'
    ? `【好人陣營:守護真品、揪出偽裝者】
- 以你自己的真實鑑定結果為依據,明確主張要保護哪些真品。
- 質疑鑑定含糊或刻意抹黑的人,要求對方解釋。
- 被懷疑時,用你的推理過程當證據,設法讓多數好人達成共識。`
    : `【壞人陣營:混淆視聽、誤導好人】
- 可故意顛倒真假,誘導好人去保護贗品。
- 對邏輯清楚的好人玩家,指責他「帶風向」,製造內鬥。
- 表現得像在積極查案,把嫌疑轉嫁給好人。嚴禁洩漏陣營。`;

export function buildSpeechPrompts(ctx: SpeechContext): { system: string; user: string } {
  const st = ROLE_STYLE[ctx.role];
  const system = `你正在玩線上版桌遊《古董局中局》,你是其中一位玩家。

# 角色設定(嚴禁洩漏)
- 顯示名稱:${ctx.displayName}
- 真實角色:${ctx.role}(${st.campLabel})
- 個性:${st.style}
- 語氣:${st.tone}
- 口吻範例:「${st.example}」

${campStrategy(ctx.camp)}

# 嚴格規範
- 只輸出「一句話」的發言,維持上面的個性與語氣(就一句,不要分成多句或條列)。
- 長度約 30–90 個字,不要太短、也不要超過 150 字。
- 嚴禁直接說出自己的真實角色或陣營,但可以偽裝、可以針對別人。
- 以你「本輪自己的情報」為主要依據來描述,避免過度華麗的形容。
- 最終只回傳純 JSON:{"result":"你的發言","thought":"你的內部推理(不會被其他玩家看到)"}。不要加 Markdown。`;

  const animals = ctx.roundAnimals.map((a) => ANIMALS[a]).join('、');
  const user = `# 本輪資訊(第 ${ctx.roundIndex + 1} 輪)
- 桌上正在鑑定的獸首:${animals}
- 你本輪的情報:${ctx.myIntel || '本輪你沒有取得明確情報。'}

# 近期聊天紀錄
${ctx.chatHistory || '(目前還沒有人發言,請你帶起話題。)'}

請依你的角色與情報,輸出這一輪的發言。`;
  return { system, user };
}
