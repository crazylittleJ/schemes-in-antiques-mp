import { Room, Client } from 'colyseus';
import { GudongState, ProtectedEntrySchema } from './schema';
import { setupGame, applyAction, turnStatusFor } from '../engine/engine';
import { Action, Effect, GameState, PlayerId } from '../engine/types';

interface JoinOptions { name?: string; password?: string; playerCount?: number; slot?: number; }

// 一桌一局的房間。免費層、單一房間的用法下,狀態存記憶體即可。
export class GudongRoom extends Room<GudongState> {
  maxClients = 8;
  autoDispose = false; // 不因暫時無人而銷毀;由閒置(30分)/結束(5分)/房主關閉控制,確保斷線座位可被接管

  private password = '';
  private targetCount = 8;
  private slot = 1;
  private hostSeat: PlayerId | null = null;

  private engine: GameState | null = null;            // 權威狀態(含 secret),不外送
  private sessionToSeat = new Map<string, PlayerId>(); // client.sessionId -> seatId
  private privateLog: Record<PlayerId, Effect[]> = {}; // 每位玩家的私訊歷史(供重連補送)
  private started = false;
  private nextSeatNum = 0;                  // 單調遞增,避免移除座位後 id 重複
  private idleTimer?: ReturnType<typeof setTimeout>;
  private endTimer?: ReturnType<typeof setTimeout>;   // 遊戲結束 60 秒後自動關房
  private closing = false;                  // 正在關閉房間時跳過重連邏輯
  private readonly IDLE_MS = 30 * 60 * 1000; // 閒置 30 分鐘自動關閉房間

  onCreate(options: JoinOptions) {
    this.password = options.password ?? '';
    this.targetCount = options.playerCount ?? 8;
    this.slot = options.slot ?? 1;
    this.setState(new GudongState());
    this.state.phase = 'LOBBY';
    this.state.playerCount = this.targetCount;
    this.updateMetadata();
    this.touch();

    // 客戶端註冊好訊息處理器後會送 'resync',此時再可靠地補送座位/身份/私訊紀錄,
    // 避免 onJoin 當下送出的訊息因「處理器尚未註冊」而被丟掉(原本需重整兩次的主因)。
    this.onMessage('resync', (client) => {
      const seat = this.sessionToSeat.get(client.sessionId);
      if (!seat) return;
      client.send('seat', { seatId: seat, isHost: seat === this.hostSeat });
      for (const e of this.privateLog[seat] ?? []) client.send('effect', e);
      this.sendTurnStatus(client, seat);
      this.sync();
    });
    this.onMessage('action', (client, payload: Omit<Action, 'player'>) => {
      this.touch();
      this.handleAction(client, payload);
    });
    this.onMessage('start', (client) => {
      this.touch();
      const seat = this.sessionToSeat.get(client.sessionId);
      if (seat !== this.hostSeat) return this.sendError(client, '只有房主能開始遊戲');
      this.startGame(client);
    });
    // 房主在開始前排定座位(順時針)順序 → 影響行動與發言順序
    this.onMessage('reorder', (client, payload: { order?: string[] }) => {
      this.touch();
      const seat = this.sessionToSeat.get(client.sessionId);
      if (seat !== this.hostSeat) return this.sendError(client, '只有房主能排定座位順序');
      if (this.started) return this.sendError(client, '遊戲已開始,無法調整座位順序');
      const cur = [...this.state.seatOrder];
      const next = Array.isArray(payload?.order) ? payload!.order! : [];
      // 必須是現有座位的「排列」(同一組、不重不漏)
      if (next.length !== cur.length || [...next].sort().join(',') !== [...cur].sort().join(',')) {
        return this.sendError(client, '座位順序無效');
      }
      this.state.seatOrder.clear();
      for (const sId of next) this.state.seatOrder.push(sId);
      this.updateMetadata();
    });
    // 房主關閉房間:踢出所有人並銷毀房間
    this.onMessage('close', (client) => {
      const seat = this.sessionToSeat.get(client.sessionId);
      if (seat !== this.hostSeat) return this.sendError(client, '只有房主能關閉房間');
      this.closeRoom('host');
    });
  }

  // 密碼驗證(0.17 簽名:onAuth(client, options, context))
  onAuth(_client: Client, options: JoinOptions) {
    const name = options.name || '';
    const password = options.password || '';
    if (!name || /\s/.test(name)) throw new Error('暱稱不可為空,且不能包含空白字元');
    if (!password || /\s/.test(password)) throw new Error('密碼不可為空,且不能包含空白字元');
    if (password !== this.password) throw new Error('密碼錯誤');
    // 同名座位:仍連線中 → 拒絕;已斷線(灰色)→ 允許接管(重整/重連後備,即使遊戲已開始)
    const dup = [...this.state.names.entries()].find(([, nm]) => nm === name)?.[0];
    if (dup) {
      if (this.state.connected.get(dup) !== false) throw new Error('暱稱已被使用,請換一個');
      return true;
    }
    if (this.started) throw new Error('遊戲已開始,無法加入'); // 全新玩家不能中途加入
    return true;
  }

