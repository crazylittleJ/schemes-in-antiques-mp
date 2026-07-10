import React, { useEffect, useRef, useState } from 'react';
import { Client, Room } from 'colyseus.js';

const ANIMALS = ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬'];
const ROLE_DESC: Record<string, string> = {
  許願: '好人首領,一回合可鑑定兩個寶物。',
  方震: '無鑑寶能力,但每回合可查看一位玩家的陣營。',
  黃煙煙: '隨機某一輪無法鑑定。',
  木戶加奈: '隨機某一輪無法鑑定。',
  姬云浮: '鑑定不受老朝奉影響;但若被藥不然偷襲將永久無法鑑定。',
  老朝奉: '壞人首領。發動後,順位在你之後的好人(除姬云浮)鑑定真假互換;壞人與姬云浮不受影響。',
  藥不然: '發動後可偷襲一名玩家,使其下回合無法行動;偷襲到順序在你之前的玩家,效果延續到下一輪。偷襲方震會連帶許願。',
  鄭國渠: '不知隊友。發動後覆蓋一個寶物,之後鑑定該寶物者只看到無法鑑定。',
};

function endpoint() {
  const loc = window.location;
  if (loc.port === '5173') return 'ws://localhost:2567'; // 開發
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}`;
}

interface VoteRoundSnap {
  round: number; animals: number[]; tally: Record<string, number>;
  breakdown: { seat: string; alloc: Record<string, number> }[];
  top: number[]; reveals: Record<string, boolean>;
}
interface EndDetailSnap {
  identityRevealed: boolean; protectedReals: number[];
  laoGuessXu: string | null; xuActual: string | null; xuBonus: number;
  yaoGuessFang: string | null; fangActual: string | null; fangBonus: number;
  goodGuessLao: { seat: string; target: string }[]; laoActual: string | null; foundLao: number; threshold: number; laoBonus: number;
  roles: Record<string, string>;
}
interface Snap {
  phase: string; playerCount: number; roundIndex: number;
  seatOrder: string[]; names: Record<string, string>; connected: Record<string, boolean>;
  bots: Record<string, boolean>; avatars: Record<string, string>;
  chat: { seat: string; name: string; avatar: string; text: string; round: number; isBot: boolean; kind: string }[];
  hostSeat: string;
  roundAnimals: number[];
  currentPlayer: string; subStep: string; actedPlayers: string[]; lastPlayer: string;
  speechOrder: string[]; speechPointer: number;
  protectedList: { animalId: number; round: number; realRevealed: boolean }[];
  revealedReal: Record<string, boolean>; lastTally: Record<string, number>;
  turnOrders: string[][]; voteRounds: VoteRoundSnap[]; endDetail: EndDetailSnap | null;
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
    bots: mapToObj(s.bots), avatars: mapToObj(s.avatars),
    chat: Array.from(s.chat ?? []).map((m: any) => ({ seat: m.seat, name: m.name, avatar: m.avatar, text: m.text, round: m.round, isBot: m.isBot, kind: m.kind })),
    hostSeat: s.hostSeat ?? '',
    roundAnimals: Array.from(s.roundAnimals ?? []),
    currentPlayer: s.currentPlayer, subStep: s.subStep, actedPlayers: Array.from(s.actedPlayers ?? []), lastPlayer: s.lastPlayer,
    speechOrder: Array.from(s.speechOrder ?? []), speechPointer: s.speechPointer,
    protectedList: Array.from(s.protectedList ?? []).map((p: any) => ({ animalId: p.animalId, round: p.round, realRevealed: p.realRevealed })),
    revealedReal: mapToObj(s.revealedReal), lastTally: mapToObj(s.lastTally),
    turnOrders: Array.from(s.turnOrdersJson ?? []).map((x: any) => (x ? String(x).split(',') : [])),
    voteRounds: Array.from(s.voteRoundsJson ?? []).map((x: any) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean) as VoteRoundSnap[],
    endDetail: s.endDetailJson ? (() => { try { return JSON.parse(s.endDetailJson); } catch { return null; } })() : null,
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
  const [showChars, setShowChars] = useState(false);
  const [gankedTurn, setGankedTurn] = useState(false); // 本回合被藥不然偷襲
  const [jiDisabledTurn, setJiDisabledTurn] = useState(false); // 姬云浮失能:本回合無法鑑定
  const [viewedPlayers, setViewedPlayers] = useState<string[]>([]); // 方震已查看過的玩家
  const [myChips, setMyChips] = useState(0);            // 自己的剩餘籌碼(隱藏資訊,私下取得)
  const [endCountdown, setEndCountdown] = useState<number | null>(null); // 結束後關房倒數

  // 表單 / 大廳(記住上次輸入,重整後自動帶入)
  const [name, setName] = useState(() => sessionStorage.getItem('gudong_name') || '');
  const [password, setPassword] = useState(() => sessionStorage.getItem('gudong_pw') || '');
  const [playerCount, setPlayerCount] = useState(8);
  const [slot, setSlot] = useState(() => Number(sessionStorage.getItem('gudong_slot')) || 1);
  const [rooms, setRooms] = useState<any[]>([]);        // 各房間占用狀態

  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashError(msg: string) {
    setError(msg);
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setError(''), 4000);
  }

  function attach(room: Room) {
    roomRef.current = room;
    sessionStorage.setItem('gudong_active', '1');
    room.onStateChange((s: any) => { setSnap(snapshot(s)); });
    room.onMessage('seat', (m: any) => { setMySeat(m.seatId); setIsHost(m.isHost); });
    room.onMessage('mychips', (n: any) => setMyChips(Number(n) || 0));
    room.onMessage('error', (m: any) => flashError(m.message));
    room.onMessage('room_closed', (m: any) => {
      sessionStorage.removeItem('gudong_active');
      const msg = m?.reason === 'timeout' ? '房間閒置過久,已自動關閉。'
        : m?.reason === 'ended' ? '遊戲已結束,房間已關閉。'
        : '房主已關閉房間。';
      alert(msg);
      location.reload();
    });
    room.onMessage('effect', (e: any) => {
      const rd = e.round !== undefined ? `第${e.round + 1}輪 ` : '';
      if (e.kind === 'YOUR_ROLE') { setRole(e.role); setPrivLog((l) => [...l, `我的身份:${e.role}`]); }
      else if (e.kind === 'TEAMMATE') { const who = e.name || e.playerId; setTeammate(`${who}(${e.role})`); setPrivLog((l) => [...l, `${who} 是${e.role}(你的隊友)`]); }
      else if (e.kind === 'IDENTIFY_RESULT') setPrivLog((l) => [...l, `${rd}鑑定 ${ANIMALS[e.animalId]} → ${RESULT_TEXT[e.result]}`]);
      else if (e.kind === 'FACTION_RESULT') {
        const tn = roomRef.current?.state?.names?.get?.(e.targetId) || e.targetId;
        setViewedPlayers((v) => (v.includes(e.targetId) ? v : [...v, e.targetId]));
        setPrivLog((l) => [...l, `${rd}查看 ${tn} → ${e.camp === 'GOOD' ? '好人' : '壞人'}`]);
      }
      else if (e.kind === 'ABILITY_USED') {
        const txt = e.ability === '偷襲' ? `偷襲 ${roomRef.current?.state?.names?.get?.(e.targetId) || e.targetId}`
          : e.ability === '覆蓋' ? `覆蓋 ${ANIMALS[e.animalId]}`
          : '發動真假互換';
        setPrivLog((l) => [...l, `${rd}${txt}`]);
      }
      else if (e.kind === 'TURN_RECORD') setPrivLog((l) => [...l, `${rd}${e.text}`]);
      else if (e.kind === 'GANKED') setGankedTurn(true);
      else if (e.kind === 'JI_DISABLED') setJiDisabledTurn(true);
    });
    room.send('resync'); // 處理器已註冊,請伺服器可靠補送座位/身份/紀錄(避免競態丟訊息)
  }

  useEffect(() => {
    const client = new Client(endpoint());
    clientRef.current = client;
    const active = sessionStorage.getItem('gudong_active');
    const nm = sessionStorage.getItem('gudong_name');
    const pw = sessionStorage.getItem('gudong_pw');
    const sl = Number(sessionStorage.getItem('gudong_slot')) || 1;
    if (!(active && nm && pw)) { setConnecting(false); return; }
    let cancelled = false;
    (async () => {
      // 重整後馬上重進時,伺服器可能還沒偵測到舊連線關閉,會暫時回「暱稱已被使用」;
      // 這是同一個人在接管自己的座位,持續重試到舊連線被判定離線即可成功。
      for (let i = 0; i < 20 && !cancelled; i++) {
        try {
          const room = await client.joinOrCreate('gudong', { name: nm, password: pw, slot: sl, playerCount: 8 });
          if (!cancelled) { attach(room); setConnecting(false); }
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      if (!cancelled) { sessionStorage.removeItem('gudong_active'); setConnecting(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  // 我的回合結束就清掉「被偷襲 / 無法鑑定」提示
  useEffect(() => {
    const myTurnNow = snap && snap.phase === 'TURN' && snap.currentPlayer === mySeat;
    if (!myTurnNow) { if (gankedTurn) setGankedTurn(false); if (jiDisabledTurn) setJiDisabledTurn(false); }
  }, [snap?.phase, snap?.currentPlayer, mySeat, gankedTurn, jiDisabledTurn]);

  // 遊戲結束 → 顯示 60 秒關房倒數
  useEffect(() => {
    if (snap?.phase !== 'GAME_END') { setEndCountdown(null); return; }
    setEndCountdown(300);
    const t = setInterval(() => setEndCountdown((c) => (c === null ? null : Math.max(0, c - 1))), 1000);
    return () => clearInterval(t);
  }, [snap?.phase]);

  // 大廳:定期查詢房間 1/2/3 占用狀態
  async function refreshRooms() {
    try {
      const base = endpoint().replace(/^ws/, 'http');
      const r = await fetch(`${base}/rooms`);
      setRooms(await r.json());
    } catch { /* 忽略 */ }
  }
  useEffect(() => {
    if (connecting || roomRef.current) return;
    refreshRooms();
    const t = setInterval(refreshRooms, 4000);
    return () => clearInterval(t);
  }, [connecting]);

  async function join() {
    if (!name || /\s/.test(name)) { flashError('暱稱不可為空，且不能包含空白字元'); return; }
    if (!password || /\s/.test(password)) { flashError('密碼不可為空，且不能包含空白字元'); return; }
    sessionStorage.setItem('gudong_name', name);
    sessionStorage.setItem('gudong_pw', password);
    sessionStorage.setItem('gudong_slot', String(slot));
    try {
      setConnecting(true);
      const room = await clientRef.current!.joinOrCreate('gudong', { name, password, playerCount, slot });
      attach(room); setConnecting(false);
    } catch (e: any) { flashError(e?.message || '加入失敗'); setConnecting(false); }
  }
  const send = (payload: any) => roomRef.current?.send('action', payload);
  const sendChat = (text: string) => roomRef.current?.send('chat', { text });
  function moveSeat(i: number, dir: -1 | 1) {
    const order = [...(snap?.seatOrder ?? [])];
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    roomRef.current?.send('reorder', { order });
  }
  function leaveGame() {
    const msg = isHost ? '你是房主，離開將結束整局並關閉房間，確定?' : '確定離開遊戲?';
    if (!confirm(msg)) return;
    sessionStorage.removeItem('gudong_active');
    roomRef.current?.leave(true);
    location.reload();
  }

  if (connecting) return <Shell><p>連線中…</p></Shell>;
  if (!roomRef.current || !snap) {
    return (
      <Shell>
        <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: -2, backgroundImage: 'url(/bg.jpg)', backgroundSize: 'cover', backgroundPosition: 'center', opacity: 0.6 }} />
        <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: -1, background: 'rgba(255,255,255,0.4)' }} />
        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
        {showChars && <AICharactersModal onClose={() => setShowChars(false)} />}
        <h1>古董局中局</h1>
        <div style={{ background: '#fff3d6', border: '1px solid #e6c14d', color: '#7a5b00', borderRadius: 8, padding: '10px 12px', margin: '8px 0', fontSize: 14 }}>
          📌 重新整理、切到 LINE、鎖屏都沒關係——回來會用你的<b>暱稱+密碼自動接回原座位</b>(可能需等幾秒讓伺服器確認舊連線已離線;若沒馬上回到、停在「房間準備」畫面，<b>再重新整理一次</b>即可)。請盡量別<b>完全關閉分頁</b>。房主離開會結束整局。
        </div>
        <p style={{ color: '#888' }}>選一個房間，設定密碼與人數即成為房主；其餘人選同一房間、輸入相同密碼加入。</p>
        <Field label="暱稱"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="不可空白或含空格" /></Field>
        <Field label="房間密碼"><input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="不可空白或含空格" /></Field>

        <Field label="房間(最多 5 間)">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[1, 2, 3, 4, 5].map((n) => {
              const r = rooms.find((x) => x.slot === n);
              const occupied = !!r;
              const started = r?.started;
              const ended = r?.ended;
              const cnt = r?.clients ?? 0;
              const maxp = r?.maxPlayers ?? 8;
              const statusText = !occupied ? '空房' : ended ? '已結束,即將關閉' : started ? `進行中 (${cnt}人)` : `等待中 ${cnt}/${maxp}`;
              const statusColor = !occupied ? '#999' : ended ? '#a11' : started ? '#a11' : '#2a7';
              return (
                <button key={n} onClick={() => setSlot(n)} style={{
                  flex: '1 1 28%', minWidth: 92, padding: '8px 6px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                  border: slot === n ? '2px solid #2d6cdf' : '1px solid #ccc',
                  background: slot === n ? '#eaf1ff' : '#fafafa',
                }}>
                  <div style={{ fontWeight: 700 }}>房間 {n}</div>
                  <div style={{ color: statusColor, fontSize: 12 }}>{statusText}</div>
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="人數(房主設定)">
          <select value={playerCount} onChange={(e) => setPlayerCount(Number(e.target.value))}>
            <option value={6}>6 人</option><option value={7}>7 人</option><option value={8}>8 人</option>
          </select>
        </Field>
        <button style={btn} onClick={join}>進入房間 {slot}</button>
        <button style={textBtn} onClick={() => setShowHelp(true)}>遊戲說明</button>
        <button style={textBtn} onClick={() => setShowChars(true)}>AI 角色介紹</button>
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
          {isHost && s.phase === 'GAME_END'
            ? <button style={{ ...textBtn, color: '#bbb', cursor: 'not-allowed' }} disabled title="遊戲已結束,請用下方「關閉房間並回到大廳」">離開房間</button>
            : <button style={textBtn} onClick={leaveGame}>{isHost ? '離開房間' : '離開'}</button>}
        </span>
      </header>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {/* 玩家列(遊戲中顯示;大廳改由下方座位順序面板呈現) */}
      {s.phase !== 'LOBBY' && (
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
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
              <Avatar seat={p} s={s} size={26} />{p === s.hostSeat ? '👑' : ''}{isMe ? '⭐' : ''}{nameOf(p)}{isMe ? '(自己)' : ''}
            </span>
          );
        })}
      </div>
      )}

      {/* 我的私密資訊 */}
      {role && (
        <div style={box}>
          <b>我的身份：{role}</b> {teammate && <span style={{ color: '#a33' }}>· 隊友：{teammate}</span>}
          <div style={{ color: '#777', fontSize: 13 }}>{ROLE_DESC[role]}</div>
        </div>
      )}

      {/* 本輪獸首 */}
      {s.roundAnimals.length > 0 && (
        <div style={box}>
          本輪獸首：{s.roundAnimals.map((a) => (
            <span key={a} style={{ marginRight: 8 }}>
              {ANIMALS[a]}{a in s.revealedReal ? `(${s.revealedReal[a] ? '真' : '假'})` : ''}
            </span>
          ))}
        </div>
      )}

      {/* 遊戲紀錄(行動順序 + 每輪保護寶物得票,公開資訊用藍字) */}
      {(s.actedPlayers.length > 0 || s.turnOrders.length > 0) && (
        <div style={box}>
          <b>遊戲紀錄</b>
          {s.phase === 'TURN' && (
            <div style={{ marginTop: 4 }}>
              <div style={{ marginBottom: 2 }}>本輪行動順序:</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 2px' }}>
                {[...s.actedPlayers, ...(s.currentPlayer ? [s.currentPlayer] : [])].map((p, i, arr) => (
                  <span key={p} style={{ display: 'inline-flex', alignItems: 'center', maxWidth: '100%' }}>
                    <span style={{
                      padding: '1px 7px', borderRadius: 10, fontSize: 13, wordBreak: 'break-word',
                      background: p === s.currentPlayer ? '#2d6cdf' : '#eef0f3',
                      color: p === s.currentPlayer ? '#fff' : '#333',
                      fontWeight: p === s.currentPlayer ? 700 : 400,
                    }}>{nameOf(p)}{p === mySeat ? '(自己)' : ''}{p === s.currentPlayer ? ' ·進行中' : ''}</span>
                    {i < arr.length - 1 && <span style={{ color: '#bbb', margin: '0 2px' }}>→</span>}
                  </span>
                ))}
                {s.actedPlayers.length === 0 && <span style={{ color: '#999' }}>尚未開始</span>}
              </div>
            </div>
          )}
          {s.turnOrders.map((ord, i) => {
            const vr = s.voteRounds[i];
            return (
              <div key={i} style={{ marginTop: 6, borderTop: '1px solid #eee', paddingTop: 6 }}>
                <div style={{ fontSize: 13, color: '#555', overflowWrap: 'anywhere', wordBreak: 'break-word', lineHeight: 1.7 }}>第 {i + 1} 輪 行動：{ord.map((p) => `${nameOf(p)}${p === mySeat ? '(自己)' : ''}`).join(' → ')}</div>
                {vr && [...vr.animals]
                  .sort((x: number, y: number) => (vr.tally[y] || 0) - (vr.tally[x] || 0) || vr.animals.indexOf(x) - vr.animals.indexOf(y))
                  .map((a: number) => {
                    const isTop = vr.top.includes(a);
                    const real = a in s.revealedReal ? (s.revealedReal[a] ? '(真)' : '(假)') : '';
                    const total = vr.tally[a] || 0;
                    const voters = vr.breakdown.filter((b: any) => (b.alloc[a] || 0) > 0).map((b: any) => `${nameOf(b.seat)} x${b.alloc[a]}`);
                    return (
                      <div key={a} style={{ color: isTop ? '#2563eb' : '#8a8a8a', fontSize: 13 }}>
                        {isTop ? '🛡 ' : '　'}{ANIMALS[a]}{real} {total}票 — {voters.join('、') || '無人投'}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}

      {/* === 各階段 === */}
      {s.phase === 'LOBBY' && (
        <div style={box}>
          {isHost ? (
            <>
              <b>排定座位順序(順時針)</b>
              <div style={{ color: '#777', fontSize: 13, margin: '4px 0 8px' }}>
                請依你們實際入座的順時針順序排好——這會決定遊戲的<b>行動順序與發言順序</b>。用右側 ↑ ↓ 調整。
              </div>
              {s.seatOrder.map((p, i) => (
                <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: i ? '1px solid #f0f0f0' : 'none' }}>
                  <span style={{ width: 22, color: '#999', textAlign: 'right' }}>{i + 1}.</span>
                  <Avatar seat={p} s={s} size={40} />
                  <span style={{ flex: 1, fontWeight: p === mySeat ? 700 : 400, opacity: s.connected[p] === false ? 0.45 : 1 }}>
                    {p === s.hostSeat ? '👑 ' : ''}{nameOf(p)}{p === mySeat ? '(自己)' : ''}{s.connected[p] === false ? '(離線)' : ''}
                  </span>
                  {s.bots[p]
                    ? <button style={mini} onClick={() => roomRef.current?.send('remove_bot', { seat: p })}>移除</button>
                    : <>
                        <button style={mini} disabled={i === 0} onClick={() => moveSeat(i, -1)}>↑</button>
                        <button style={mini} disabled={i === s.seatOrder.length - 1} onClick={() => moveSeat(i, 1)}>↓</button>
                      </>}
                </div>
              ))}
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>已入座 {s.seatOrder.length} 人(需 6–8 人,至少 1 位真人)。</span>
                <button style={mini} disabled={s.seatOrder.length >= s.playerCount} onClick={() => roomRef.current?.send('add_bot')}>+ 加入 AI 玩家</button>
                <button style={btn} onClick={() => roomRef.current?.send('start')}>開始遊戲</button>
              </div>
            </>
          ) : (
            <>
              <b>座位順序</b>
              <div style={{ color: '#777', fontSize: 13, margin: '4px 0 8px' }}>房主正在排定座位；行動與發言將依此順序進行：</div>
              {s.seatOrder.map((p, i) => (
                <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', opacity: s.connected[p] === false ? 0.45 : 1, fontWeight: p === mySeat ? 700 : 400 }}>
                  <span style={{ color: '#999' }}>{i + 1}.</span><Avatar seat={p} s={s} size={36} />
                  <span>{p === s.hostSeat ? '👑 ' : ''}{nameOf(p)}{p === mySeat ? '(自己)' : ''}</span>
                </div>
              ))}
              <div style={{ marginTop: 8, color: '#888' }}>已入座 {s.seatOrder.length} 人，等待房主開始…</div>
            </>
          )}
        </div>
      )}

      {s.phase === 'TURN' && (
        <div style={box}>
          {myTurn && gankedTurn && (
            <div style={{ background: '#fde2e2', border: '1px solid #f5a3a3', color: '#a11', borderRadius: 6, padding: '8px 10px', marginBottom: 8, fontWeight: 700 }}>
              🚫 {role === '姬云浮'
                ? '你被藥不然偷襲了,接下來的回合將無法鑑定。本回合直接派票即可。'
                : '你被藥不然偷襲了!本回合無法鑑定、無法發動能力,直接派票即可。'}
            </div>
          )}
          {myTurn && !gankedTurn && jiDisabledTurn && (
            <div style={{ background: '#fdeedd', border: '1px solid #f0c089', color: '#9a5b00', borderRadius: 6, padding: '8px 10px', marginBottom: 8, fontWeight: 700 }}>
              🚫 無法鑑定，本回合直接派票即可。
            </div>
          )}
          {myTurn ? <TurnUI s={s} role={role} mySeat={mySeat} notActed={notActed} others={others} nameOf={nameOf} send={send} viewedPlayers={viewedPlayers} />
            : <span style={{ color: '#888' }}>輪到 {nameOf(s.currentPlayer)} 行動…</span>}
        </div>
      )}

      {s.phase === 'SPEECH' && (
        <div style={box}>
          <div style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', lineHeight: 1.8 }}>發言順序：{s.speechOrder.map((p, i) => (
            <span key={p} style={{ marginRight: 6, fontWeight: i === s.speechPointer ? 700 : 400 }}>{nameOf(p)}</span>
          ))}</div>
          {s.speechOrder[s.speechPointer] === mySeat &&
            <div><button style={btn} onClick={() => send({ type: 'SPEECH_DONE' })}>發言完畢</button></div>}
        </div>
      )}

      {s.phase === 'VOTE' && <VoteUI s={s} chips={myChips} send={send} />}

      {s.phase === 'REVEAL' && (
        <div style={box}>
          <div>{s.logLine}</div>
          <div style={{ color: '#888', fontSize: 13, marginTop: 4 }}>本輪投票結果已記在上方「遊戲紀錄」。</div>
          <button style={btn} onClick={() => send({ type: 'CONTINUE' })}>繼續</button>
          <div style={{ color: '#888', fontSize: 12 }}>任一玩家按「繼續」即可進入下一階段。</div>
        </div>
      )}

      {s.phase === 'IDENTITY_REVEAL' && (
        <IdentityUI s={s} role={role} mySeat={mySeat} others={s.seatOrder.filter((p) => p !== mySeat)} nameOf={nameOf} send={send} />
      )}

      {s.phase === 'GAME_END' && (
        <div style={box}>
          <h3>{s.winner === 'GOOD' ? '許願陣營(好人)獲勝!' : '老朝奉陣營(壞人)獲勝!'}</h3>
          <p>好人方最終 {s.finalScore} 分(達 6 分好人勝)。</p>
          <EndDetailView s={s} nameOf={nameOf} />
          <p style={{ color: '#a11' }}>房間將在 {String(Math.floor((endCountdown ?? 300) / 60)).padStart(2, '0')}:{String((endCountdown ?? 300) % 60).padStart(2, '0')} 後自動關閉(回到大廳成為空房)。</p>
          {isHost ? (
            <>
              <button style={btn} onClick={() => { sessionStorage.removeItem('gudong_active'); roomRef.current?.leave(true); location.reload(); }}>關閉房間並回到大廳</button>
              <div style={{ color: '#888', fontSize: 12 }}>你是房主，離開會<b>立即關閉房間</b>並釋放房號(其他人會一起回到大廳)。</div>
            </>
          ) : (
            <>
              <button style={btn} onClick={() => { sessionStorage.removeItem('gudong_active'); location.reload(); }}>回到大廳</button>
              <div style={{ color: '#888', fontSize: 12 }}>房主離開或倒數結束後，房間就會關閉。</div>
            </>
          )}
        </div>
      )}

      {/* 公開訊息 + 私密歷史 */}
      <div style={{ color: '#999', fontSize: 13, marginTop: 8 }}>📢 {s.logLine}</div>
      {privLog.length > 0 && (
        <div style={{ fontSize: 13, marginTop: 4 }}>
          {latestBatch(privLog).map((l, i) => <div key={i}>📝 {l}</div>)}
        </div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', color: '#888' }}>我的紀錄</summary>
        {privLog.map((l, i) => <div key={i} style={{ fontSize: 13 }}>{l}</div>)}
      </details>

      {s.phase !== 'LOBBY' && <ChatPanel s={s} mySeat={mySeat} nameOf={nameOf} onSend={sendChat} />}
    </Shell>
  );
}

function TurnUI({ s, role, notActed, others, nameOf, send, viewedPlayers }: any) {
  const [picked, setPicked] = useState<number[]>([]);
  const [abilityTarget, setAbilityTarget] = useState<string | null>(null);
  const [coverAnimal, setCoverAnimal] = useState<number | null>(null);

  if (s.subStep === 'AWAIT_IDENTIFY') {
    if (role === '方震') {
      const targets = others.filter((p: string) => !viewedPlayers?.includes(p));
      return <div>查看一位玩家的陣營(已查看過的不再列出)：
        {targets.length === 0 ? <span style={{ color: '#999' }}>所有人都查看過了</span> : targets.map((p: string) => (
          <button key={p} style={mini} onClick={() => send({ type: 'VIEW_FACTION', targetId: p })}>{nameOf(p)}</button>
        ))}
      </div>;
    }
    const need = role === '許願' ? 2 : 1;
    const toggle = (a: number) => setPicked((arr) => arr.includes(a) ? arr.filter((x) => x !== a) : arr.length < need ? [...arr, a] : arr);
    return (
      <div>
        {role === '許願' ? '請選擇兩個獸首鑑定:' : '選擇一個獸首鑑定:'}
        {s.roundAnimals.map((a: number) => (
          <button key={a} style={picked.includes(a) ? miniOn : mini} onClick={() => toggle(a)}>{ANIMALS[a]}</button>
        ))}
        <button disabled={picked.length !== need} style={btn} onClick={() => send({ type: 'IDENTIFY', animalIds: picked })}>鑑定{role === '許願' ? `(${picked.length}/2)` : ''}</button>
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
        選擇偷襲對象(不含自己):
        {others.map((p: string) => (
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

function VoteUI({ s, chips, send }: any) {
  const [alloc, setAlloc] = useState<Record<number, number>>({});
  const used = Object.values(alloc).reduce((a: number, b: any) => a + b, 0);
  const lastRound = s.roundIndex >= 2; // 第 3 輪(0-indexed 2)為最後一輪
  const set = (a: number, d: number) => setAlloc((m) => {
    const v = Math.max(0, (m[a] || 0) + d);
    const others = used - (m[a] || 0);
    if (others + v > chips) return m;
    return { ...m, [a]: v };
  });
  return (
    <div style={box}>
      決定保護哪些獸首(可用 {chips} 票，已分配 {used}):
      {lastRound && (
        <div style={{ background: '#fdeedd', border: '1px solid #f0c089', color: '#9a5b00', borderRadius: 6, padding: '8px 10px', margin: '6px 0', fontSize: 13 }}>
          ⚠️ 此輪為<b>最後一輪</b>，沒用完的票數將直接作廢——但你仍可選擇不用完(可能作為策略)。
        </div>
      )}
      {s.roundAnimals.map((a: number) => (
        <div key={a} style={{ margin: '4px 0' }}>
          {ANIMALS[a]} <button style={mini} onClick={() => set(a, -1)}>−</button>
          <b style={{ margin: '0 6px' }}>{alloc[a] || 0}</b>
          <button style={mini} onClick={() => set(a, 1)}>＋</button>
        </div>
      ))}
      <button style={btn} onClick={() => send({ type: 'SUBMIT_VOTE', allocation: alloc })}>送出投票</button>
      <div style={{ color: '#888', fontSize: 12 }}>{lastRound ? '可不用完；沒用完的票不會留到下一輪。' : '未用的票會留到下一輪。'}</div>
    </div>
  );
}

function IdentityUI({ s, role, others, nameOf, send }: any) {
  const [done, setDone] = useState(false);
  const GOOD = ['許願', '方震', '黃煙煙', '木戶加奈', '姬云浮'];
  let prompt = '', type = '';
  if (role === '老朝奉') { prompt = '你認為誰是許願?'; type = 'GUESS_XU'; }
  else if (role === '藥不然') { prompt = '你認為誰是方震?'; type = 'GUESS_FANG'; }
  else if (GOOD.includes(role)) { prompt = '你認為誰是老朝奉?'; type = 'GUESS_LAO'; }
  // 鄭國渠(壞人方,非老朝奉/藥不然)本階段無需猜測,其投票不計入好人方

  if (type === '') {
    return <div style={box}><b>身份揭露</b><p style={{ color: '#888' }}>你本階段無需猜測，等待其他人揭露…</p></div>;
  }
  return (
    <div style={box}>
      <b>身份揭露：{prompt}</b>
      {done ? <p style={{ color: '#888' }}>已送出，等待其他人…</p> :
        <div>{others.map((p: string) => (
          <button key={p} style={mini} onClick={() => { send({ type, targetId: p }); setDone(true); }}>{nameOf(p)}</button>
        ))}</div>}
    </div>
  );
}

function VoteBreakdown({ vr, nameOf }: any) {
  if (!vr) return null;
  return (
    <div style={{ marginTop: 8, fontSize: 13 }}>
      <div style={{ color: '#555' }}><b>本輪投票(誰投了什麼)：</b></div>
      {vr.breakdown.map((b: any) => {
        const parts = vr.animals.filter((a: number) => (b.alloc[a] || 0) > 0).map((a: number) => `${ANIMALS[a]}×${b.alloc[a]}`);
        return <div key={b.seat} style={{ marginLeft: 8 }}>{nameOf(b.seat)}:{parts.length ? parts.join('、') : '未投'}</div>;
      })}
      <div style={{ color: '#777', marginTop: 4 }}>
        票數合計:{vr.animals.map((a: number) => `${ANIMALS[a]} ${vr.tally[a] || 0}`).join(' / ')}
      </div>
    </div>
  );
}

function EndDetailView({ s, nameOf }: any) {
  const d: EndDetailSnap | null = s.endDetail;
  if (!d) return null;
  const nm = (seat: string | null) => (seat ? `${nameOf(seat)}${d.roles[seat] ? `(${d.roles[seat]})` : ''}` : '—');
  return (
    <details style={{ margin: '8px 0' }}>
      <summary style={{ cursor: 'pointer', color: '#2d6cdf', fontWeight: 700 }}>展開計分詳情</summary>
      <div style={{ fontSize: 14, marginTop: 6, lineHeight: 1.7 }}>
        <p style={{ margin: '4px 0' }}><b>(1) 鑑寶分數：</b>保護到 {d.protectedReals.length} 個真品 = <b>{d.protectedReals.length} 分</b></p>
        <div style={{ color: '#666', marginLeft: 8 }}>
          {s.voteRounds.map((vr: any, i: number) => (
            <div key={i}>第 {i + 1} 輪:保護 {vr.top.map((a: number) => `${ANIMALS[a]}(${s.revealedReal[a] ? '真' : '假'})`).join('、')}</div>
          ))}
        </div>
        {d.identityRevealed ? (
          <>
            <p style={{ margin: '6px 0' }}><b>(2) 找出許願：</b>老朝奉指認 {nm(d.laoGuessXu)};許願實為 {nm(d.xuActual)} → {d.xuBonus ? '未被找到 +2' : '被找到 +0'}</p>
            <p style={{ margin: '6px 0' }}><b>(3) 找出方震：</b>藥不然指認 {nm(d.yaoGuessFang)};方震實為 {nm(d.fangActual)} → {d.fangBonus ? '未被找到 +1' : '被找到 +0'}</p>
            <p style={{ margin: '6px 0' }}><b>(4) 找出老朝奉：</b>老朝奉實為 {nm(d.laoActual)};{d.foundLao}/{d.threshold}(需過半)好人找到 → {d.laoBonus ? '+1' : '+0'}</p>
            <div style={{ color: '#666', marginLeft: 8 }}>
              {d.goodGuessLao.map((g) => <div key={g.seat}>{nameOf(g.seat)} 指認 {nm(g.target)}</div>)}
            </div>
          </>
        ) : <p style={{ color: '#666', margin: '6px 0' }}>(本局好人保護滿 6 個真品，直接獲勝，未進入身份揭露)</p>}
        <p style={{ marginTop: 8, color: '#444' }}><b>全部身份：</b>{Object.entries(d.roles).map(([seat, r]) => `${nameOf(seat)}=${r}`).join('、')}</p>
      </div>
    </details>
  );
}

const GOOD_ROLE_NAMES = ['許願', '方震', '黃煙煙', '木戶加奈', '姬云浮'];
function RoleName({ n }: { n: string }) {
  return <b style={{ color: GOOD_ROLE_NAMES.includes(n) ? '#0ea5e9' : '#ea580c' }}>{n}</b>;
}

// 首頁「AI 角色介紹」——12 位可能出場的 AI 玩家(隨機抽出、動物也會說人話)
const AI_CHARACTERS: { id: string; name: string; kind: string; desc: string }[] = [
  { id: 'leo',     name: 'Leo',     kind: '男性・20 多歲',   desc: '年輕有活力,講話直來直往、帶點網路用語。' },
  { id: 'bella',   name: 'Bella',   kind: '女性・30 多歲',   desc: '熱情健談,喜歡帶氣氛、舉例分析。' },
  { id: 'barnaby', name: 'Barnaby', kind: '老狗・年長',       desc: '忠厚穩重的老狗,慢條斯理,愛用「氣味」打比方。' },
  { id: 'aisha',   name: 'Aisha',   kind: '女性・青少年',     desc: '直率的少女,語速快、情緒外放、敢說。' },
  { id: 'kai',     name: 'Kai',     kind: '男性・40 多歲',   desc: '沉穩務實的大叔,講重點不囉嗦。' },
  { id: 'pip',     name: 'Pip',     kind: '企鵝・成年',       desc: '呆萌又認真的企鵝,偶爾用冰天雪地打比方。' },
  { id: 'lola',    name: 'Lola',    kind: '女性・60 多歲',   desc: '慈祥的阿嬤,溫和愛叮嚀,偶爾碎念兩句。' },
  { id: 'xiaojie', name: '小潔',    kind: '女性・約 13 歲',   desc: '超自然現象偵探事務所的助手,常抱著純黑黑貓、穿黑和服。平常略害羞,但一抓到線索就聰慧犀利、條理分明。' },
  { id: 'jasper',  name: 'Jasper',  kind: '貓・成年',         desc: '慵懶傲嬌、有點毒舌的貓,語帶不屑其實很精。' },
  { id: 'toby',    name: 'Toby',    kind: '男性・50 多歲',   desc: '老派紳士,用詞文雅講究,溫文但有威嚴。' },
  { id: 'zara',    name: 'Zara',    kind: '女性・20 多歲',   desc: '自信外向、俐落,該嗆的時候不留情面。' },
  { id: 'luna',    name: 'Luna',    kind: '小狗・幼犬',       desc: '興奮的小奶狗,天真熱情,偶爾忍不住「汪」一聲。' },
];

function AICharactersModal({ onClose }: { onClose: () => void }) {
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: '#fff', paddingBottom: 8 }}>
          <h2 style={{ margin: 0 }}>AI 角色介紹</h2>
          <button style={btn} onClick={onClose}>關閉</button>
        </div>
        <p style={{ color: '#666', fontSize: 14, marginTop: 4 }}>
          房主可在等待房內「加入 AI 玩家」。AI 會從下列 12 位中<b>隨機抽出、不重複</b>,顯示為「名字(AI)」;動物在這款遊戲裡也會說人話。每位個性不同,發言與投票會帶各自的口吻。
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginTop: 8 }}>
          {AI_CHARACTERS.map((c) => (
            <div key={c.id} style={{ border: '1px solid #e3e3df', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', background: '#fafafa' }}>
              <img src={`/avatars/${c.id}.png`} alt={c.name} style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }} />
              <div style={{ fontWeight: 700, marginTop: 6 }}>{c.name}<span style={{ color: '#2d6cdf', fontSize: 12 }}>(AI)</span></div>
              <div style={{ color: '#999', fontSize: 12 }}>{c.kind}</div>
              <div style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{c.desc}</div>
            </div>
          ))}
        </div>
      </div>
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
        <p><b>目標：</b>好人陣營要盡量保護寶物真品，並找出<RoleName n="老朝奉" />是誰；壞人陣營要阻止寶物真品被找到，並找出<RoleName n="許願" />、<RoleName n="方震" />分別是誰(<RoleName n="老朝奉" />找<RoleName n="許願" />、<RoleName n="藥不然" />找<RoleName n="方震" />)。十二獸首中有 6 真 6 假，分 3 輪鑑定。</p>
        <p><b>角色配置：</b>只有<RoleName n="老朝奉" />與<RoleName n="藥不然" />互相知道彼此；<RoleName n="鄭國渠" />雖是壞人但並不相認，好人之間也互不相認。人數：6 人移除<RoleName n="姬云浮" />與<RoleName n="鄭國渠" />；7 人移除<RoleName n="姬云浮" />；8 人全角色。</p>
        <p><b>每輪流程：</b>系統抽出 4 個獸首(必定 2 真 2 假)。輪到你時依序：① 選一個獸首鑑定(許願可鑑定兩個)；② 發動或不發動角色能力；③ 把行動權派給本輪尚未行動的人。全員行動完後，從尾家左手邊起順時針<b>發言</b>，接著同時<b>投票</b>決定保護哪些獸首(籌碼可任意分配，沒用完留到下一輪)，最後<b>開票</b>：最高票兩個獸首被保護，其中第二高票當場公開真偽，第一高票暫不公開。<b>開票結果如果是平票，是以出現順序靠前的獸首越高，例如：出現 雞、龍、鼠、豬全平票，第一高票到最低為 雞、龍、鼠、豬。</b> <b>開票結果出現後，任一玩家按「繼續」即可進入下一輪 / 身份揭露。</b></p>
        <p style={{ color: '#666', fontSize: 13 }}><b>介面標示：</b>玩家列中，👑 是房主、⭐(自己)加橘框是你自己、藍底是目前行動者。主動技能(例如：<RoleName n="藥不然" />/<RoleName n="鄭國渠" />)需先選對象再按「偷襲/覆蓋」(或其他能力)確認，或按「不發動」；沒有主動能力的角色只會看到「下一步」。</p>
        <p><b>角色能力</b>(<span style={{ color: '#0ea5e9' }}>水藍=好人</span>、<span style={{ color: '#ea580c' }}>橘=壞人</span>)：</p>
        <ul style={{ marginTop: 0 }}>
          <li><RoleName n="許願" />：好人首領，一回合可鑑定兩個寶物。</li>
          <li><RoleName n="方震" />：無鑑寶能力，但每回合可查看一位玩家的陣營(好/壞)。</li>
          <li><RoleName n="木戶加奈" /> / <RoleName n="黃煙煙" />：系統隨機指定某一輪鑑定失敗；該輪不論點哪個寶物都只顯示「無法鑑定」和被<RoleName n="鄭國渠" />覆蓋的寶物一樣，<b>無法分辨</b>是哪種原因，沒有可發動的能力。</li>
          <li><RoleName n="姬云浮" />：鑑定不受<RoleName n="老朝奉" />影響；但若被<RoleName n="藥不然" />偷襲，將永久無法鑑定。</li>
          <li><RoleName n="老朝奉" />：壞人首領，技能發動後，行動順序在他之後的玩家鑑定真假互換(本質不變)，<b>壞人陣營和好人陣營中的<RoleName n="姬云浮" />則不受影響。</b></li>
          <li><RoleName n="藥不然" />：發動後偷襲一名玩家，使其無法行動；偷襲<RoleName n="方震" />會連帶偷襲<RoleName n="許願" />。<b>被偷襲者會收到明顯提示</b>，若偷襲行動順序在藥不然前面的玩家，效果會延續至下一輪。</li>
          <li><RoleName n="鄭國渠" />：發動後覆蓋一個寶物，之後鑑定該寶物者只能看到「無法鑑定」。</li>
        </ul>
        <p><b>計分(好人方)：</b>每保護一個真品 +1；<RoleName n="許願" />沒被<RoleName n="老朝奉" />找到 +2；<RoleName n="方震" />沒被<RoleName n="藥不然" />找到 +1；過半(含半數)好人找到<RoleName n="老朝奉" /> +1。總分 ≥ 6 好人勝，否則壞人勝。</p>

        <h3>房間閒置時間限制</h3>
        <p>房間若 30 分鐘內沒有任何動作(加入、行動、開始)，會自動關閉，所有人退回大廳。這是為了不讓沒人玩的房間一直佔用伺服器。只要遊戲還在進行、有人操作就會持續重置這個計時。</p>
        <p>另外：免費伺服器閒置約 15 分鐘會休眠，因此<b>很久沒人用時，第一個連入的人需等約一分鐘</b>把伺服器喚醒；之後只要有人連著就不會休眠。</p>

        <h3>房主與關閉房間</h3>
        <p>第一個進房的人是<b>房主</b>，名字旁會顯示一個皇冠 👑，只有房主能按「開始遊戲」。</p>
        <p>開始前，房主可在等待畫面用 ↑ ↓ <b>排定座位順序</b>，請依大家實際入座的<b>順時針順序</b>排好——這會決定遊戲的<b>行動順序與發言順序</b>。其他玩家會即時看到這個順序。</p>
        <p>房主右上角的按鈕是<b>「離開房間」</b>：房主一旦主動離開，<b>整局立即結束、所有人退回大廳</b>(房主不會轉移給別人)。卡關或想重來時，由房主按它最快。一般玩家的按鈕則是「離開」，只會讓自己退出。</p>
        <p>注意：這只針對<b>主動按離開</b>。房主若只是網路抖動、重整或鎖屏，屬於暫離(見下)，不會結束遊戲——伺服器會保留房主席位等他回來。</p>

        <h3>房間 1 / 2 / 3</h3>
        <p>同時最多開 <b>3 個房間</b>。登入畫面會顯示房間 1、2、3 的狀態(空房 / 等待中 / 進行中)。選一個空房並設密碼即成為該房房主；要加入別人的房，選同一個房號、輸入相同密碼即可。房主斷線想重開時，也可以改用另一個空房號。</p>

        <h3>暫離與重連</h3>
        <p><b>短暫斷線 / 重整 / 鎖屏 / 切到別的 App：</b>回到頁面(或重新整理)時，系統會用你的<b>暱稱 + 密碼自動接回原座位</b>，並補回身份與紀錄——中途滑去看 LINE、網路抖一下、不小心重整都沒關係，房主也一樣。只要房間還在(沒被房主關閉、也還沒閒置自動關)，你的座位就保留著。</p>
        <p><b>重整小提醒：</b>重整後可能要等幾秒，讓伺服器確認你舊的連線已離線，才接得回來；若你<b>停在「房間準備、等待房主開始」</b>的畫面、沒看到自己的座位，<b>再重新整理一次</b>就會回到原位。</p>
        <p><b>注意：</b>登入資訊存在這個分頁裡，<b>完全關掉分頁</b>就會清掉，無法再自動回座(但只要房間還在，重新打開、輸入相同暱稱+密碼也能接管原座位)。手機鎖屏、切到別的 App 通常分頁還在，不受影響。</p>
        <p><b>主動「離開」：</b>一般玩家在大廳離開會直接釋放座位，讓別人能補進；遊戲<b>進行中</b>離開則會保留座位、標記為離線(避免破壞回合資料)。<b>房主</b>主動離開則會<b>立即結束整局、關閉房間</b>。遊戲結束畫面請房主改用下方的「關閉房間並回到大廳」來關房、釋放房號。</p>
      </div>
    </div>
  );
}

// v2:座位頭像(AI 有圖 + 右上角機器人標記;真人顯示名字首字圓形)
function Avatar({ seat, s, size }: { seat: string; s: Snap; size: number }) {
  const url = s.avatars[seat];
  const nm = s.names[seat] || seat;
  const isBot = !!s.bots[seat];
  const inner = url
    ? <img src={url} alt={nm} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
    : <span style={{ width: size, height: size, borderRadius: '50%', background: '#c9d4e6', color: '#33415e',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.5, fontWeight: 700 }}>
        {(nm.match(/[A-Za-z0-9\u4e00-\u9fff]/)?.[0] || '?').toUpperCase()}
      </span>;
  if (!isBot) return <span style={{ flex: '0 0 auto', display: 'inline-block', width: size, height: size }}>{inner}</span>;
  const badge = Math.max(12, Math.round(size * 0.42));
  return (
    <span style={{ position: 'relative', flex: '0 0 auto', display: 'inline-block', width: size, height: size }}>
      {inner}
      <span title="AI 玩家" style={{
        position: 'absolute', top: -badge * 0.25, right: -badge * 0.25,
        width: badge, height: badge, borderRadius: '50%', background: '#2d6cdf', color: '#fff',
        border: '1.5px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: badge * 0.62, lineHeight: 1,
      }}>🤖</span>
    </span>
  );
}

// v2:通訊軟體式聊天/發言面板。AI 與真人發言累積到結束;真人只能在「輪到自己發言」時輸入。
function ChatPanel({ s, mySeat, onSend }: { s: Snap; mySeat: string; nameOf: (id: string) => string; onSend: (t: string) => void }) {
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [s.chat.length]);
  const myTurn = s.phase === 'SPEECH' && s.speechOrder[s.speechPointer] === mySeat;
  const submit = () => { const t = text.trim(); if (!t) return; onSend(t); setText(''); };
  return (
    <div style={{ ...box, display: 'flex', flexDirection: 'column' }}>
      <b style={{ marginBottom: 6 }}>💬 對話</b>
      <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}>
        {s.chat.length === 0 && <div style={{ color: '#999', fontSize: 13 }}>進入發言階段後,玩家與 AI 的發言會出現在這裡。</div>}
        {s.chat.map((m, i) => {
          const mine = m.seat === mySeat;
          return (
            <div key={i} style={{ display: 'flex', flexDirection: mine ? 'row-reverse' : 'row', gap: 10, alignItems: 'flex-end' }}>
              <Avatar seat={m.seat} s={s} size={52} />
              <div style={{ maxWidth: '72%' }}>
                <div style={{ fontSize: 11, color: '#999', textAlign: mine ? 'right' : 'left', marginBottom: 2 }}>
                  {m.name} · 第{m.round + 1}輪{m.kind === 'speech' ? '・發言' : ''}
                </div>
                <div style={{
                  background: mine ? '#2d6cdf' : (m.isBot ? '#eef1f6' : '#fff'),
                  color: mine ? '#fff' : '#222',
                  border: mine ? 'none' : '1px solid #e3e3df',
                  borderRadius: 12, padding: '7px 11px', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>{m.text}</div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          disabled={!myTurn}
          placeholder={myTurn ? '輪到你發言,輸入一句話(最多 150 字)…' : '只有輪到你發言時才能輸入'}
          maxLength={150}
          style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc', fontSize: 14, background: myTurn ? '#fff' : '#f1f1f1' }}
        />
        <button style={{ ...btn, opacity: myTurn ? 1 : 0.5 }} disabled={!myTurn} onClick={submit}>送出</button>
      </div>
      {myTurn && <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>你的發言為一句話(上限 150 字);送出後即輪到下一位。不想發言可按上方「發言完畢」。{text.length > 0 && ` (${text.length}/150)`}</div>}
    </div>
  );
}

function latestBatch(log: string[]): string[] {
  if (log.length === 0) return [];
  const pref = (l: string) => l.match(/^第\d+輪/)?.[0] ?? null;
  const last = pref(log[log.length - 1]);
  if (!last) return [log[log.length - 1]];
  const out: string[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (pref(log[i]) === last) out.unshift(log[i]); else break;
  }
  return out;
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
