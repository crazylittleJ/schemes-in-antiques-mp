import { Room, Client } from 'colyseus';
import { GudongState, ProtectedEntrySchema } from './schema';
import { setupGame, applyAction } from '../engine/engine';
import { Action, Effect, GameState, PlayerId } from '../engine/types';

interface JoinOptions { name?: string; password?: string; playerCount?: number; }

// 一桌一局的房間。免費層、單一房間的用法下,狀態存記憶體即可。
export class GudongRoom extends Room<GudongState> {
  maxClients = 8;

  private password = '';
  private targetCount = 8;
  private hostSeat: PlayerId | null = null;

  private engine: GameState | null = null;            // 權威狀態(含 secret),不外送
  private sessionToSeat = new Map<string, PlayerId>(); // client.sessionId -> seatId
  private privateLog: Record<PlayerId, Effect[]> = {}; // 每位玩家的私訊歷史(供重連補送)
  private started = false;

  onCreate(options: JoinOptions) {
    this.password = options.password ?? '';
    this.targetCount = options.playerCount ?? 8;
    this.setState(new GudongState());
    this.state.phase = 'LOBBY';
    this.state.playerCount = this.targetCount;

    this.onMessage('action', (client, payload: Omit<Action, 'player'>) => {
      this.handleAction(client, payload);
    });
    this.onMessage('start', (client) => {
      const seat = this.sessionToSeat.get(client.sessionId);
      if (seat !== this.hostSeat) return this.sendError(client, '只有房主能開始遊戲');
      this.startGame(client);
    });
  }

  // 密碼驗證(0.17 簽名:onAuth(client, options, context))
  onAuth(_client: Client, options: JoinOptions) {
    if ((options.password ?? '') !== this.password) throw new Error('密碼錯誤');
    if (this.started) throw new Error('遊戲已開始,無法加入');
    return true;
  }

  onJoin(client: Client, options: JoinOptions) {
    const seat = `seat${this.state.seatOrder.length}`;
    this.sessionToSeat.set(client.sessionId, seat);
    this.privateLog[seat] = [];
    this.state.seatOrder.push(seat);
    this.state.names.set(seat, options.name || seat);
    this.state.connected.set(seat, true);
    this.state.chips.set(seat, 0);
    if (this.hostSeat === null) this.hostSeat = seat;
    client.send('seat', { seatId: seat, isHost: seat === this.hostSeat });
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
      this.privateLog[e.to]?.push(e);
      const sid = this.seatToSession(e.to);
      if (sid) {
        const c = this.clients.find((cl) => cl.sessionId === sid);
        if (c) c.send('effect', e);
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

    replaceArray(st.roundAnimals, p.roundAnimals);
    replaceArray(st.actedPlayers, p.turn.actedPlayers);
    replaceArray(st.speechOrder, p.speech?.order ?? []);
    st.speechPointer = p.speech?.pointer ?? -1;

    for (const seat of p.seatOrder) {
      st.chips.set(seat, p.chips[seat] ?? 0);
      st.connected.set(seat, p.connected[seat] ?? true);
    }
    syncBoolMap(st.revealedReal, p.revealedReal);
    syncNumMap(st.lastTally, p.lastTally ?? {});

    st.protectedList.clear();
    for (const e of p.protected) {
      const ps = new ProtectedEntrySchema();
      ps.animalId = e.animalId; ps.round = e.round; ps.realRevealed = e.realRevealed;
      st.protectedList.push(ps);
    }
  }

  // ── 重連(規格:重整不掉)───────────────────────────────────────────────
  // 0.17 也可改用 onDrop/onReconnect;此處用跨版本穩定的 onLeave + allowReconnection。
  async onLeave(client: Client, consented: boolean) {
    const seat = this.sessionToSeat.get(client.sessionId);
    if (seat) {
      this.state.connected.set(seat, false);
      if (this.engine) this.engine.public.connected[seat] = false;
    }
    try {
      if (consented) throw new Error('consented');
      await this.allowReconnection(client, 60); // 給 60 秒重連
      // 回來了
      if (seat) {
        this.state.connected.set(seat, true);
        if (this.engine) this.engine.public.connected[seat] = true;
        client.send('seat', { seatId: seat, isHost: seat === this.hostSeat });
        for (const e of this.privateLog[seat] ?? []) client.send('effect', e); // 補送私訊歷史
      }
    } catch {
      // 超時未回:保留座位(回合制,可由其他人代為推進);此處不移除
    }
  }

  private sendError(client: Client, message: string) {
    client.send('error', { message });
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
