// v2.0.0 — 發言/投票提示詞(改寫自友人 Good/Bad 共用提示;情報改對應真實機制:鑑定真偽 + 保護獸首)
import { Camp, RoleId, ANIMALS } from '../engine/types';
import { ROLE_STYLE } from './personas';

export interface SpeechContext {
  displayName: string;          // 例:Leo(AI)
  role: RoleId;
  camp: Camp;
  personaVoice: string;         // 此 AI 的說話語氣/性格(來自 persona.voice)
  roundIndex: number;           // 0..2
  roundAnimals: number[];       // 本輪獸首 id
  myIntel: string;              // 本輪自己的鑑定/查驗結果(自然語句)
  chatHistory: string;          // 近期聊天逐字(含人類與其他 AI)
  replyTo?: { name: string; text: string } | null; // 即時回嘴:要針對誰的哪句話回應
}

const campStrategy = (camp: Camp) =>
  camp === 'GOOD'
    ? `【好人陣營:守護真品、揪出偽裝者】
- 以你自己的真實鑑定結果為依據,明確主張要保護哪些真品。
- 質疑鑑定含糊或刻意抹黑的人,要求對方解釋。
- 被懷疑時,用你的推理過程當證據,設法讓多數好人達成共識。`
    : `【壞人陣營:混淆視聽、誤導好人】
- 你的目標是讓好人去保護「贗品」、放掉真品。
- 不要每一輪都顛倒真假,那樣很快會被識破。請「看情況」決定說真話或假話:
  · 有時故意講真話、配合多數,建立信任、降低嫌疑;
  · 關鍵輪再放假消息,把好人帶往贗品,或在某件真品上灑疑點。
- 對邏輯清楚、快要帶起共識的好人,可指責他「太武斷、在帶風向」,製造內鬥。
- 嚴禁洩漏自己的陣營或隊友。`;

// 角色專屬補充(例如方震必須偽裝)
function roleExtra(role: RoleId): string {
  if (role === '方震') {
    return `\n# 方震偽裝守則(極重要)
- 你其實是警探,劇情中「不會鑑寶」,你的真本事是暗中查出別人的陣營。
- 但你絕對不能露出查案、辦案、警探的口吻(例如「講求證據」「別搞小動作」這種話太明顯,禁止)。
- 你必須假裝自己是懂鑑寶的內行,用「包漿、銹色、胎口、形制、到代」等行話來包裝你的判斷,讓別人以為你是靠眼力在鑑定。`;
  }
  return '';
}

export function buildSpeechPrompts(ctx: SpeechContext): { system: string; user: string } {
  const st = ROLE_STYLE[ctx.role];
  const system = `你正在玩線上版桌遊《古董局中局》,你是其中一位玩家。

# 你的人設(說話風格,務必貫徹)
- 顯示名稱:${ctx.displayName}
- 性格與語氣:${ctx.personaVoice}

# 你的祕密角色(嚴禁洩漏)
- 真實角色:${ctx.role}(${st.campLabel})
- 角色個性:${st.style}
- 角色語氣:${st.tone}
- 口吻範例:「${st.example}」
${roleExtra(ctx.role)}

${campStrategy(ctx.camp)}

# 嚴格規範
- 把「人設語氣」與「角色立場」融合:用你這個角色(年紀/物種/性格)會有的口吻,講出符合你陣營利益的話。
- 只輸出「一句話」的發言(就一句,不要分成多句或條列)。
- 長度約 30–90 個字,不要太短、也不要超過 150 字。
- 嚴禁直接說出自己的真實角色或陣營,但可以偽裝、可以針對別人。
- 以你「本輪自己的情報」為主要依據,避免過度華麗的空話。
- 最終只回傳純 JSON:{"result":"你的發言","thought":"你的內部推理(不會被其他玩家看到)"}。不要加 Markdown。`;

  const animals = ctx.roundAnimals.map((a) => ANIMALS[a]).join('、');
  const replyBlock = ctx.replyTo
    ? `\n# 你要回應的對象(請直接針對這句話回嘴/回應,稱呼對方名字)
${ctx.replyTo.name} 剛剛說:「${ctx.replyTo.text}」`
    : '';
  const user = `# 本輪資訊(第 ${ctx.roundIndex + 1} 輪)
- 桌上正在鑑定的獸首:${animals}
- 你本輪的情報:${ctx.myIntel || '本輪你沒有取得明確情報。'}
${replyBlock}

# 近期聊天紀錄
${ctx.chatHistory || '(目前還沒有人發言,請你帶起話題。)'}

請依你的人設、角色與情報,輸出${ctx.replyTo ? '一句針對上面那句話的回應' : '這一輪的發言'}。`;
  return { system, user };
}

// ── 投票提示(有 Gemini 才用;回傳要「保護」哪些獸首)────────────────────────
export interface VoteContext {
  displayName: string;
  role: RoleId;
  camp: Camp;
  personaVoice: string;
  roundIndex: number;
  roundAnimals: number[];   // 本輪可投的獸首 id
  myIntel: string;
  chips: number;            // 手上籌碼數
  chatHistory: string;
}

export function buildVotePrompts(ctx: VoteContext): { system: string; user: string } {
  const st = ROLE_STYLE[ctx.role];
  const aim =
    ctx.camp === 'GOOD'
      ? '你要把票投在「真品」上,讓真品被保護下來(好人會因保住真品而得分)。'
      : '你要把票投在「贗品」上,引導大家去保護假貨、放掉真品(這對壞人有利);必要時也可佯裝配合。';
  const system = `你正在玩《古董局中局》的投票階段。每位玩家用手上的籌碼票,投給「想保護」的獸首;每輪票數最高的前兩名會被保護。
你的祕密角色:${ctx.role}(${st.campLabel})。${aim}
請只回傳純 JSON:{"protect":[獸首中文名, ...],"thought":"理由"}。protect 內只能放本輪桌上的獸首名稱,可放 1~2 個;不要加 Markdown。`;
  const animals = ctx.roundAnimals.map((a) => ANIMALS[a]).join('、');
  const user = `# 第 ${ctx.roundIndex + 1} 輪投票
- 本輪桌上獸首:${animals}
- 你手上的籌碼:${ctx.chips}
- 你本輪的情報:${ctx.myIntel || '本輪你沒有明確情報,請依推理與聊天判斷。'}

# 近期聊天紀錄
${ctx.chatHistory || '(沒有發言紀錄)'}

請決定要把票集中保護哪 1~2 個獸首,回傳 protect 名單。`;
  return { system, user };
}