  onJoin(client: Client, options: JoinOptions) {
    this.touch();
    const name = options.name || '';
    // 接管同名的斷線座位(重整/重連後備)→ 還原原座位、身份與私訊紀錄
    const reclaim = [...this.state.names.entries()].find(([seat, nm]) => nm === name && this.state.connected.get(seat) === false)?.[0];
    if (reclaim) {
      this.sessionToSeat.set(client.sessionId, reclaim);
      this.state.connected.set(reclaim, true);
      if (this.engine) this.engine.public.connected[reclaim] = true;
      // 座位/身份/私訊與「被偷襲」提示都改由客戶端的 'resync' 觸發補送(避免競態丟訊息、避免重複)
      this.sync();
      this.updateMetadata();
      return;
    }
    const seat = `seat${this.nextSeatNum++}`;
    this.sessionToSeat.set(client.sessionId, seat);
    this.privateLog[seat] = [];
    this.state.seatOrder.push(seat);
    this.state.names.set(seat, options.name || seat);
    this.state.connected.set(seat, true);
    if (this.hostSeat === null) { this.hostSeat = seat; this.state.hostSeat = seat; }
    client.send('seat', { seatId: seat, isHost: seat === this.hostSeat });
    this.updateMetadata();
  }

  private startGame(host: Client) {
    if (this.started) return;
    const seats = [...this.state.seatOrder];
    if (seats.length < 6 || seats.length > 8) return this.sendError(host, '需要 6–8 名玩家');
    this.targetCount = seats.length;
    this.started = true;
    this.state.playerCount = seats.length;

    const { state, effects } = setupGame(seats);
    this.engine = state;
    this.updateMetadata();
    this.routeEffects(effects);
    this.sync();
  }

  private handleAction(client: Client, payload: Omit<Action, 'player'>) {
    const seat = this.sessionToSeat.get(client.sessionId);
    if (!seat || !this.engine) return this.sendError(client, '尚未入座或遊戲未開始');
    // 由伺服器注入經過驗證的 player,忽略 client 自稱的身份(防偽冒)
    const action = { ...payload, player: seat } as Action;
    const res = applyAction(this.engine, action);
    if (!res.ok) return this.sendError(client, res.error || '動作無效');
    this.engine = res.state;
    this.routeEffects(res.effects);
    this.sync();
  }

  // 把引擎的私訊副作用發給對應的 client,並記錄供重連補送
  private routeEffects(effects: Effect[]) {
    for (const e of effects) {
      // 隊友資訊補上對方的玩家名稱(讓藥不然/老朝奉知道是「哪一位」)
      const payload: Effect = e.kind === 'TEAMMATE'
        ? { ...e, name: this.state.names.get(e.playerId) ?? e.playerId }
        : e;
      // 偷襲/失能/封鎖為當回合短暫提示,不入重連歷史(改由 sendTurnStatus 依當前狀態補送);
      // TURN_RECORD 等其餘私訊則持久化,重連時補送。
      const transient = payload.kind === 'BLOCKED_ROUND' || payload.kind === 'GANKED' || payload.kind === 'JI_DISABLED';
      if (!transient) this.privateLog[payload.to]?.push(payload);
      const sid = this.seatToSession(payload.to);
      if (sid) {
        const c = this.clients.find((cl) => cl.sessionId === sid);
        if (c) c.send('effect', payload);
      }
    }
  }

  // 把引擎 public 投影到同步 Schema
  private sync() {
    if (!this.engine) return;
    const p = this.engine.public;
    const st = this.state;
    st.phase = p.phase;
    st.playerCount = p.playerCount;
    st.roundIndex = p.roundIndex;
    st.startPlayer = p.turn.startPlayer ?? '';
    st.currentPlayer = p.turn.currentPlayer ?? '';
    st.subStep = p.turn.subStep ?? '';
    st.lastPlayer = p.turn.lastPlayer ?? '';
    st.winner = p.winner ?? '';
    st.finalScore = p.finalScore ?? -1;
    st.logLine = p.log[p.log.length - 1] ?? '';

    // 遊戲結束 → 排定 5 分鐘後自動關房(讓房號重新變成空房)
    if (p.phase === 'GAME_END' && !this.endTimer && !this.closing) {
      this.endTimer = setTimeout(() => this.closeRoom('ended'), 5 * 60 * 1000);
      this.updateMetadata(); // 讓大廳改顯示「已結束」而非「等待中」
    }

    replaceArray(st.roundAnimals, p.roundAnimals);
    replaceArray(st.actedPlayers, p.turn.actedPlayers);
    replaceArray(st.speechOrder, p.speech?.order ?? []);
    st.speechPointer = p.speech?.pointer ?? -1;

    for (const seat of p.seatOrder) st.connected.set(seat, p.connected[seat] ?? true);
    syncBoolMap(st.revealedReal, p.revealedReal);
    syncNumMap(st.lastTally, p.lastTally ?? {});

    replaceArray(st.turnOrdersJson, p.turnOrders.map((o) => o.join(',')));
    replaceArray(st.voteRoundsJson, p.voteRounds.map((v) => JSON.stringify(v)));
    st.endDetailJson = p.endDetail ? JSON.stringify(p.endDetail) : '';

    st.protectedList.clear();
    for (const e of p.protected) {
      const ps = new ProtectedEntrySchema();
      ps.animalId = e.animalId; ps.round = e.round; ps.realRevealed = e.realRevealed;
      st.protectedList.push(ps);
    }

    // 各玩家的剩餘票數為隱藏資訊 → 只私下送給本人
    for (const seat of p.seatOrder) {
      const sid = this.seatToSession(seat);
      const c = sid ? this.clients.find((cl) => cl.sessionId === sid) : undefined;
      if (c) c.send('mychips', p.chips[seat] ?? 0);
    }
  }

