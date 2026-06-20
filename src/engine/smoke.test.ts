import { setupGame, applyAction, resolveAppraisal, camp, playerOfRole, turnStatusFor } from './engine';
import { Action, GameState, PlayerId } from './types';

// 種子亂數,確保可重現
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', msg); }
}

function apply(s: GameState, a: Action): GameState {
  const r = applyAction(s, a);
  if (!r.ok) throw new Error(`action ${a.type} rejected: ${r.error}`);
  return r.state;
}

// ── 1. 全局玩到 GAME_END ───────────────────────────────────────────────────
function playFullGame(seed: number) {
  const seats: PlayerId[] = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  let { state } = setupGame(seats, mulberry32(seed));
  assert(state.public.phase === 'TURN', `seed ${seed}: 開局應在 TURN`);

  for (let round = 0; round < 3; round++) {
    // 回合:逐位行動直到進入 SPEECH
    let guard = 0;
    while (state.public.phase === 'TURN') {
      if (guard++ > 50) throw new Error('回合迴圈未收斂');
      const cur = state.public.turn.currentPlayer!;
      const role = state.secret.roles[cur];
      const sub = state.public.turn.subStep;

      if (sub === 'AWAIT_IDENTIFY') {
        const blocked = (role === '木戶加奈' || role === '黃煙煙') && state.secret.blockedRound[cur] === round;
        const jiDead = role === '姬云浮' && state.secret.jiPermanentlyDisabled;
        if (blocked || jiDead) {
          state = apply(state, { type: 'SKIP_IDENTIFY', player: cur });
        } else if (role === '方震') {
          const target = seats.find((p) => p !== cur && !state.secret.fangViewed.includes(p))!;
          state = apply(state, { type: 'VIEW_FACTION', player: cur, targetId: target });
        } else {
          const ids = role === '許願'
            ? state.public.roundAnimals.slice(0, 2)
            : [state.public.roundAnimals[0]];
          state = apply(state, { type: 'IDENTIFY', player: cur, animalIds: ids });
        }
      } else if (sub === 'AWAIT_ABILITY') {
        // 第一輪測試一次能力發動
        if (round === 0 && role === '老朝奉') {
          state = apply(state, { type: 'USE_ABILITY', player: cur });
        } else if (round === 0 && role === '鄭國渠') {
          state = apply(state, { type: 'USE_ABILITY', player: cur, animalId: state.public.roundAnimals[1] });
        } else {
          state = apply(state, { type: 'SKIP_ABILITY', player: cur });
        }
      } else if (sub === 'AWAIT_PASS') {
        const remaining = seats.filter((p) => !state.public.turn.actedPlayers.includes(p) && p !== cur);
        if (remaining.length > 0) state = apply(state, { type: 'PASS_TURN', player: cur, targetId: remaining[0] });
        // 若 remaining 為空,引擎已自動收尾;迴圈會跳出
      }
    }

    assert(state.public.phase === 'SPEECH', `seed ${seed} r${round}: 應進入 SPEECH`);
    // 發言
    let sp = 0;
    while (state.public.phase === 'SPEECH') {
      const speaker = state.public.speech!.order[state.public.speech!.pointer];
      state = apply(state, { type: 'SPEECH_DONE', player: speaker });
      if (sp++ > 20) throw new Error('發言迴圈未收斂');
    }

    assert(state.public.phase === 'VOTE', `seed ${seed} r${round}: 應進入 VOTE`);
    // 投票:每人把可用籌碼丟給本輪第一個獸首
    const animals = state.public.roundAnimals;
    for (const p of seats) {
      const chips = state.public.chips[p];
      state = apply(state, { type: 'SUBMIT_VOTE', player: p, allocation: { [animals[0]]: Math.min(1, chips), [animals[1]]: Math.max(0, chips - 1) } });
    }

    assert(state.public.phase === 'REVEAL', `seed ${seed} r${round}: 投票後應停在 REVEAL`);
    state = apply(state, { type: 'CONTINUE', player: seats[0] }); // 看完開票結果後繼續
  }

  // 三輪後:GAME_END(直接勝)或 IDENTITY_REVEAL
  if (state.public.phase === 'IDENTITY_REVEAL') {
    const lao = playerOfRole(state, '老朝奉')!;
    const yao = playerOfRole(state, '藥不然')!;
    state = apply(state, { type: 'GUESS_XU', player: lao, targetId: seats[0] });
    state = apply(state, { type: 'GUESS_FANG', player: yao, targetId: seats[1] });
    for (const g of seats.filter((p) => camp(state.secret.roles[p]) === 'GOOD')) {
      state = apply(state, { type: 'GUESS_LAO', player: g, targetId: lao });
    }
  }

  assert(state.public.phase === 'GAME_END', `seed ${seed}: 最終應為 GAME_END`);
  assert(state.public.winner !== null, `seed ${seed}: winner 應已決定`);
  assert(state.public.finalScore !== null, `seed ${seed}: finalScore 應已填`);
  // 保護獸首總數應為 6(3 輪 × 2)
  assert(state.public.protected.length === 6, `seed ${seed}: 應保護 6 個獸首,實際 ${state.public.protected.length}`);
  // 不變式:6 真 6 假
  const reals = Object.values(state.secret.treasures).filter((t) => t.isReal).length;
  assert(reals === 6, `seed ${seed}: 應 6 真,實際 ${reals}`);
  // 每輪 2 真 2 假
  for (let r = 0; r < 3; r++) {
    const rr = state.secret.roundLayout[r].filter((a) => state.secret.treasures[a].isReal).length;
    assert(rr === 2, `seed ${seed} r${r}: 該輪應 2 真,實際 ${rr}`);
  }
  return state;
}

