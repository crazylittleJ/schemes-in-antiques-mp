// v2.0.0 — AI bot 大腦
// 設計:bot 只看「自己看得到的東西」(自己的角色 + 自己的私訊 + 公開盤面 + 聊天),絕不碰 engine.secret。
// 決策採「有序候選」:botCandidates 回一串候選動作,房間依序丟給 applyAction,第一個合法的就採用。
// 這樣不必在 bot 端重做引擎的合法性判斷,天然不會犯規。
import { Action, AnimalId, Camp, Effect, PlayerId, PublicState, RoleId, ANIMALS } from '../engine/types';
import { camp } from '../engine/engine';
import { ROLE_STYLE } from './personas';
import { buildSpeechPrompts, buildVotePrompts } from './prompt';
import { geminiSpeech, geminiJSON } from './gemini';

export interface BotView {
  seat: PlayerId;
  role: RoleId;
  camp: Camp;
  pub: PublicState;
  myLog: Effect[];                 // 這個座位的私訊歷史
  chips: number;
  nameOf: (id: PlayerId) => string;
  displayName: string;             // 例:Leo(AI)
  personaVoice: string;            // 此 AI 的說話語氣/性格
  teammateSeat: PlayerId | null;   // 老朝奉↔藥不然 互知的隊友座位(其他角色為 null)
  chat: { name: string; text: string; round: number }[];
}

// 本輪自己鑑定/查驗到的結果(從私訊推導)
function myResultsThisRound(v: BotView): { real: AnimalId[]; fake: AnimalId[]; factions: { id: PlayerId; camp: Camp }[] } {
  const r = v.pub.roundIndex;
  const real: AnimalId[] = [];
  const fake: AnimalId[] = [];
  const factions: { id: PlayerId; camp: Camp }[] = [];
  for (const e of v.myLog) {
    if (e.kind === 'IDENTIFY_RESULT' && e.round === r) {
      if (e.result === 'REAL') real.push(e.animalId);
      else if (e.result === 'FAKE') fake.push(e.animalId);
    }
    if (e.kind === 'FACTION_RESULT' && e.round === r) factions.push({ id: e.targetId, camp: e.camp });
  }
  return { real, fake, factions };
}

// ── 有序候選動作 ─────────────────────────────────────────────────────────
export function botCandidates(v: BotView): Action[] {
  const p = v.pub;
  const seat = v.seat;
  const out: Action[] = [];

  if (p.phase === 'TURN' && p.turn.currentPlayer === seat) {
    const ra = p.roundAnimals;
    const remaining = p.seatOrder.filter((x) => !p.turn.actedPlayers.includes(x) && x !== seat);
    if (p.turn.subStep === 'AWAIT_IDENTIFY') {
      if (v.role === '方震') {
        // 查驗一位還沒查過、且非自己的玩家(逐一當候選,引擎會擋已查過的)
        for (const t of p.seatOrder) if (t !== seat) out.push({ type: 'VIEW_FACTION', player: seat, targetId: t });
      } else if (v.role === '許願') {
        if (ra.length >= 2) out.push({ type: 'IDENTIFY', player: seat, animalIds: [ra[0], ra[1]] });
      } else {
        for (const a of ra) out.push({ type: 'IDENTIFY', player: seat, animalIds: [a] });
      }
      out.push({ type: 'SKIP_IDENTIFY', player: seat }); // 被封鎖/失能者退到這
    } else if (p.turn.subStep === 'AWAIT_ABILITY') {
      if (v.role === '老朝奉') {
        out.push({ type: 'USE_ABILITY', player: seat }); // 顛倒黑白
      } else if (v.role === '藥不然') {
        // 通常不偷襲已知隊友(老朝奉);優先襲擊還沒行動的非隊友
        const tgt = remaining.find((x) => x !== v.teammateSeat)
          ?? p.seatOrder.find((x) => x !== seat && x !== v.teammateSeat);
        if (tgt) out.push({ type: 'USE_ABILITY', player: seat, targetId: tgt });
      } else if (v.role === '鄭國渠') {
        if (ra.length) out.push({ type: 'USE_ABILITY', player: seat, animalId: ra[0] });
      }
      out.push({ type: 'SKIP_ABILITY', player: seat });
    } else if (p.turn.subStep === 'AWAIT_PASS') {
      for (const t of remaining) out.push({ type: 'PASS_TURN', player: seat, targetId: t });
    }
  } else if (p.phase === 'VOTE') {
    out.push({ type: 'SUBMIT_VOTE', player: seat, allocation: allocateVotes(v) });
  } else if (p.phase === 'REVEAL') {
    out.push({ type: 'CONTINUE', player: seat });
  } else if (p.phase === 'IDENTITY_REVEAL') {
    const other = p.seatOrder.find((x) => x !== seat && x !== v.teammateSeat)!;
    if (v.role === '老朝奉') out.push({ type: 'GUESS_XU', player: seat, targetId: guessTarget(v) ?? other });
    else if (v.role === '藥不然') out.push({ type: 'GUESS_FANG', player: seat, targetId: guessTarget(v) ?? other });
    else if (v.camp === 'GOOD') out.push({ type: 'GUESS_LAO', player: seat, targetId: guessTarget(v) ?? other });
  }
  return out;
}

