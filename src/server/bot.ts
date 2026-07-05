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

// 投票:只押「自己有把握的獸首」——好人押驗到的真品、壞人押驗到的假品(誤導)。
// 不確定(本輪沒驗到相關結果)就「保留票數」到下一輪,不亂投。非最後一輪也會留一點餘裕。
function allocateVotes(v: BotView): Record<AnimalId, number> {
  const { real, fake } = myResultsThisRound(v);
  const targets = (v.camp === 'GOOD' ? real : fake).filter((a) => v.pub.roundAnimals.includes(a));
  if (targets.length === 0 || v.chips <= 0) return {}; // 沒把握 → 保留票數(棄權),留到下一輪
  const isLastRound = v.pub.roundIndex >= 2; // 最後一輪票不會留下 → 全押;其餘留餘裕
  const budget = isLastRound ? v.chips : Math.min(v.chips, targets.length * 2);
  return spread(targets, budget);
}

// 身份猜測(啟發式):排除已知隊友(老朝奉↔藥不然 互知,絕不互指);好人優先猜「沒驗成好人」的對象。
function guessTarget(v: BotView): PlayerId | null {
  const { factions } = myResultsThisRound(v);
  const knownGood = new Set(factions.filter((f) => f.camp === 'GOOD').map((f) => f.id));
  const cand = v.pub.seatOrder.filter((x) => x !== v.seat && x !== v.teammateSeat && !knownGood.has(x));
  return cand[0] ?? null;
}

// ── 本輪情報的自然語句 ─────────────────────────────────────────
// intelSentence:完整情報(給「投票推理」用,不會被別人看到)。
export function intelSentence(v: BotView): string {
  const { real, fake, factions } = myResultsThisRound(v);
  const A = (a: AnimalId) => ANIMALS[a];
  const parts: string[] = [];
  if (real.length) parts.push(`你鑑定到「${real.map(A).join('、')}」為真`);
  if (fake.length) parts.push(`「${fake.map(A).join('、')}」為假`);
  for (const f of factions) parts.push(`你查到 ${v.nameOf(f.id)} 屬於${f.camp === 'GOOD' ? '好人' : '壞人'}陣營`);
  return parts.join(';') + (parts.length ? '。' : '');
}

// speechIntel:給「發言」用的情報,會依角色做限制,避免暴露身分。
// - 許願:一回合會驗兩件,但發言只講「一件最有利的」,以免被看出是許願。
// - 方震:不會鑑寶、真本事是查陣營;發言絕不透露查陣營,只給模型一個「用鑑寶口吻暗示」的私下方向。
function speechIntel(v: BotView): string {
  const { real, fake, factions } = myResultsThisRound(v);
  const A = (a: AnimalId) => ANIMALS[a];
  if (v.role === '方震') {
    const bad = factions.filter((f) => f.camp === 'BAD').map((f) => v.nameOf(f.id));
    const good = factions.filter((f) => f.camp === 'GOOD').map((f) => v.nameOf(f.id));
    const hint: string[] = [];
    if (bad.length) hint.push(`你「私下」知道 ${bad.join('、')} 不可信,但只能用「他對某件的鑑定不對」這種鑑寶口吻暗中質疑,絕不可說出你能看穿身分`);
    if (good.length) hint.push(`你「私下」知道 ${good.join('、')} 可信,可以順著他`);
    if (!hint.length) return '本輪你沒有明確方向,就用鑑寶行話穩住場面、觀察大家。';
    return hint.join(';') + '。';
  }
  if (v.role === '許願') {
    if (real.length) return `你確定「${A(real[0])}」是真的,主張把牠保下來(只講這一件,別把你驗到的全講出來)。`;
    if (fake.length) return `你確定「${A(fake[0])}」是假的,提醒大家別在牠身上浪費籌碼(只講這一件)。`;
    return '本輪你沒有明確情報。';
  }
  return intelSentence(v);
}

// ── 發言:有金鑰用 Gemini,否則退回 persona 啟發式 ───────────────────────
function recentChat(v: BotView, n = 8): string {
  return v.chat.slice(-n).map((m) => `${m.name}:${m.text}`).join('\n');
}

