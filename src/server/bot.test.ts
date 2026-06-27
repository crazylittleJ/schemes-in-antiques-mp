// v2.0.0 — bot 煙霧測試:用啟發式候選動作驅動一局「全 bot」遊戲跑到 GAME_END。
// 不呼叫 Gemini(沒有金鑰),純驗證 bot 能合法走完整局(含發言/投票/開票/身份揭露)。
import { setupGame, applyAction, camp } from '../engine/engine';
import { Action, GameState, PlayerId, RoleId, Camp } from '../engine/types';
import { botCandidates, BotView, intelSentence } from './bot';

function mulberry32(a: number) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

let pass = 0, fail = 0;
function assert(c: boolean, m: string) { if (c) { pass++; } else { fail++; console.error('  ✗', m); } }

// 私訊歷史(模擬房間的 privateLog):從 effects 累積每座位的可見私訊
function run(seedSeats: number, seed: number) {
  const seats: PlayerId[] = [];
  for (let i = 0; i < seedSeats; i++) seats.push(`p${i}`);
  let { state, effects } = setupGame(seats, mulberry32(seed));
  const log: Record<PlayerId, any[]> = {};
  for (const s of seats) log[s] = [];
  const collect = (es: any[]) => { for (const e of es) if (e.to && e.kind !== 'GANKED' && e.kind !== 'JI_DISABLED' && e.kind !== 'BLOCKED_ROUND') log[e.to].push(e); };
  collect(effects);
  const chat: { name: string; text: string; round: number }[] = [];

  const view = (seat: PlayerId): BotView => {
    const role = state.secret.roles[seat] as RoleId;
    return {
      seat, role, camp: camp(role) as Camp, pub: state.public, myLog: log[seat],
      chips: state.public.chips[seat] ?? 0, nameOf: (id) => id, displayName: `${seat}(AI)`, chat,
    };
  };

  let guard = 0;
  while (state.public.phase !== 'GAME_END' && guard++ < 5000) {
    const p = state.public;
    let actor: PlayerId | null = null;
    if (p.phase === 'TURN') actor = p.turn.currentPlayer;
    else if (p.phase === 'SPEECH' && p.speech) actor = p.speech.order[p.speech.pointer];
    else if (p.phase === 'VOTE') actor = seats.find((s) => !(s in state.secret.pendingVotes)) ?? null;
    else if (p.phase === 'REVEAL') actor = seats[0];
    else if (p.phase === 'IDENTITY_REVEAL') {
      const g = state.secret.guesses;
      actor = seats.find((s) => {
        const r = state.secret.roles[s];
        if (r === '老朝奉') return g.laoGuessXu === null;
        if (r === '藥不然') return g.yaoGuessFang === null;
        return camp(r) === 'GOOD' && !(s in g.goodGuessLao);
      }) ?? null;
    }
    if (!actor) { assert(false, `第${guard}步無可行動者 (phase=${p.phase})`); break; }

    if (p.phase === 'SPEECH') {
      // 模擬發言:用啟發式產生情報句並推入聊天,再 SPEECH_DONE
      chat.push({ name: `${actor}(AI)`, text: intelSentence(view(actor)) || '……', round: p.roundIndex });
      const res = applyAction(state, { type: 'SPEECH_DONE', player: actor } as Action);
      assert(res.ok, `SPEECH_DONE 應合法 (${res.error})`);
      state = res.state; collect(res.effects); continue;
    }
    const cands = botCandidates(view(actor));
    let done = false;
    for (const a of cands) {
      const res = applyAction(state, a);
      if (res.ok) { state = res.state; collect(res.effects); done = true; break; }
    }
    assert(done, `phase=${p.phase} 應至少有一個合法候選動作 (actor=${actor})`);
    if (!done) break;
  }
  assert(state.public.phase === 'GAME_END', `seed${seed}/${seedSeats}人 應跑到 GAME_END`);
  assert(state.public.winner === 'GOOD' || state.public.winner === 'BAD', '應有勝負');
  return state;
}

console.log('# bot 全自動跑完整局');
for (const n of [6, 7, 8]) {
  for (let seed = 1; seed <= 8; seed++) run(n, seed);
}

console.log(`\n結果:${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