// 投票:好人把籌碼押在「自己驗到的真品」;壞人押在「自己驗到的假品」以誤導;沒情報就押第一個獸首。
function allocateVotes(v: BotView): Record<AnimalId, number> {
  const { real, fake } = myResultsThisRound(v);
  const targets = (v.camp === 'GOOD' ? real : fake).filter((a) => v.pub.roundAnimals.includes(a));
  const pick = targets.length ? targets : v.pub.roundAnimals.slice(0, 1);
  const alloc: Record<AnimalId, number> = {};
  let left = v.chips;
  if (left <= 0 || pick.length === 0) return alloc;
  const per = Math.floor(left / pick.length);
  for (const a of pick) { alloc[a] = per; left -= per; }
  for (let i = 0; left > 0 && i < pick.length; i++) { alloc[pick[i]] += 1; left -= 1; }
  return alloc;
}

// 身份猜測(啟發式):排除已知隊友(老朝奉↔藥不然 互知,絕不互指);好人優先猜「沒驗成好人」的對象。
function guessTarget(v: BotView): PlayerId | null {
  const { factions } = myResultsThisRound(v);
  const knownGood = new Set(factions.filter((f) => f.camp === 'GOOD').map((f) => f.id));
  const cand = v.pub.seatOrder.filter((x) => x !== v.seat && x !== v.teammateSeat && !knownGood.has(x));
  return cand[0] ?? null;
}

// ── 本輪情報的自然語句(給發言用)─────────────────────────────────────────
export function intelSentence(v: BotView): string {
  const { real, fake, factions } = myResultsThisRound(v);
  const A = (a: AnimalId) => ANIMALS[a];
  const parts: string[] = [];
  if (real.length) parts.push(`你鑑定到「${real.map(A).join('、')}」為真`);
  if (fake.length) parts.push(`「${fake.map(A).join('、')}」為假`);
  for (const f of factions) parts.push(`你查到 ${v.nameOf(f.id)} 屬於${f.camp === 'GOOD' ? '好人' : '壞人'}陣營`);
  return parts.join(';') + (parts.length ? '。' : '');
}

// ── 發言:有金鑰用 Gemini,否則退回 persona 啟發式 ───────────────────────
function recentChat(v: BotView, n = 8): string {
  return v.chat.slice(-n).map((m) => `${m.name}:${m.text}`).join('\n');
}

export async function generateSpeech(v: BotView): Promise<{ text: string; thought?: string }> {
  const intel = intelSentence(v);
  const { system, user } = buildSpeechPrompts({
    displayName: v.displayName,
    role: v.role,
    camp: v.camp,
    personaVoice: v.personaVoice,
    roundIndex: v.pub.roundIndex,
    roundAnimals: v.pub.roundAnimals,
    myIntel: intel,
    chatHistory: recentChat(v),
  });
  const g = await geminiSpeech(system, user);
  if (g && g.result) return { text: g.result.replace(/\s+/g, ' ').trim().slice(0, 150), thought: g.thought };
  return { text: heuristicSpeech(v, intel) };
}