// replyTo:若這一輪輪到本 bot 前,有人(通常是真人)剛發言,可在「自己回合」順順接話回應(仍遵守發言順序)。
export async function generateSpeech(v: BotView, replyTo?: { name: string; text: string } | null): Promise<{ text: string; thought?: string }> {
  const intel = speechIntel(v);
  const { system, user } = buildSpeechPrompts({
    displayName: v.displayName,
    role: v.role,
    camp: v.camp,
    personaVoice: v.personaVoice,
    roundIndex: v.pub.roundIndex,
    roundAnimals: v.pub.roundAnimals,
    myIntel: intel,
    chatHistory: recentChat(v),
    replyTo: replyTo ?? null,
  });
  const g = await geminiSpeech(system, user);
  if (g && g.result) return { text: g.result.replace(/\s+/g, ' ').trim().slice(0, 150), thought: g.thought };
  return { text: heuristicSpeech(v, intel, replyTo) };
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
    if (picks.length) {
      const isLastRound = v.pub.roundIndex >= 2;
      const budget = isLastRound ? v.chips : Math.min(v.chips, picks.length * 2);
      return spread(picks, budget);
    }
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
function heuristicSpeech(v: BotView, intel: string, replyTo?: { name: string; text: string } | null): string {
  const { real, fake } = myResultsThisRound(v);
  const A = (a: AnimalId) => ANIMALS[a];
  const prefix = replyTo ? `${replyTo.name},` : '';
  // 方震/許願:啟發式也用角色口吻,但沒把握時改走 noInfoLine(優先點名、少數才模糊)
  if (v.role === '方震' || v.role === '許願') {
    const one = real[0] ?? fake[0];
    if (one !== undefined) {
      const isReal = real.includes(one);
      return `${prefix}我看「${A(one)}」這件${isReal ? '對,該保下來' : '氣息不對,別浪費籌碼'}。${tail(v)}`;
    }
    return noInfoLine(v, prefix);
  }
  if (real.length || fake.length) {
    // 壞人「誤導優先」:預設顛倒真假(中間輪偶爾說真話洗白);好人照實。
    const lie = v.camp === 'BAD' && v.pub.roundIndex !== 1;
    const claimReal = lie ? fake : real;
    const claimFake = lie ? real : fake;
    const segs: string[] = [];
    if (claimReal.length) segs.push(`我看「${claimReal.map(A).join('、')}」這幾件對,該保下來`);
    if (claimFake.length) segs.push(`「${claimFake.map(A).join('、')}」氣息不對,別浪費籌碼`);
    return prefix + segs.join(',') + '。' + tail(v);
  }
  // 沒情報:優先「猜一個獸首」點名帶風向,少數情況才講得模糊
  return noInfoLine(v, prefix);
}

// 沒把握時:約 85% 仍點一個獸首來講(用猜的、語氣保守),約 15% 才講得模糊不點名。
function noInfoLine(v: BotView, prefix: string): string {
  const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  const ra = v.pub.roundAnimals;
  if (ra.length === 0 || Math.random() < 0.15) {
    return prefix + pick(['我還看不太準,再觀察觀察。', '這輪我沒什麼把握,先聽大家的。', '目前我持保留態度,不好說。']);
  }
  const a = ANIMALS[pick(ra)];
  const opts = v.camp === 'GOOD'
    ? [`我猜「${a}」這件比較可疑,大家多留意。`, `「${a}」我看著有點不對,不太敢保。`, `要我說,「${a}」得盯緊一點。`]
    : [`「${a}」我覺得沒問題,可以保下來。`, `依我看「${a}」是對的,別漏了牠。`, `「${a}」這件我傾向留著。`];
  return prefix + pick(opts);
}

function tail(v: BotView): string {
  const opts = v.camp === 'GOOD'
    ? ['大家把真的護住,別被帶走。', '有疑點的就說清楚。', '照證據走,別亂猜。']
    : ['你們再想想,別急著下結論。', '我覺得有人在帶風向。', '別一面倒,留點餘地。'];
  return opts[Math.floor((v.pub.roundIndex + v.seat.length) % opts.length)];
}
