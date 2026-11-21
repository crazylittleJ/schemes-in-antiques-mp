// 全伺服器暱稱登記:同一個暱稱同時只能存在於一個房間(房內由座位持有,直到座位被釋放或房間銷毀)。
// 單一 process 的記憶體表即可(免費層、單一 Render service)。

interface Owner { roomId: string; slot: number; }

const owners = new Map<string, Owner>();

// 暱稱目前被哪個房間持有(沒有則回 undefined)
export function nameOwner(name: string): Owner | undefined {
  return owners.get(name);
}

// 由房間登記暱稱;已被「別的房間」持有則回 false
export function claimName(name: string, roomId: string, slot: number): boolean {
  const cur = owners.get(name);
  if (cur && cur.roomId !== roomId) return false;
  owners.set(name, { roomId, slot });
  return true;
}

export function releaseName(name: string, roomId: string) {
  if (owners.get(name)?.roomId === roomId) owners.delete(name);
}

export function releaseRoom(roomId: string) {
  for (const [name, o] of owners) if (o.roomId === roomId) owners.delete(name);
}