console.log('# 全局可玩性(多種子)');
for (const seed of [1, 2, 7, 42, 99, 123, 2024, 31337]) playFullGame(seed);

// ── 2. 老朝奉真假互換的精準語意 ─────────────────────────────────────────────
console.log('# 老朝奉互換');
{
  const seats = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
  let { state } = setupGame(seats, mulberry32(5));
  // 手動設定一個可控情境
  const a = state.public.roundAnimals[0];
  state.secret.treasures[a].isReal = true;
  state.secret.roundEffects.laoSwapActive = true;

  // 找一個 GOOD 非姬云浮、一個 BAD、(無姬云浮於 6 人局)
  const good = seats.find((p) => camp(state.secret.roles[p]) === 'GOOD')!;
  const bad = seats.find((p) => camp(state.secret.roles[p]) === 'BAD')!;
  assert(resolveAppraisal(state, good, a) === 'FAKE', '互換後好人看真品應顯示假');
  assert(resolveAppraisal(state, bad, a) === 'REAL', 'BAD 不受互換影響,真品仍顯示真');

  // 覆蓋優先於互換
  state.secret.roundEffects.coveredAnimal = a;
  assert(resolveAppraisal(state, good, a) === 'UNIDENTIFIABLE', '覆蓋優先 → 無法鑑定');
}

// ── 3. 姬云浮:免疫互換、被偷襲後永久失能 ─────────────────────────────────────
console.log('# 姬云浮');
{
  // 8 人局才有姬云浮
  const seats = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  let { state } = setupGame(seats, mulberry32(3));
  const ji = playerOfRole(state, '姬云浮')!;
  const a = state.public.roundAnimals[0];
  state.secret.treasures[a].isReal = true;
  state.secret.roundEffects.laoSwapActive = true;
  assert(resolveAppraisal(state, ji, a) === 'REAL', '姬云浮免疫互換,真品仍顯示真');
  state.secret.jiPermanentlyDisabled = true;
  assert(resolveAppraisal(state, ji, a) === 'UNIDENTIFIABLE', '永久失能後一律無法鑑定');
}

