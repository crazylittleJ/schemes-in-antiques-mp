// 同步給全房的「公開」狀態。祕密資訊(身份、真偽、能力發動)永不放這裡。
import { Schema, MapSchema, ArraySchema, defineTypes } from '@colyseus/schema';

export class ProtectedEntrySchema extends Schema {
  animalId = 0;
  round = 0;
  realRevealed = false;
}
defineTypes(ProtectedEntrySchema, { animalId: 'number', round: 'number', realRevealed: 'boolean' });

export class GudongState extends Schema {
  phase = 'LOBBY';
  playerCount = 0;
  roundIndex = 0;

  seatOrder = new ArraySchema<string>();
  hostSeat = '';                          // 房主座位(公開,供顯示皇冠)
  names = new MapSchema<string>();        // seatId -> 顯示名稱
  connected = new MapSchema<boolean>();   // seatId -> 連線中
  chips = new MapSchema<number>();        // seatId -> 可用籌碼

  roundAnimals = new ArraySchema<number>();

  startPlayer = '';
  currentPlayer = '';
  subStep = '';
  actedPlayers = new ArraySchema<string>();
  lastPlayer = '';

  speechOrder = new ArraySchema<string>();
  speechPointer = -1;

  protectedList = new ArraySchema<ProtectedEntrySchema>();
  revealedReal = new MapSchema<boolean>(); // animalId(字串) -> 真/假
  lastTally = new MapSchema<number>();     // animalId(字串) -> 票數

  winner = '';
  finalScore = -1;
  logLine = '';   // 最新一條公開訊息
}
defineTypes(GudongState, {
  phase: 'string',
  playerCount: 'number',
  roundIndex: 'number',
  seatOrder: ['string'],
  hostSeat: 'string',
  names: { map: 'string' },
  connected: { map: 'boolean' },
  chips: { map: 'number' },
  roundAnimals: ['number'],
  startPlayer: 'string',
  currentPlayer: 'string',
  subStep: 'string',
  actedPlayers: ['string'],
  lastPlayer: 'string',
  speechOrder: ['string'],
  speechPointer: 'number',
  protectedList: [ProtectedEntrySchema],
  revealedReal: { map: 'boolean' },
  lastTally: { map: 'number' },
  winner: 'string',
  finalScore: 'number',
  logLine: 'string',
});