  // ── 離開 ──────────────────────────────────────────────────────────────
  // 非自願斷線(重整/掉線)→ 僅標記離線,保留座位等「同名+密碼」回來接管;
  // 自願離開 → 依階段釋放座位或標記離線。房間不自動銷毀(autoDispose=false),由閒置/結束/房主關閉控制。
  onLeave(client: Client, consented: boolean) {
    const seat = this.sessionToSeat.get(client.sessionId);
    if (this.closing) return;

    if (seat) {
      this.state.connected.set(seat, false);
      if (this.engine) this.engine.public.connected[seat] = false;
      this.sessionToSeat.delete(client.sessionId); // 解除舊 session 對應;座位仍保留供接管
    }
    this.updateMetadata();

    if (consented) this.handleConsentedLeave(client, seat);
  }

  // 自願離開遊戲
  private handleConsentedLeave(_client: Client, seat?: PlayerId) {
    if (!seat) return;
    this.sessionToSeat.delete(this.seatToSession(seat) ?? '');
    // 房主主動離開 → 整局結束(關閉房間)
    if (seat === this.hostSeat) { this.closeRoom('host'); return; }
    if (this.state.phase === 'LOBBY' && !this.started) {
      // 還沒開局:直接釋放座位,讓別人能補進
      const i = this.state.seatOrder.indexOf(seat);
      if (i >= 0) this.state.seatOrder.splice(i, 1);
      this.state.names.delete(seat);
      this.state.connected.delete(seat);
      delete this.privateLog[seat];
    } else {
      // 進行中:保留座位但標記永久離線(避免破壞回合資料)
      this.state.connected.set(seat, false);
      if (this.engine) this.engine.public.connected[seat] = false;
    }
    this.updateMetadata();
    this.touch();
  }

  // 閒置計時:任何活動都重置;到時自動關房
  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.closeRoom('timeout'), this.IDLE_MS);
  }

  // 關閉房間:通知所有人後銷毀
  private closeRoom(reason: 'host' | 'timeout' | 'ended') {
    if (this.closing) return;
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.broadcast('room_closed', { reason });
    this.disconnect();
  }

  onDispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
  }

  private sendError(client: Client, message: string) {
    client.send('error', { message });
  }

  // 依當前引擎狀態,補送該玩家「被偷襲 / 無法鑑定(失能)」的提示(重連用)。封鎖鑑定不另行提示。
  private sendTurnStatus(client: Client, seat: PlayerId) {
    if (!this.engine) return;
    const st = turnStatusFor(this.engine, seat);
    if (st === 'GANKED') client.send('effect', { to: seat, kind: 'GANKED' });
    else if (st === 'JI_DISABLED') client.send('effect', { to: seat, kind: 'JI_DISABLED' });
  }

  // 房間中繼資料:供登入畫面顯示房間 1/2/3 的占用狀態
  private updateMetadata() {
    this.setMetadata({
      slot: this.slot,
      players: this.state.seatOrder.length,
      maxPlayers: this.targetCount,
      started: this.started,
      ended: this.state.phase === 'GAME_END',
    });
  }

  private seatToSession(seat: PlayerId): string | null {
    for (const [sid, s] of this.sessionToSeat) if (s === seat) return sid;
    return null;
  }
}

function replaceArray<T>(arr: { length: number; push: (v: T) => void; splice: (s: number, d: number) => void }, vals: T[]) {
  arr.splice(0, arr.length);
  for (const v of vals) arr.push(v);
}
function syncBoolMap(m: any, obj: Record<number, boolean>) {
  for (const [k, v] of Object.entries(obj)) m.set(k, v);
}
function syncNumMap(m: any, obj: Record<number, number>) {
  m.clear?.();
  for (const [k, v] of Object.entries(obj)) m.set(k, v);
}