// ── 4. 藥不然偷襲方震 → 連帶許願 ───────────────────────────────────────────
console.log('# 藥不然連帶偷襲許願');
{
  const seats = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  let { state } = setupGame(seats, mulberry32(11));
  const yao = playerOfRole(state, '藥不然')!;
  const fang = playerOfRole(state, '方震')!;
  const xu = playerOfRole(state, '許願')!;
  // 把行動權交到藥不然手上(直接操控 state 模擬其回合)
  state.public.turn.currentPlayer = yao;
  state.public.turn.subStep = 'AWAIT_ABILITY';
  const r = applyAction(state, { type: 'USE_ABILITY', player: yao, targetId: fang });
  assert(r.ok, '藥不然偷襲方震應成功');
  assert(r.state.secret.pendingGank.includes(fang), '方震應在待偷襲名單');
  assert(r.state.secret.pendingGank.includes(xu), '許願應連帶進入待偷襲名單');
}

// ── 5. 木戶/黃的隨機輪無法鑑定 ─────────────────────────────────────────────
console.log('# 木戶/黃 封鎖輪');
{
  const seats = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  let { state } = setupGame(seats, mulberry32(8));
  const mu = playerOfRole(state, '木戶加奈')!;
  const br = state.secret.blockedRound[mu];
  state.public.roundIndex = br;
  const a = state.public.roundAnimals[0];
  assert(resolveAppraisal(state, mu, a) === 'UNIDENTIFIABLE', '封鎖輪應無法鑑定');
  state.public.roundIndex = (br + 1) % 3;
  // 換到非封鎖輪(用該輪的獸首)
  const a2 = state.secret.roundLayout[(br + 1) % 3][0];
  const expect = state.secret.treasures[a2].isReal ? 'REAL' : 'FAKE';
  assert(resolveAppraisal(state, mu, a2) === expect, '非封鎖輪可正常鑑定');
}

// ── 6. SKIP_IDENTIFY:只有被封鎖者能略過鑑定 ─────────────────────────────────
console.log('# SKIP_IDENTIFY 防呆');
{
  const seats = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  let { state } = setupGame(seats, mulberry32(8));
  const mu = playerOfRole(state, '木戶加奈')!;
  const br = state.secret.blockedRound[mu];
  // 封鎖輪、輪到木戶 → 可略過
  state.public.roundIndex = br;
  state.public.turn.currentPlayer = mu;
  state.public.turn.subStep = 'AWAIT_IDENTIFY';
  const ok = applyAction(state, { type: 'SKIP_IDENTIFY', player: mu });
  assert(ok.ok && ok.state.public.turn.subStep === 'AWAIT_PASS', '封鎖輪略過鑑定後直接到派票(木戶無主動能力)');
  // 非封鎖輪 → 不可略過
  state.public.roundIndex = (br + 1) % 3;
  state.public.turn.subStep = 'AWAIT_IDENTIFY';
  const bad = applyAction(state, { type: 'SKIP_IDENTIFY', player: mu });
  assert(!bad.ok, '非封鎖輪不能略過鑑定');
}

// ── 7. turnStatusFor:偷襲優先於封鎖 ───────────────────────────────────────
console.log('# 偷襲優先於封鎖');
{
  const seats = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  let { state } = setupGame(seats, mulberry32(8));
  const mu = playerOfRole(state, '木戶加奈')!;
  const br = state.secret.blockedRound[mu];
  // 純封鎖:輪到木戶、封鎖輪、未被偷襲 → BLOCKED
  state.public.roundIndex = br;
  state.public.turn.currentPlayer = mu;
  state.public.turn.subStep = 'AWAIT_IDENTIFY';
  state.secret.turnGanked = false;
  assert(turnStatusFor(state, mu) === 'BLOCKED', '封鎖輪未被偷襲 → BLOCKED');
  // 同時被偷襲:onTurnBegin 走偷襲分支(AWAIT_PASS + turnGanked)→ GANKED 優先於封鎖
  let s2 = setupGame(seats, mulberry32(8)).state;
  s2.public.roundIndex = br;            // 木戶的封鎖輪
  s2.secret.pendingGank = [mu];         // 同時被偷襲
  const starter = seats.find((p) => p !== mu)!;
  s2.public.turn.currentPlayer = starter;
  s2.public.turn.startPlayer = starter;
  s2.public.turn.subStep = 'AWAIT_PASS';
  s2.public.turn.actedPlayers = [];     // 還有其他人未行動,回合不會立刻結束
  const r = applyAction(s2, { type: 'PASS_TURN', player: starter, targetId: mu });
  s2 = r.state;
  assert(r.ok, '派票給木戶應成功');
  assert(turnStatusFor(s2, mu) === 'GANKED', '同時被偷襲與封鎖 → 優先 GANKED');
  assert(s2.public.turn.subStep === 'AWAIT_PASS', '被偷襲者直接進入派票步驟');
}

