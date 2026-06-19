import React, { useEffect, useRef, useState } from 'react';
import { Client, Room } from 'colyseus.js';

const ANIMALS = ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬'];
const ROLE_DESC: Record<string, string> = {
  許願: '好人首領,一回合可鑑定兩個寶物。',
  方震: '無鑑寶能力,但每回合可查看一位玩家的陣營。',
  黃煙煙: '隨機某一輪無法鑑定。',
  木戶加奈: '隨機某一輪無法鑑定。',
  姬云浮: '鑑定不受老朝奉影響;但若被藥不然偷襲將永久無法鑑定。',
  老朝奉: '壞人首領。發動後,順位在你之後的好人鑑定真假互換。',
  藥不然: '發動後可偷襲一名玩家,使其下回合無法行動。偷襲方震會連帶許願。',
  鄭國渠: '不知隊友。發動後覆蓋一個寶物,之後鑑定該寶物者只看到無法鑑定。',
};

function endpoint() {
  const loc = window.location;
  if (loc.port === '5173') return 'ws://localhost:2567'; // 開發
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}`;
}

interface Snap {
  phase: string; playerCount: number; roundIndex: number;
  seatOrder: string[]; names: Record<string, string>; connected: Record<string, boolean>;
  hostSeat: string;
  chips: Record<string, number>; roundAnimals: number[];
  currentPlayer: string; subStep: string; actedPlayers: string[]; lastPlayer: string;
  speechOrder: string[]; speechPointer: number;
  protectedList: { animalId: number; round: number; realRevealed: boolean }[];
  revealedReal: Record<string, boolean>; lastTally: Record<string, number>;
  winner: string; finalScore: number; logLine: string;
}
function mapToObj(m: any): Record<string, any> {
  const o: Record<string, any> = {};
  m?.forEach?.((v: any, k: any) => (o[k] = v));
  return o;
}
function snapshot(s: any): Snap {
  return {
    phase: s.phase, playerCount: s.playerCount, roundIndex: s.roundIndex,
    seatOrder: Array.from(s.seatOrder ?? []), names: mapToObj(s.names), connected: mapToObj(s.connected),
    hostSeat: s.hostSeat ?? '',
    chips: mapToObj(s.chips), roundAnimals: Array.from(s.roundAnimals ?? []),
    currentPlayer: s.currentPlayer, subStep: s.subStep, actedPlayers: Array.from(s.actedPlayers ?? []), lastPlayer: s.lastPlayer,
    speechOrder: Array.from(s.speechOrder ?? []), speechPointer: s.speechPointer,
    protectedList: Array.from(s.protectedList ?? []).map((p: any) => ({ animalId: p.animalId, round: p.round, realRevealed: p.realRevealed })),
    revealedReal: mapToObj(s.revealedReal), lastTally: mapToObj(s.lastTally),
    winner: s.winner, finalScore: s.finalScore, logLine: s.logLine,
  };
}

const RESULT_TEXT: Record<string, string> = { REAL: '真品', FAKE: '贗品', UNIDENTIFIABLE: '無法鑑定' };

export default function App() {
  const clientRef = useRef<Client | null>(null);
  const roomRef = useRef<Room | null>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [mySeat, setMySeat] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [role, setRole] = useState('');
  const [teammate, setTeammate] = useState('');
  const [privLog, setPrivLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [cannotId, setCannotId] = useState(false); // 本輪被系統封鎖鑑定
  const [gankedTurn, setGankedTurn] = useState(false); // 本回合被藥不然偷襲

  // 表單
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [playerCount, setPlayerCount] = useState(8);

  function attach(room: Room) {
    roomRef.current = room;
    sessionStorage.setItem('gudong_reconnect', room.reconnectionToken);
    room.onStateChange((s: any) => {
      setSnap(snapshot(s));
      sessionStorage.setItem('gudong_reconnect', room.reconnectionToken);
    });
    room.onMessage('seat', (m: any) => { setMySeat(m.seatId); setIsHost(m.isHost); });
    room.onMessage('error', (m: any) => { setError(m.message); setTimeout(() => setError(''), 3000); });
    room.onMessage('room_closed', (m: any) => {
      sessionStorage.removeItem('gudong_reconnect');
      alert(m?.reason === 'timeout' ? '房間閒置過久,已自動關閉。' : '房主已關閉房間。');
      location.reload();
    });
    room.onMessage('effect', (e: any) => {
      if (e.kind === 'YOUR_ROLE') { setRole(e.role); setPrivLog((l) => [...l, `你的身份:${e.role}`]); }
      else if (e.kind === 'TEAMMATE') { const who = e.name || e.playerId; setTeammate(`${who}(${e.role})`); setPrivLog((l) => [...l, `${who} 是${e.role}(你的隊友)`]); }
      else if (e.kind === 'IDENTIFY_RESULT') setPrivLog((l) => [...l, `鑑定 ${ANIMALS[e.animalId]} → ${RESULT_TEXT[e.result]}`]);
      else if (e.kind === 'FACTION_RESULT') { const tn = roomRef.current?.state?.names?.get?.(e.targetId) || e.targetId; setPrivLog((l) => [...l, `${tn} 的陣營:${e.camp === 'GOOD' ? '好人' : '壞人'}`]); }
      else if (e.kind === 'GANKED') { setGankedTurn(true); setPrivLog((l) => [...l, '你被藥不然偷襲了!本回合無法行動。']); }
      else if (e.kind === 'BLOCKED_ROUND') { setCannotId(true); roomRef.current?.send('action', { type: 'SKIP_IDENTIFY' }); setPrivLog((l) => [...l, '本回合無法鑑寶(系統判定)。']); }
    });
    room.onLeave(() => { sessionStorage.removeItem('gudong_reconnect'); });
  }

  useEffect(() => {
    const client = new Client(endpoint());
    clientRef.current = client;
    const token = sessionStorage.getItem('gudong_reconnect');
    if (token) {
      client.reconnect(token).then((room) => { attach(room); setConnecting(false); })
        .catch(() => { sessionStorage.removeItem('gudong_reconnect'); setConnecting(false); });
    } else setConnecting(false);
  }, []);

  // 離開自己的鑑定步驟就清掉「無法鑑定」提示
  useEffect(() => {
    const mine = snap && snap.phase === 'TURN' && snap.currentPlayer === mySeat && snap.subStep === 'AWAIT_IDENTIFY';
    if (!mine && cannotId) setCannotId(false);
  }, [snap?.phase, snap?.currentPlayer, snap?.subStep, mySeat, cannotId]);

  // 不是我的回合就清掉「被偷襲」提示
  useEffect(() => {
    const myTurnNow = snap && snap.phase === 'TURN' && snap.currentPlayer === mySeat;
    if (!myTurnNow && gankedTurn) setGankedTurn(false);
  }, [snap?.phase, snap?.currentPlayer, mySeat, gankedTurn]);

  async function join() {
    try {
      setConnecting(true);
      const room = await clientRef.current!.joinOrCreate('gudong', { name: name || '玩家', password, playerCount });
      attach(room); setConnecting(false);
    } catch (e: any) { setError(e?.message || '加入失敗'); setConnecting(false); }
  }
  const send = (payload: any) => roomRef.current?.send('action', payload);
  function leaveGame() {
    const msg = isHost ? '你是房主,離開將結束整局並關閉房間,確定?' : '確定離開遊戲?';
    if (!confirm(msg)) return;
    sessionStorage.removeItem('gudong_reconnect');
    roomRef.current?.leave(true);
    location.reload();
  }

  if (connecting) return <Shell><p>連線中…</p></Shell>;
  if (!roomRef.current || !snap) {
    return (
      <Shell>
        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
        <h1>古董局中局</h1>
        <p style={{ color: '#888' }}>第一位進房者即房主,設定密碼與人數;其餘人輸入相同密碼加入。</p>
        <Field label="暱稱"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="房間密碼"><input value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="人數(房主設定)">
          <select value={playerCount} onChange={(e) => setPlayerCount(Number(e.target.value))}>
            <option value={6}>6 人</option><option value={7}>7 人</option><option value={8}>8 人</option>
          </select>
        </Field>
        <button style={btn} onClick={join}>進入房間</button>
        <button style={textBtn} onClick={() => setShowHelp(true)}>遊戲說明</button>
        {error && <p style={{ color: 'crimson' }}>{error}</p>}
      </Shell>
    );
  }

  const s = snap;
  const myTurn = s.currentPlayer === mySeat && s.phase === 'TURN';
  const nameOf = (seat: string) => s.names[seat] || seat;
  const others = s.seatOrder.filter((p) => p !== mySeat);
  const notActed = s.seatOrder.filter((p) => !s.actedPlayers.includes(p) && p !== mySeat);

  return (
    <Shell>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>古董局中局</h2>
        <span style={{ color: '#888' }}>
          {phaseLabel(s.phase)} · 第 {s.roundIndex + 1} 輪
          <button style={textBtn} onClick={() => setShowHelp(true)}>說明</button>
          <button style={textBtn} onClick={leaveGame}>{isHost ? '離開房間' : '離開'}</button>
        </span>
      </header>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {/* 玩家列 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
        {s.seatOrder.map((p) => {
          const isMe = p === mySeat, isCur = p === s.currentPlayer;
          return (
            <span key={p} style={{
              padding: '4px 8px', borderRadius: 6, fontSize: 13,
              background: isCur ? '#2d6cdf' : isMe ? '#fff3d6' : '#eee',
              color: isCur ? '#fff' : '#333',
              border: isMe ? '2px solid #f59e0b' : '2px solid transparent',
              fontWeight: isMe ? 700 : 400,
              opacity: s.connected[p] === false ? 0.4 : 1,
            }}>
              {p === s.hostSeat ? '👑' : ''}{isMe ? '⭐ ' : ''}{nameOf(p)}{isMe ? '(你)' : ''} · {s.chips[p] ?? 0}票
            </span>
          );
        })}
      </div>

      {/* 我的私密資訊 */}
      {role && (
        <div style={box}>
          <b>你的身份:{role}</b> {teammate && <span style={{ color: '#a33' }}>· 隊友:{teammate}</span>}
          <div style={{ color: '#777', fontSize: 13 }}>{ROLE_DESC[role]}</div>
        </div>
      )}

      {/* 本輪獸首 */}
      {s.roundAnimals.length > 0 && (
        <div style={box}>
          本輪獸首:{s.roundAnimals.map((a) => (
            <span key={a} style={{ marginRight: 8 }}>
              {ANIMALS[a]}{a in s.revealedReal ? `(${s.revealedReal[a] ? '真' : '假'})` : ''}
            </span>
          ))}
        </div>
      )}

      {/* === 各階段 === */}
      {s.phase === 'LOBBY' && (
        <div style={box}>
          已入座 {s.seatOrder.length} 人。{isHost
            ? <button style={btn} onClick={() => roomRef.current?.send('start')}>開始遊戲</button>
            : <span style={{ color: '#888' }}>等待房主開始…</span>}
        </div>
      )}

      {s.phase === 'TURN' && (
        <div style={box}>
          {myTurn && gankedTurn && (
            <div style={{ background: '#fde2e2', border: '1px solid #f5a3a3', color: '#a11', borderRadius: 6, padding: '8px 10px', marginBottom: 8, fontWeight: 700 }}>
              🚫 你被藥不然偷襲了!本回合無法鑑定、無法發動能力,直接派票即可。
            </div>
          )}
          {myTurn && cannotId && !gankedTurn && (
            <div style={{ background: '#fff3d6', border: '1px solid #e6c14d', color: '#7a5b00', borderRadius: 6, padding: '8px 10px', marginBottom: 8, fontWeight: 700 }}>
              ⛔ 本回合無法鑑寶(系統判定:木戶加奈/黃煙煙的封鎖輪,或姬云浮被偷襲後),直接選擇下一位派票即可。
            </div>
          )}
          {myTurn ? <TurnUI s={s} role={role} mySeat={mySeat} notActed={notActed} others={others} nameOf={nameOf} send={send} cannotId={cannotId} />
            : <span style={{ color: '#888' }}>輪到 {nameOf(s.currentPlayer)} 行動…</span>}
        </div>
      )}

      {s.phase === 'SPEECH' && (
        <div style={box}>
          發言順序:{s.speechOrder.map((p, i) => (
            <span key={p} style={{ marginRight: 6, fontWeight: i === s.speechPointer ? 700 : 400 }}>{nameOf(p)}</span>
          ))}
          {s.speechOrder[s.speechPointer] === mySeat &&
            <div><button style={btn} onClick={() => send({ type: 'SPEECH_DONE' })}>發言完畢</button></div>}
        </div>
      )}

      {s.phase === 'VOTE' && <VoteUI s={s} mySeat={mySeat} send={send} />}

      {s.phase === 'REVEAL' && (
        <div style={box}>
          <div>{s.logLine}</div>
          <div style={{ marginTop: 6, color: '#555' }}>
            目前已保護:{s.protectedList.map((pe) => `${ANIMALS[pe.animalId]}${pe.animalId in s.revealedReal ? (s.revealedReal[pe.animalId] ? '(真)' : '(假)') : ''}`).join('、')}
          </div>
          <button style={btn} onClick={() => send({ type: 'CONTINUE' })}>繼續</button>
          <div style={{ color: '#888', fontSize: 12 }}>任一玩家按「繼續」即可進入下一階段。</div>
        </div>
      )}

      {s.phase === 'IDENTITY_REVEAL' && (
        <IdentityUI s={s} role={role} mySeat={mySeat} others={s.seatOrder} nameOf={nameOf} send={send} />
      )}

      {s.phase === 'GAME_END' && (
        <div style={box}>
          <h3>{s.winner === 'GOOD' ? '許願陣營(好人)獲勝!' : '老朝奉陣營(壞人)獲勝!'}</h3>
          <p>好人方最終 {s.finalScore} 分。</p>
          <p>真偽公開:{Object.entries(s.revealedReal).map(([a, real]) => `${ANIMALS[Number(a)]}${real ? '真' : '假'}`).join('、')}</p>
          <button style={btn} onClick={() => { sessionStorage.removeItem('gudong_reconnect'); location.reload(); }}>回到大廳</button>
        </div>
      )}

      {/* 公開訊息 + 私密歷史 */}
      <div style={{ color: '#999', fontSize: 13, marginTop: 8 }}>📢 {s.logLine}</div>
      {privLog.length > 0 && <div style={{ fontSize: 13, marginTop: 4 }}>📝 {privLog[privLog.length - 1]}</div>}
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', color: '#888' }}>我的紀錄</summary>
        {privLog.map((l, i) => <div key={i} style={{ fontSize: 13 }}>{l}</div>)}
      </details>
    </Shell>
  );
}

function TurnUI({ s, role, notActed, others, nameOf, send, cannotId }: any) {
  const [picked, setPicked] = useState<number[]>([]);
  const [abilityTarget, setAbilityTarget] = useState<string | null>(null);
  const [coverAnimal, setCoverAnimal] = useState<number | null>(null);

  if (s.subStep === 'AWAIT_IDENTIFY') {
    if (cannotId) {
      return <div style={{ color: '#7a5b00' }}>本回合無法鑑寶,正在跳至派票…</div>;
    }
    if (role === '方震') {
      return <div>查看一位玩家的陣營:{others.map((p: string) => (
        <button key={p} style={mini} onClick={() => send({ type: 'VIEW_FACTION', targetId: p })}>{nameOf(p)}</button>
      ))}</div>;
    }
    const max = role === '許願' ? 2 : 1;
    const toggle = (a: number) => setPicked((arr) => arr.includes(a) ? arr.filter((x) => x !== a) : arr.length < max ? [...arr, a] : arr);
    return (
      <div>
        選擇要鑑定的獸首(最多 {max} 個):
        {s.roundAnimals.map((a: number) => (
          <button key={a} style={picked.includes(a) ? miniOn : mini} onClick={() => toggle(a)}>{ANIMALS[a]}</button>
        ))}
        <button disabled={picked.length === 0} style={btn} onClick={() => send({ type: 'IDENTIFY', animalIds: picked })}>鑑定</button>
      </div>
    );
  }

  if (s.subStep === 'AWAIT_ABILITY') {
    if (role === '老朝奉') {
      return <div>
        <button style={btn} onClick={() => send({ type: 'USE_ABILITY' })}>發動真假互換</button>
        <button style={mini} onClick={() => send({ type: 'SKIP_ABILITY' })}>不發動</button>
      </div>;
    }
    if (role === '藥不然') {
      return <div>
        選擇偷襲對象:
        {s.seatOrder.map((p: string) => (
          <button key={p} style={abilityTarget === p ? miniOn : mini} onClick={() => setAbilityTarget(p)}>{nameOf(p)}</button>
        ))}
        <div style={{ marginTop: 6 }}>
          <button disabled={!abilityTarget} style={btn} onClick={() => send({ type: 'USE_ABILITY', targetId: abilityTarget })}>偷襲</button>
          <button style={mini} onClick={() => send({ type: 'SKIP_ABILITY' })}>不發動</button>
        </div>
      </div>;
    }
    if (role === '鄭國渠') {
      return <div>
        選擇要覆蓋的獸首:
        {s.roundAnimals.map((a: number) => (
          <button key={a} style={coverAnimal === a ? miniOn : mini} onClick={() => setCoverAnimal(a)}>{ANIMALS[a]}</button>
        ))}
        <div style={{ marginTop: 6 }}>
          <button disabled={coverAnimal === null} style={btn} onClick={() => send({ type: 'USE_ABILITY', animalId: coverAnimal })}>覆蓋</button>
          <button style={mini} onClick={() => send({ type: 'SKIP_ABILITY' })}>不發動</button>
        </div>
      </div>;
    }
    // 無主動能力的角色:直接下一步
    return <div><button style={btn} onClick={() => send({ type: 'SKIP_ABILITY' })}>下一步</button></div>;
  }

  if (s.subStep === 'AWAIT_PASS') {
    return <div>派票給下一位:{notActed.map((p: string) => (
      <button key={p} style={mini} onClick={() => send({ type: 'PASS_TURN', targetId: p })}>{nameOf(p)}</button>
    ))}</div>;
  }
  return null;
}

function VoteUI({ s, mySeat, send }: any) {
  const chips = s.chips[mySeat] ?? 0;
  const [alloc, setAlloc] = useState<Record<number, number>>({});
  const used = Object.values(alloc).reduce((a: number, b: any) => a + b, 0);
  const set = (a: number, d: number) => setAlloc((m) => {
    const v = Math.max(0, (m[a] || 0) + d);
    const others = used - (m[a] || 0);
    if (others + v > chips) return m;
    return { ...m, [a]: v };
  });
  return (
    <div style={box}>
      決定保護哪些獸首(可用 {chips} 票,已分配 {used}):
      {s.roundAnimals.map((a: number) => (
        <div key={a} style={{ margin: '4px 0' }}>
          {ANIMALS[a]} <button style={mini} onClick={() => set(a, -1)}>−</button>
          <b style={{ margin: '0 6px' }}>{alloc[a] || 0}</b>
          <button style={mini} onClick={() => set(a, 1)}>＋</button>
        </div>
      ))}
      <button style={btn} onClick={() => send({ type: 'SUBMIT_VOTE', allocation: alloc })}>送出投票</button>
      <div style={{ color: '#888', fontSize: 12 }}>未用的票會留到下一輪。</div>
    </div>
  );
}

function IdentityUI({ s, role, others, nameOf, send }: any) {
  const [done, setDone] = useState(false);
  let prompt = '', type = '';
  if (role === '老朝奉') { prompt = '你認為誰是許願?'; type = 'GUESS_XU'; }
  else if (role === '藥不然') { prompt = '你認為誰是方震?'; type = 'GUESS_FANG'; }
  else { prompt = '你認為誰是老朝奉?'; type = 'GUESS_LAO'; }
  return (
    <div style={box}>
      <b>身份揭露:{prompt}</b>
      {done ? <p style={{ color: '#888' }}>已送出,等待其他人…</p> :
        <div>{others.map((p: string) => (
          <button key={p} style={mini} onClick={() => { send({ type, targetId: p }); setDone(true); }}>{nameOf(p)}</button>
        ))}</div>}
    </div>
  );
}

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: '#fff', paddingBottom: 8 }}>
          <h2 style={{ margin: 0 }}>遊戲說明</h2>
          <button style={btn} onClick={onClose}>關閉</button>
        </div>

        <h3>遊戲規則</h3>
        <p><b>目標:</b>好人方「許願陣營」要保護到 6 個真品(湊滿 6 分)獲勝;否則壞人方「老朝奉陣營」獲勝。十二獸首中有 6 真 6 假,分 3 輪鑑定。</p>
        <p><b>陣營:</b>只有老朝奉與藥不然互相認識隊友;鄭國渠雖是壞人但不知隊友,好人之間也互不相認。人數:6 人移除姬云浮與鄭國渠;7 人移除姬云浮;8 人全角色。</p>
        <p><b>每輪流程:</b>系統抽出 4 個獸首(必定 2 真 2 假)。輪到你時依序:① 選一個獸首鑑定(許願可鑑定兩個);② 發動或不發動角色能力;③ 把行動權派給本輪尚未行動的人。全員行動完後,從尾家左手邊起順時針<b>發言</b>,接著同時<b>投票</b>決定保護哪些獸首(籌碼可任意分配,沒用完留到下一輪),最後<b>開票</b>:最高票兩個獸首被保護,其中第二高票當場公開真偽,第一高票暫不公開。平票時生肖排序在前者視為較高。<b>開票結果出現後,任一玩家按「繼續」即可進入下一輪 / 身份揭露。</b></p>
        <p style={{ color: '#666', fontSize: 13 }}><b>介面標示:</b>玩家列中,👑 是房主、⭐(你)加橘框是你自己、藍底是目前行動者。主動技能(老朝奉/藥不然/鄭國渠)需先選對象再按「偷襲/覆蓋」確認,或按「不發動」;沒有主動能力的角色只會看到「下一步」。</p>
        <p><b>角色能力:</b></p>
        <ul style={{ marginTop: 0 }}>
          <li>許願(好人首領):一回合可鑑定兩個寶物。</li>
          <li>方震:無鑑寶能力,但每回合可查看一位玩家的陣營(好/壞)。</li>
          <li>木戶加奈 / 黃煙煙:被動角色,隨機某一輪會鑑定失敗——由系統決定是哪一輪,玩家無法選擇,也沒有可發動的能力。</li>
          <li>姬云浮:鑑定不受老朝奉影響;但若被藥不然偷襲,將永久無法鑑定。</li>
          <li>老朝奉(壞人首領):發動後,順位在他之後的好人鑑定真假互換(本質不變)。</li>
          <li>藥不然:發動後偷襲一名玩家,使其下回合無法行動;偷襲方震會連帶偷襲許願。</li>
          <li>鄭國渠:發動後覆蓋一個寶物,之後鑑定該寶物者只看到「無法鑑定」。</li>
        </ul>
        <p><b>計分(好人方):</b>每保護一個真品 +1;許願沒被老朝奉找到 +2;方震沒被藥不然找到 +1;過半(含半數)好人找到老朝奉 +1。總分 ≥ 6 好人勝,否則壞人勝。</p>

        <h3>房間閒置時間限制</h3>
        <p>房間若 30 分鐘內沒有任何動作(加入、行動、開始),會自動關閉,所有人退回大廳。這是為了不讓沒人玩的房間一直佔用伺服器。只要遊戲還在進行、有人操作就會持續重置這個計時。</p>
        <p>另外:免費伺服器閒置約 15 分鐘會休眠,因此<b>很久沒人用時,第一個連入的人需等約一分鐘</b>把伺服器喚醒;之後只要有人連著就不會休眠。</p>

        <h3>房主與關閉房間</h3>
        <p>第一個進房的人是<b>房主</b>,名字旁會顯示一個皇冠 👑,只有房主能按「開始遊戲」。</p>
        <p>房主右上角的按鈕是<b>「離開房間」</b>:房主一旦主動離開,<b>整局立即結束、所有人退回大廳</b>(房主不會轉移給別人)。卡關或想重來時,由房主按它最快。一般玩家的按鈕則是「離開」,只會讓自己退出。</p>
        <p>注意:這只針對<b>主動按離開</b>。房主若只是網路抖動、重整或鎖屏,屬於暫離(見下),不會結束遊戲——伺服器會保留房主席位等他回來。</p>

        <h3>暫離與重連</h3>
        <p><b>短暫斷線 / 重整 / 鎖屏:</b>伺服器會幫你保留座位 60 秒。在這段時間內回來(或重新整理頁面),會自動回到原座位,並補回你的身份與紀錄——所以中途網路抖一下、不小心重整都沒關係,房主也一樣。</p>
        <p><b>注意:</b>重連資訊存在這個分頁裡,<b>完全關掉分頁</b>就會清掉,無法再自動回座。手機鎖屏、切到別的 App 通常分頁還在,不受影響。</p>
        <p><b>主動「離開」:</b>一般玩家在大廳離開會直接釋放座位,讓別人能補進;遊戲<b>進行中</b>離開則會保留座位、標記為離線(避免破壞回合資料)。若剛好輪到離線的人,回合會卡住,這時請房主用「離開房間」結束重開,或由房主重開一局。</p>
      </div>
    </div>
  );
}

function phaseLabel(p: string) {
  return ({ LOBBY: '大廳', ROUND_START: '回合開始', TURN: '鑑定回合', SPEECH: '發言', VOTE: '投票', REVEAL: '開票', IDENTITY_REVEAL: '身份揭露', SCORING: '計分', GAME_END: '結束' } as any)[p] || p;
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div style={{ maxWidth: 640, margin: '0 auto', padding: 16, fontFamily: 'system-ui, sans-serif', color: '#222' }}>{children}</div>
);
const Field = ({ label, children }: any) => (
  <div style={{ margin: '8px 0' }}><label style={{ display: 'block', fontSize: 13, color: '#666' }}>{label}</label>{children}</div>
);
const box: React.CSSProperties = { background: '#f6f6f4', border: '1px solid #e3e3df', borderRadius: 8, padding: 12, margin: '8px 0' };
const btn: React.CSSProperties = { background: '#2d6cdf', color: '#fff', border: 0, borderRadius: 6, padding: '8px 14px', margin: 4, cursor: 'pointer' };
const mini: React.CSSProperties = { background: '#fff', border: '1px solid #ccc', borderRadius: 6, padding: '5px 9px', margin: 3, cursor: 'pointer' };
const miniOn: React.CSSProperties = { ...mini, background: '#2d6cdf', color: '#fff', border: '1px solid #2d6cdf' };
const textBtn: React.CSSProperties = { marginLeft: 10, background: 'none', border: 'none', color: '#2d6cdf', cursor: 'pointer', fontSize: 13, padding: 0 };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, overflowY: 'auto', zIndex: 100 };
const modal: React.CSSProperties = { background: '#fff', borderRadius: 10, padding: 20, maxWidth: 560, width: '100%', maxHeight: '90vh', overflowY: 'auto', lineHeight: 1.7, color: '#222' };
