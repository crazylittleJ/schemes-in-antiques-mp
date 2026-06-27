// v2.0.0 — AI bot 大腦
// 設計:bot 只看「自己看得到的東西」(自己的角色 + 自己的私訊 + 公開盤面 + 聊天),絕不碰 engine.secret。
// 決策採「有序候選」:botCandidates 回一串候選動作,房間依序丟給 applyAction,第一個合法的就採用。
// 這樣不必在 bot 端重做引擎的合法性判斷,天然不會犯規。
import { Action, AnimalId, Camp, Effect, PlayerId, PublicState, RoleId, ANIMALS } from '../engine/types';
import { camp } from '../engine/engine';
import { ROLE_STYLE } from './personas';
import { buildSpeechPrompts } from './prompt';
import { geminiSpeech } from './gemini';

export interface BotView {
  seat: PlayerId;
  role: RoleId;
  camp: Camp;
  pub: PublicState;
  myLog: Effect[];                 // 這個座位的私訊歷史
  chips: number;
  nameOf: (id: PlayerId) => string;
  displayName: string;             // 例:Leo(AI)
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
        const tgt = remaining[0] ?? p.seatOrder.find((x) => x !== seat);
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
    const other = p.seatOrder.find((x) => x !== seat)!;
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

// 身份猜測(啟發式):好人猜一個「自己沒驗成好人」的對象;否則隨機非自己。
function guessTarget(v: BotView): PlayerId | null {
  const { factions } = myResultsThisRound(v);
  const knownGood = new Set(factions.filter((f) => f.camp === 'GOOD').map((f) => f.id));
  const cand = v.pub.seatOrder.filter((x) => x !== v.seat && !knownGood.has(x));
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
    roundIndex: v.pub.roundIndex,
    roundAnimals: v.pub.roundAnimals,
    myIntel: intel,
    chatHistory: recentChat(v),
  });
  const g = await geminiSpeech(system, user);
  if (g && g.result) return { text: g.result.slice(0, 80), thought: g.thought };
  return { text: heuristicSpeech(v, intel) };
}

// 無金鑰時的 persona 啟發式發言:用角色語氣 + 本輪情報拼一句,不暴露身份。
function heuristicSpeech(v: BotView, intel: string): string {
  const st = ROLE_STYLE[v.role];
  const { real, fake } = myResultsThisRound(v);
  const A = (a: AnimalId) => ANIMALS[a];
  if (real.length || fake.length) {
    const claimReal = v.camp === 'GOOD' ? real : fake; // 壞人對外把假的講成「該保的」
    const claimFake = v.camp === 'GOOD' ? fake : real;
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