// ── 7. 防豬隊友 & 姬云浮失能後每輪被偷襲 ──────────────────────────────────
console.log('# 防豬隊友規則');
{
  const seats = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  let { state } = setupGame(seats, mulberry32(3));
  const xu = playerOfRole(state, '許願')!;
  const fang = playerOfRole(state, '方震')!;
  const yao = playerOfRole(state, '藥不然')!;
  const a = state.public.roundAnimals;

  // 許願:必須剛好兩個
  state.public.turn.currentPlayer = xu; state.public.turn.startPlayer = xu; state.public.turn.subStep = 'AWAIT_IDENTIFY'; state.public.turn.actedPlayers = [];
  assert(!applyAction(state, { type: 'IDENTIFY', player: xu, animalIds: [a[0]] }).ok, '許願只鑑定一個應被拒');
  assert(!applyAction(state, { type: 'IDENTIFY', player: xu, animalIds: [a[0], a[0]] }).ok, '許願重複選同一個應被拒');
  assert(applyAction(state, { type: 'IDENTIFY', player: xu, animalIds: [a[0], a[1]] }).ok, '許願鑑定兩個應成功');

  // 方震:不可查看自己、不可重複查看
  state.public.turn.currentPlayer = fang; state.public.turn.startPlayer = fang; state.public.turn.subStep = 'AWAIT_IDENTIFY'; state.public.turn.actedPlayers = [];
  assert(!applyAction(state, { type: 'VIEW_FACTION', player: fang, targetId: fang }).ok, '方震不可查看自己');
  const tgt = seats.find((p) => p !== fang)!;
  const v1 = applyAction(state, { type: 'VIEW_FACTION', player: fang, targetId: tgt });
  assert(v1.ok, '方震首次查看應成功');
  state = v1.state;
  state.public.turn.subStep = 'AWAIT_IDENTIFY'; // 模擬下一回合,再次嘗試查看同一人
  assert(!applyAction(state, { type: 'VIEW_FACTION', player: fang, targetId: tgt }).ok, '方震不可重複查看同一人');

  // 藥不然:不可偷襲自己
  state.public.turn.currentPlayer = yao; state.public.turn.startPlayer = yao; state.public.turn.subStep = 'AWAIT_ABILITY'; state.public.turn.actedPlayers = [];
  assert(!applyAction(state, { type: 'USE_ABILITY', player: yao, targetId: yao }).ok, '藥不然不可偷襲自己');
}
{
  // 姬云浮永久失能後,每輪回合開始即視為被偷襲(直接派票)
  const seats = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  let { state } = setupGame(seats, mulberry32(7));
  const ji = playerOfRole(state, '姬云浮')!;
  state.secret.jiPermanentlyDisabled = true;
  const effects: any[] = [];
  state.public.turn.currentPlayer = ji; state.public.turn.actedPlayers = [];
  // 直接呼叫不到 onTurnBegin(內部),改用 PASS 流程觸發
  const other = seats.find((p) => p !== ji)!;
  state.public.turn.currentPlayer = other; state.public.turn.startPlayer = other; state.public.turn.subStep = 'AWAIT_PASS'; state.public.turn.actedPlayers = [];
  const r = applyAction(state, { type: 'PASS_TURN', player: other, targetId: ji });
  assert(r.ok && r.state.public.turn.subStep === 'AWAIT_PASS', '姬云浮失能後輪到她時直接進入派票');
  assert(r.effects.some((e: any) => e.to === ji && e.kind === 'GANKED'), '姬云浮失能後每輪收到被偷襲提示');
}

console.log(`\n結果:${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