// 即時回嘴:針對某人剛說的話回應一句(有金鑰用 Gemini,否則用簡短啟發式)
export async function generateRebuttal(v: BotView, replyTo: { name: string; text: string }): Promise<string> {
  const { system, user } = buildSpeechPrompts({
    displayName: v.displayName, role: v.role, camp: v.camp, personaVoice: v.personaVoice,
    roundIndex: v.pub.roundIndex, roundAnimals: v.pub.roundAnimals,
    myIntel: intelSentence(v), chatHistory: recentChat(v), replyTo,
  });
  const g = await geminiSpeech(system, user);
  if (g && g.result) return g.result.replace(/\s+/g, ' ').trim().slice(0, 150);
  // 啟發式回嘴:用人設口吻接一句
  const quips = v.camp === 'GOOD'
    ? [`${replyTo.name},你這說法有依據嗎?說來聽聽。`, `我倒覺得未必,別急著下定論。`, `這話我不太認同,證據呢?`]
    : [`${replyTo.name},你少帶風向了,沒那麼簡單。`, `哼,說得這麼篤定,我看你才可疑。`, `別一張嘴就帶節奏,大家自己看。`];
  return quips[Math.floor((v.pub.roundIndex + v.seat.length + replyTo.text.length) % quips.length)];
}

// 投票決策:有金鑰用 Gemini 決定保護哪些獸首,否則用啟發式決策樹(allocateVotes)
export async function decideVote(v: BotView): Promise<Record<AnimalId, number>> {
  const { system, user } = buildVotePrompts({
    displayName: v.displayName, role: v.role, camp: v.camp, personaVoice: v.personaVoice,
    roundIndex: v.pub.roundIndex, roundAnimals: v.pub.roundAnimals,
    myIntel: intelSentence(v), chips: v.chips, chatHistory: recentChat(v),
  });
  const schema = {
    type: 'OBJECT',
    properties: { protect: { type: 'ARRAY', items: { type: 'STRING' } }, thought: { type: 'STRING' } },
    required: ['protect'],
  };
  const out = await geminiJSON(system, user, schema);
  if (out && Array.isArray(out.protect)) {
    // 把中文獸首名對回 id,且僅限本輪桌上的獸首,最多 2 個
    const wanted = out.protect
      .map((nm: string) => ANIMALS.findIndex((a) => a === String(nm).trim()))
      .filter((id: number) => id >= 0 && v.pub.roundAnimals.includes(id))
      .slice(0, 2) as AnimalId[];
    const picks = Array.from(new Set(wanted));
    if (picks.length) return spread(picks, v.chips);
  }
  return allocateVotes(v); // 退回啟發式決策樹
}

// 把籌碼平均分到 picks 上(總和 ≤ chips)
function spread(picks: AnimalId[], chips: number): Record<AnimalId, number> {
  const alloc: Record<AnimalId, number> = {};
  let left = chips;
  if (left <= 0 || picks.length === 0) return alloc;
  const per = Math.floor(left / picks.length);
  for (const a of picks) { alloc[a] = per; left -= per; }
  for (let i = 0; left > 0 && i < picks.length; i++) { alloc[picks[i]] += 1; left -= 1; }
  return alloc;
}

// 無金鑰時的 persona 啟發式發言:用角色語氣 + 本輪情報拼一句,不暴露身份。
function heuristicSpeech(v: BotView, intel: string): string {
  const st = ROLE_STYLE[v.role];
  const { real, fake } = myResultsThisRound(v);
  const A = (a: AnimalId) => ANIMALS[a];
  if (real.length || fake.length) {
    // 壞人「看情況」:部分回合說真話建立信任,部分回合才顛倒(以 round+seat 決定,避免每輪都反)
    const lie = v.camp === 'BAD' && ((v.pub.roundIndex + v.seat.length) % 2 === 0);
    const claimReal = lie ? fake : real;
    const claimFake = lie ? real : fake;
    const segs: string[] = [];
    if (claimReal.length) segs.push(`我看「${claimReal.map(A).join('、')}」這幾件對,該保下來`);
    if (claimFake.length) segs.push(`「${claimFake.map(A).join('、')}」氣息不對,別浪費籌碼`);
    return segs.join(',') + '。' + tail(v);
  }
  // 沒情報:用角色口吻帶風向
  return st.example;
}

function tail(v: BotView): string {
  const opts = v.camp === 'GOOD'
    ? ['大家把真的護住,別被帶走。', '有疑點的就說清楚。', '照證據走,別亂猜。']
    : ['你們再想想,別急著下結論。', '我覺得有人在帶風向。', '別一面倒,留點餘地。'];
  return opts[Math.floor((v.pub.roundIndex + v.seat.length) % opts.length)];
}
