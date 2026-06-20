// 古董局中局 — engine types (規格 v1)
// 純資料型別,不依賴任何框架。

export type PlayerId = string;
export type AnimalId = number; // 0..11,生肖順序 = 平票優先序

export const ANIMALS = ['鼠', '牛', '虎', '兔', '龍', '蛇', '馬', '羊', '猴', '雞', '狗', '豬'] as const;

export type RoleId =
  | '許願' | '方震' | '黃煙煙' | '木戶加奈' | '姬云浮' // GOOD
  | '老朝奉' | '藥不然' | '鄭國渠';                      // BAD

export type Camp = 'GOOD' | 'BAD';

export type Phase =
  | 'LOBBY' | 'ROLE_DEAL' | 'ROUND_START' | 'TURN'
  | 'SPEECH' | 'VOTE' | 'REVEAL'
  | 'IDENTITY_REVEAL' | 'SCORING' | 'GAME_END';

export type SubStep = 'AWAIT_IDENTIFY' | 'AWAIT_ABILITY' | 'AWAIT_PASS' | null;

export type AppraisalResult = 'REAL' | 'FAKE' | 'UNIDENTIFIABLE';

export interface ProtectedEntry {
  animalId: AnimalId;
  round: number;
  realRevealed: boolean; // 第二高票 = true(當下公開真偽);第一高票 = false
}

export interface VoteRound {
  round: number;
  animals: AnimalId[];
  tally: Record<AnimalId, number>;
  breakdown: { seat: PlayerId; alloc: Record<AnimalId, number> }[]; // 誰投了什麼(開票後公開)
  top: AnimalId[]; // [第一高票, 第二高票]
  reveals: Record<AnimalId, boolean>; // 本輪當下公開真偽者(第二高票)
}

export interface EndDetail {
  identityRevealed: boolean;       // 是否經過身份揭露(直接六分獲勝則為 false)
  protectedReals: AnimalId[];
  laoGuessXu: PlayerId | null; xuActual: PlayerId | null; xuBonus: number;
  yaoGuessFang: PlayerId | null; fangActual: PlayerId | null; fangBonus: number;
  goodGuessLao: { seat: PlayerId; target: PlayerId }[]; laoActual: PlayerId | null; foundLao: number; threshold: number; laoBonus: number;
  roles: Record<PlayerId, RoleId>; // 終局公開所有身份
}

export interface PublicState {
  phase: Phase;
  playerCount: number;
  seatOrder: PlayerId[];
  connected: Record<PlayerId, boolean>;

  roundIndex: number; // 0..2
  roundAnimals: AnimalId[]; // 本輪 4 獸首(生肖排序)

  turn: {
    startPlayer: PlayerId | null;
    currentPlayer: PlayerId | null;
    subStep: SubStep;
    actedPlayers: PlayerId[];
    lastPlayer: PlayerId | null; // 尾家
  };

  speech: { order: PlayerId[]; pointer: number } | null;

  protected: ProtectedEntry[];
  turnOrders: PlayerId[][];      // 每輪的行動順序(歷史)
  voteRounds: VoteRound[];       // 每輪開票結果(含誰投什麼)
  endDetail: EndDetail | null;   // 終局計分明細
  revealedReal: Record<AnimalId, boolean>;
  lastTally: Record<AnimalId, number> | null;
  chips: Record<PlayerId, number>;

  winner: Camp | null;
  finalScore: number | null; // 終局好人方分數(GAME_END 時填)
  log: string[]; // 只記公開事件
}

export interface SecretState {
  roles: Record<PlayerId, RoleId>;
  treasures: Record<AnimalId, { round: number; isReal: boolean }>;
  roundLayout: AnimalId[][]; // [3][4]
  blockedRound: Record<PlayerId, number>; // 只對 木戶加奈 / 黃煙煙
  jiPermanentlyDisabled: boolean;
  pendingGank: PlayerId[]; // set(用陣列代表,去重)
  fangViewed: PlayerId[];   // 方震已查看過的玩家(不可重複查看)
  roundEffects: { laoSwapActive: boolean; coveredAnimal: AnimalId | null };
  pendingVotes: Record<PlayerId, Record<AnimalId, number>>;
  guesses: {
    laoGuessXu: PlayerId | null;
    yaoGuessFang: PlayerId | null;
    goodGuessLao: Record<PlayerId, PlayerId>;
  };
  turnGanked: boolean;
}

export interface GameState {
  public: PublicState;
  secret: SecretState;
}

// 私訊給單一玩家的副作用(Colyseus 用 client.send 發送)
export type Effect =
  | { to: PlayerId; kind: 'YOUR_ROLE'; role: RoleId; camp: Camp }
  | { to: PlayerId; kind: 'TEAMMATE'; playerId: PlayerId; role: RoleId; name?: string }
  | { to: PlayerId; kind: 'IDENTIFY_RESULT'; animalId: AnimalId; result: AppraisalResult; round: number }
  | { to: PlayerId; kind: 'FACTION_RESULT'; targetId: PlayerId; camp: Camp; round: number }
  | { to: PlayerId; kind: 'ABILITY_USED'; round: number; ability: '真假互換' | '偷襲' | '覆蓋'; targetId?: PlayerId; animalId?: AnimalId }
  | { to: PlayerId; kind: 'GANKED' }
  | { to: PlayerId; kind: 'BLOCKED_ROUND'; round: number }
  | { to: PlayerId; kind: 'ERROR'; message: string };

export type Action =
  | { type: 'START_GAME' }
  | { type: 'IDENTIFY'; player: PlayerId; animalIds: AnimalId[] }
  | { type: 'SKIP_IDENTIFY'; player: PlayerId }
  | { type: 'VIEW_FACTION'; player: PlayerId; targetId: PlayerId }
  | { type: 'USE_ABILITY'; player: PlayerId; targetId?: PlayerId; animalId?: AnimalId }
  | { type: 'SKIP_ABILITY'; player: PlayerId }
  | { type: 'PASS_TURN'; player: PlayerId; targetId: PlayerId }
  | { type: 'SPEECH_DONE'; player: PlayerId }
  | { type: 'SUBMIT_VOTE'; player: PlayerId; allocation: Record<AnimalId, number> }
  | { type: 'CONTINUE'; player: PlayerId }
  | { type: 'GUESS_XU'; player: PlayerId; targetId: PlayerId }
  | { type: 'GUESS_FANG'; player: PlayerId; targetId: PlayerId }
  | { type: 'GUESS_LAO'; player: PlayerId; targetId: PlayerId };

export interface ApplyResult {
  state: GameState;
  effects: Effect[];
  ok: boolean;
  error?: string;
}

export type RNG = () => number; // [0,1)
