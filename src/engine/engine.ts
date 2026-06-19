// 古董局中局 — engine core
// 對應 gudong-gamestate-spec.md v1。純函式;setup 需要 RNG,其餘 action 為決定性轉移。

import {
  Action, AnimalId, ApplyResult, AppraisalResult, Camp, Effect,
  GameState, PlayerId, RNG, RoleId,
} from './types';

const GOOD_ROLES: RoleId[] = ['許願', '方震', '黃煙煙', '木戶加奈', '姬云浮'];
const BAD_ROLES: RoleId[] = ['老朝奉', '藥不然', '鄭國渠'];

export function camp(role: RoleId): Camp {
  return GOOD_ROLES.includes(role) ? 'GOOD' : 'BAD';
}

function rolesForCount(n: number): RoleId[] {
  // 6:移除 姬云浮、鄭國渠 / 7:移除 姬云浮 / 8:全部
  if (n === 6) return ['許願', '方震', '黃煙煙', '木戶加奈', '老朝奉', '藥不然'];
  if (n === 7) return ['許願', '方震', '黃煙煙', '木戶加奈', '老朝奉', '藥不然', '鄭國渠'];
  return ['許願', '方震', '黃煙煙', '木戶加奈', '姬云浮', '老朝奉', '藥不然', '鄭國渠'];
}

function shuffle<T>(arr: T[], rng: RNG): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clone(s: GameState): GameState {
  return structuredClone(s);
}

function playerOfRole(s: GameState, role: RoleId): PlayerId | null {
  for (const [pid, r] of Object.entries(s.secret.roles)) if (r === role) return pid;
  return null;
}

function goodPlayers(s: GameState): PlayerId[] {
  return s.public.seatOrder.filter((p) => camp(s.secret.roles[p]) === 'GOOD');
}

// ── Setup ────────────────────────────────────────────────────────────────

export function setupGame(seatOrder: PlayerId[], rng: RNG = Math.random): { state: GameState; effects: Effect[] } {
  const n = seatOrder.length;
  if (n < 6 || n > 8) throw new Error('需要 6–8 名玩家');

  const roles = shuffle(rolesForCount(n), rng);
  const roleMap: Record<PlayerId, RoleId> = {};
  seatOrder.forEach((p, i) => (roleMap[p] = roles[i]));

  // 木戶加奈 / 黃煙煙 的隨機無法鑑定輪次
  const blockedRound: Record<PlayerId, number> = {};
  for (const p of seatOrder) {
    if (roleMap[p] === '木戶加奈' || roleMap[p] === '黃煙煙') {
      blockedRound[p] = Math.floor(rng() * 3);
    }
  }

  // 獸首配置:每輪 [真,真,假,假] 洗牌;12 獸首隨機分派到三組,組內生肖排序
  const allAnimals = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], rng);
  const roundLayout: AnimalId[][] = [];
  const treasures: Record<AnimalId, { round: number; isReal: boolean }> = {} as any;
  for (let r = 0; r < 3; r++) {
    const group = allAnimals.slice(r * 4, r * 4 + 4).sort((a, b) => a - b);
    roundLayout.push(group);
    const reals = shuffle([true, true, false, false], rng); // 對應排序後位置
    group.forEach((a, i) => (treasures[a] = { round: r, isReal: reals[i] }));
  }

  const startPlayer = seatOrder[Math.floor(rng() * n)];

  const chips: Record<PlayerId, number> = {};
  const connected: Record<PlayerId, boolean> = {};
  for (const p of seatOrder) { chips[p] = 0; connected[p] = true; }

  const state: GameState = {
    public: {
      phase: 'ROLE_DEAL',
      playerCount: n,
      seatOrder: seatOrder.slice(),
      connected,
      roundIndex: 0,
      roundAnimals: [],
      turn: { startPlayer, currentPlayer: null, subStep: null, actedPlayers: [], lastPlayer: null },
      speech: null,
      protected: [],
      revealedReal: {} as any,
      lastTally: null,
      chips,
      winner: null,
      finalScore: null,
      log: ['遊戲開始,已發放身份。'],
    },
    secret: {
      roles: roleMap,
      treasures,
      roundLayout,
      blockedRound,
      jiPermanentlyDisabled: false,
      pendingGank: [],
      roundEffects: { laoSwapActive: false, coveredAnimal: null },
      pendingVotes: {},
      guesses: { laoGuessXu: null, yaoGuessFang: null, goodGuessLao: {} },
      turnGanked: false,
    },
  };

  // effects:發身份;老朝奉 ↔ 藥不然 互看
  const effects: Effect[] = [];
  for (const p of seatOrder) effects.push({ to: p, kind: 'YOUR_ROLE', role: roleMap[p], camp: camp(roleMap[p]) });
  // 私下告知 木戶加奈 / 黃煙煙 自己的失能輪次(被動、本人可知)
  for (const p of seatOrder) {
    if (roleMap[p] === '木戶加奈' || roleMap[p] === '黃煙煙') {
      effects.push({ to: p, kind: 'BLOCKED_ROUND', round: blockedRound[p] });
    }
  }
  const lao = playerOfRole(state, '老朝奉');
  const yao = playerOfRole(state, '藥不然');
  if (lao && yao) {
    effects.push({ to: lao, kind: 'TEAMMATE', playerId: yao, role: '藥不然' });
    effects.push({ to: yao, kind: 'TEAMMATE', playerId: lao, role: '老朝奉' });
  }

  // ROLE_DEAL → ROUND_START(自動)
  enterRoundStart(state, effects);
  return { state, effects };
}

// ── 階段轉移(內部)──────────────────────────────────────────────────────

function enterRoundStart(s: GameState, effects: Effect[]) {
  for (const p of s.public.seatOrder) s.public.chips[p] += 2; // 拿兩個籌碼
  s.public.roundAnimals = s.secret.roundLayout[s.public.roundIndex].slice();
  s.secret.roundEffects = { laoSwapActive: false, coveredAnimal: null };
  const start = s.public.turn.startPlayer!;
  s.public.turn = { startPlayer: start, currentPlayer: start, subStep: null, actedPlayers: [], lastPlayer: null };
  s.public.phase = 'TURN';
  s.public.log.push(`第 ${s.public.roundIndex + 1} 輪開始,鑑定:${s.public.roundAnimals.map((a) => ANIMAL(a)).join('、')}。`);
  onTurnBegin(s, start, effects);
}

function ANIMAL(a: AnimalId) { return ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬'][a]; }

function onTurnBegin(s: GameState, p: PlayerId, effects: Effect[]) {
  const idx = s.secret.pendingGank.indexOf(p);
  if (idx >= 0) {
    s.secret.pendingGank.splice(idx, 1);
    if (s.secret.roles[p] === '姬云浮') s.secret.jiPermanentlyDisabled = true;
    s.secret.turnGanked = true;
    s.public.turn.subStep = 'AWAIT_PASS'; // 不可鑑定、不可發動能力,但仍須派票
    effects.push({ to: p, kind: 'GANKED' });
  } else {
    s.secret.turnGanked = false;
    s.public.turn.subStep = 'AWAIT_IDENTIFY';
    if (!canIdentifyThisTurn(s, p)) effects.push({ to: p, kind: 'BLOCKED_ROUND', round: s.public.roundIndex });
  }
}

// 尾家走到派票步驟時已無對象可派 → 自動收尾,進入發言
function maybeEndRoundTurn(s: GameState) {
  if (s.public.phase !== 'TURN' || s.public.turn.subStep !== 'AWAIT_PASS') return;
  const t = s.public.turn;
  const remaining = s.public.seatOrder.filter((p) => !t.actedPlayers.includes(p) && p !== t.currentPlayer);
  if (remaining.length === 0) {
    t.actedPlayers.push(t.currentPlayer!);
    t.lastPlayer = t.currentPlayer;
    t.subStep = null;
    enterSpeech(s);
  }
}

function canIdentifyThisTurn(s: GameState, p: PlayerId): boolean {
  const role = s.secret.roles[p];
  if ((role === '木戶加奈' || role === '黃煙煙') && s.public.roundIndex === s.secret.blockedRound[p]) return false;
  if (role === '姬云浮' && s.secret.jiPermanentlyDisabled) return false;
  return true;
}

export function resolveAppraisal(s: GameState, p: PlayerId, animalId: AnimalId): AppraisalResult {
  if (!canIdentifyThisTurn(s, p)) return 'UNIDENTIFIABLE';
  if (s.secret.roundEffects.coveredAnimal === animalId) return 'UNIDENTIFIABLE';
  let base: AppraisalResult = s.secret.treasures[animalId].isReal ? 'REAL' : 'FAKE';
  if (s.secret.roundEffects.laoSwapActive && camp(s.secret.roles[p]) === 'GOOD' && s.secret.roles[p] !== '姬云浮') {
    base = base === 'REAL' ? 'FAKE' : 'REAL';
  }
  return base;
}

function enterSpeech(s: GameState) {
  const last = s.public.turn.lastPlayer!;
  const i = s.public.seatOrder.indexOf(last);
  const n = s.public.seatOrder.length;
  const order: PlayerId[] = [];
  for (let k = 1; k <= n; k++) order.push(s.public.seatOrder[(i + k) % n]); // 尾家左手邊起,順時針
  s.public.speech = { order, pointer: 0 };
  s.public.phase = 'SPEECH';
  s.public.log.push('進入發言階段。');
}

function enterVote(s: GameState) {
  s.public.phase = 'VOTE';
  s.secret.pendingVotes = {};
  s.public.speech = null;
  s.public.log.push('進入投票階段。');
}

function doReveal(s: GameState) {
  const tally: Record<AnimalId, number> = {} as any;
  for (const a of s.public.roundAnimals) tally[a] = 0;
  for (const p of s.public.seatOrder) {
    const alloc = s.secret.pendingVotes[p] || {};
    let used = 0;
    for (const a of s.public.roundAnimals) { const v = alloc[a] || 0; tally[a] += v; used += v; }
    s.public.chips[p] -= used; // 未用的留到下一輪
  }
  // 票數降冪,平票時生肖索引升冪
  const ranked = s.public.roundAnimals.slice().sort((a, b) => (tally[b] - tally[a]) || (a - b));
  const top1 = ranked[0], top2 = ranked[1];
  s.public.protected.push({ animalId: top1, round: s.public.roundIndex, realRevealed: false });
  s.public.protected.push({ animalId: top2, round: s.public.roundIndex, realRevealed: true });
  s.public.revealedReal[top2] = s.secret.treasures[top2].isReal;
  s.public.lastTally = tally;
  s.secret.roundEffects = { laoSwapActive: false, coveredAnimal: null };
  s.public.turn.startPlayer = s.public.turn.lastPlayer; // 尾家成為下一輪起始
  s.secret.pendingVotes = {};
  s.public.phase = 'REVEAL';
  s.public.log.push(`保護 ${ANIMAL(top1)}、${ANIMAL(top2)};${ANIMAL(top2)} 為${s.public.revealedReal[top2] ? '真品' : '贗品'}。開票完成,按「繼續」進入下一階段。`);
}

// 由 CONTINUE 觸發:看完開票結果後推進到下一輪 / 身份揭露 / 結束
function advanceAfterReveal(s: GameState, effects: Effect[]) {
  if (s.public.roundIndex < 2) {
    s.public.roundIndex += 1;
    enterRoundStart(s, effects); // 下一輪起始玩家可能被偷襲,需傳遞 effects
  } else {
    const protectedRealCount = s.public.protected.filter((e) => s.secret.treasures[e.animalId].isReal).length;
    if (protectedRealCount >= 6) {
      finalize(s, 6, 'GOOD');
    } else {
      s.public.phase = 'IDENTITY_REVEAL';
      s.public.log.push('三輪結束,進入身份揭露階段。');
    }
  }
}

function maybeScore(s: GameState) {
  const lao = playerOfRole(s, '老朝奉');
  const yao = playerOfRole(s, '藥不然');
  if (lao && s.secret.guesses.laoGuessXu === null) return;
  if (yao && s.secret.guesses.yaoGuessFang === null) return;
  for (const g of goodPlayers(s)) if (!(g in s.secret.guesses.goodGuessLao)) return;

  let score = s.public.protected.filter((e) => s.secret.treasures[e.animalId].isReal).length;
  const xu = playerOfRole(s, '許願');
  const fang = playerOfRole(s, '方震');
  if (s.secret.guesses.laoGuessXu !== xu) score += 2;   // 許願未被找到
  if (s.secret.guesses.yaoGuessFang !== fang) score += 1; // 方震未被找到
  const goods = goodPlayers(s);
  const foundLao = goods.filter((g) => s.secret.guesses.goodGuessLao[g] === lao).length;
  const threshold = Math.ceil(goods.length / 2);
  if (foundLao >= threshold) score += 1;
  finalize(s, score, score >= 6 ? 'GOOD' : 'BAD');
}

function finalize(s: GameState, score: number, winner: Camp) {
  s.public.phase = 'GAME_END';
  s.public.finalScore = score;
  s.public.winner = winner;
  // 終局公開所有真偽
  for (const a of Object.keys(s.secret.treasures).map(Number)) s.public.revealedReal[a] = s.secret.treasures[a].isReal;
  s.public.log.push(`遊戲結束,好人方 ${score} 分 — ${winner === 'GOOD' ? '許願陣營' : '老朝奉陣營'}獲勝。`);
}

// ── 主 reducer ─────────────────────────────────────────────────────────────

const err = (state: GameState, message: string): ApplyResult => ({ state, effects: [], ok: false, error: message });

export function applyAction(prev: GameState, action: Action): ApplyResult {
  const s = clone(prev);
  const effects: Effect[] = [];
  const t = s.public.turn;
  const isCurrent = (p: PlayerId) => s.public.phase === 'TURN' && t.currentPlayer === p;

  switch (action.type) {
    case 'IDENTIFY': {
      if (!isCurrent(action.player) || t.subStep !== 'AWAIT_IDENTIFY') return err(prev, '現在不是你的鑑定步驟');
      if (s.secret.roles[action.player] === '方震') return err(prev, '方震沒有鑑寶能力,請改用查看陣營');
      const max = s.secret.roles[action.player] === '許願' ? 2 : 1;
      if (action.animalIds.length < 1 || action.animalIds.length > max) return err(prev, `本回合可鑑定 1–${max} 個獸首`);
      for (const a of action.animalIds) {
        if (!s.public.roundAnimals.includes(a)) return err(prev, '只能鑑定本輪的獸首');
      }
      for (const a of action.animalIds) {
        effects.push({ to: action.player, kind: 'IDENTIFY_RESULT', animalId: a, result: resolveAppraisal(s, action.player, a) });
      }
      t.subStep = 'AWAIT_ABILITY';
      return { state: s, effects, ok: true };
    }

    case 'SKIP_IDENTIFY': {
      if (!isCurrent(action.player) || t.subStep !== 'AWAIT_IDENTIFY') return err(prev, '現在不是你的鑑定步驟');
      // 只有真的被系統封鎖鑑定的玩家(木戶/黃的封鎖輪、姬云浮永久失能)才能略過
      if (canIdentifyThisTurn(s, action.player)) return err(prev, '你本輪可以鑑定,請選擇獸首');
      t.subStep = 'AWAIT_ABILITY';
      return { state: s, effects, ok: true };
    }

    case 'VIEW_FACTION': {
      if (!isCurrent(action.player) || t.subStep !== 'AWAIT_IDENTIFY') return err(prev, '現在不是你的步驟');
      if (s.secret.roles[action.player] !== '方震') return err(prev, '只有方震能查看陣營');
      if (!s.public.seatOrder.includes(action.targetId)) return err(prev, '目標無效');
      effects.push({ to: action.player, kind: 'FACTION_RESULT', targetId: action.targetId, camp: camp(s.secret.roles[action.targetId]) });
      t.subStep = 'AWAIT_ABILITY';
      return { state: s, effects, ok: true };
    }

    case 'USE_ABILITY': {
      if (!isCurrent(action.player) || t.subStep !== 'AWAIT_ABILITY') return err(prev, '現在不是發動能力的步驟');
      const role = s.secret.roles[action.player];
      if (role === '老朝奉') {
        s.secret.roundEffects.laoSwapActive = true;
        s.public.log.push('（有人發動了某種能力。）');
      } else if (role === '藥不然') {
        if (!action.targetId || !s.public.seatOrder.includes(action.targetId)) return err(prev, '偷襲目標無效');
        if (!s.secret.pendingGank.includes(action.targetId)) s.secret.pendingGank.push(action.targetId);
        if (s.secret.roles[action.targetId] === '方震') {
          const xu = playerOfRole(s, '許願');
          if (xu && !s.secret.pendingGank.includes(xu)) s.secret.pendingGank.push(xu); // 連帶偷襲許願
        }
      } else if (role === '鄭國渠') {
        if (action.animalId === undefined || !s.public.roundAnimals.includes(action.animalId)) return err(prev, '覆蓋目標需為本輪獸首');
        s.secret.roundEffects.coveredAnimal = action.animalId;
      } else {
        return err(prev, '你沒有可發動的能力');
      }
      t.subStep = 'AWAIT_PASS';
      maybeEndRoundTurn(s);
      return { state: s, effects, ok: true };
    }

    case 'SKIP_ABILITY': {
      if (!isCurrent(action.player) || t.subStep !== 'AWAIT_ABILITY') return err(prev, '現在不是發動能力的步驟');
      t.subStep = 'AWAIT_PASS';
      maybeEndRoundTurn(s);
      return { state: s, effects, ok: true };
    }

    case 'PASS_TURN': {
      if (!isCurrent(action.player) || t.subStep !== 'AWAIT_PASS') return err(prev, '現在不能派票');
      const remaining = s.public.seatOrder.filter((p) => !t.actedPlayers.includes(p) && p !== t.currentPlayer);
      if (remaining.length === 0) return err(prev, '已無可派對象,本回合應由你結束');
      if (!remaining.includes(action.targetId)) return err(prev, '只能派給本輪尚未行動的玩家');
      t.actedPlayers.push(t.currentPlayer!);
      t.currentPlayer = action.targetId;
      onTurnBegin(s, action.targetId, effects);
      maybeEndRoundTurn(s);
      return { state: s, effects, ok: true };
    }

    case 'SPEECH_DONE': {
      if (s.public.phase !== 'SPEECH' || !s.public.speech) return err(prev, '現在不是發言階段');
      const sp = s.public.speech;
      if (sp.order[sp.pointer] !== action.player) return err(prev, '還沒輪到你發言');
      sp.pointer += 1;
      if (sp.pointer >= sp.order.length) enterVote(s);
      return { state: s, effects, ok: true };
    }

    case 'SUBMIT_VOTE': {
      if (s.public.phase !== 'VOTE') return err(prev, '現在不是投票階段');
      if (!s.public.seatOrder.includes(action.player)) return err(prev, '玩家無效');
      let used = 0;
      for (const [k, v] of Object.entries(action.allocation)) {
        const a = Number(k);
        if (!s.public.roundAnimals.includes(a)) return err(prev, '只能投本輪獸首');
        if (!Number.isInteger(v) || v < 0) return err(prev, '票數須為非負整數');
        used += v;
      }
      if (used > s.public.chips[action.player]) return err(prev, '票數超過可用籌碼');
      s.secret.pendingVotes[action.player] = { ...action.allocation };
      // 全員送出 → 開票
      if (s.public.seatOrder.every((p) => p in s.secret.pendingVotes)) doReveal(s);
      return { state: s, effects, ok: true };
    }

    case 'CONTINUE': {
      if (s.public.phase !== 'REVEAL') return err(prev, '現在不能繼續');
      advanceAfterReveal(s, effects);
      return { state: s, effects, ok: true };
    }

    case 'GUESS_XU': {
      if (s.public.phase !== 'IDENTITY_REVEAL') return err(prev, '現在不是身份揭露階段');
      if (s.secret.roles[action.player] !== '老朝奉') return err(prev, '只有老朝奉能猜許願');
      s.secret.guesses.laoGuessXu = action.targetId;
      maybeScore(s);
      return { state: s, effects, ok: true };
    }

    case 'GUESS_FANG': {
      if (s.public.phase !== 'IDENTITY_REVEAL') return err(prev, '現在不是身份揭露階段');
      if (s.secret.roles[action.player] !== '藥不然') return err(prev, '只有藥不然能猜方震');
      s.secret.guesses.yaoGuessFang = action.targetId;
      maybeScore(s);
      return { state: s, effects, ok: true };
    }

    case 'GUESS_LAO': {
      if (s.public.phase !== 'IDENTITY_REVEAL') return err(prev, '現在不是身份揭露階段');
      if (camp(s.secret.roles[action.player]) !== 'GOOD') return err(prev, '只有好人需猜老朝奉');
      s.secret.guesses.goodGuessLao[action.player] = action.targetId;
      maybeScore(s);
      return { state: s, effects, ok: true };
    }

    default:
      return err(prev, '未知動作');
  }
}

// 給伺服器層用的小工具
export { playerOfRole, goodPlayers, GOOD_ROLES, BAD_ROLES };
