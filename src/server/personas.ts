// v2.0.0 — AI 玩家人設與角色風格
// personas:12 個 AI 玩家(頭像來自 client/public/avatars/*.png)。
// roleStyle:每個遊戲角色的發言風格(取自友人 n8n 工作流的角色節點),供發言生成使用。
import { RoleId } from '../engine/types';

export interface Persona {
  id: string;        // 對應頭像檔名(leo → /avatars/leo.png)
  name: string;      // 顯示暱稱(AI 玩家會以 name(AI) 呈現)
  kind: string;      // 簡短描述(性別/物種/年紀),純展示用
  avatar: string;    // 前端可直接用的路徑
}

// 12 位 AI 角色。動物(Barnaby/Pip/Jasper/Luna)同樣會說人話。
export const PERSONAS: Persona[] = [
  { id: 'leo',     name: 'Leo',     kind: 'Male, 20s',         avatar: '/avatars/leo.png' },
  { id: 'bella',   name: 'Bella',   kind: 'Female, 30s',       avatar: '/avatars/bella.png' },
  { id: 'barnaby', name: 'Barnaby', kind: 'Male Dog, Senior',  avatar: '/avatars/barnaby.png' },
  { id: 'aisha',   name: 'Aisha',   kind: 'Female, Teens',     avatar: '/avatars/aisha.png' },
  { id: 'kai',     name: 'Kai',     kind: 'Male, 40s',         avatar: '/avatars/kai.png' },
  { id: 'pip',     name: 'Pip',     kind: 'Penguin, Adult',    avatar: '/avatars/pip.png' },
  { id: 'lola',    name: 'Lola',    kind: 'Female, 60s',       avatar: '/avatars/lola.png' },
  { id: 'xiaojie', name: '小潔',    kind: 'Female, ~13',       avatar: '/avatars/xiaojie.png' },
  { id: 'jasper',  name: 'Jasper',  kind: 'Cat, Adult',        avatar: '/avatars/jasper.png' },
  { id: 'toby',    name: 'Toby',    kind: 'Male, 50s',         avatar: '/avatars/toby.png' },
  { id: 'zara',    name: 'Zara',    kind: 'Female, 20s',       avatar: '/avatars/zara.png' },
  { id: 'luna',    name: 'Luna',    kind: 'Dog, Puppy',        avatar: '/avatars/luna.png' },
];

export const personaById = (id: string): Persona | undefined => PERSONAS.find((p) => p.id === id);

// AI 玩家的顯示名:Leo → 「Leo(AI)」
export const aiDisplayName = (persona: Persona): string => `${persona.name}(AI)`;

// 保留暱稱集合:12 個原名 + 其 (AI) 變體,真人一律不可使用(無論是否真的加入 AI)。
const RESERVED = new Set<string>();
for (const p of PERSONAS) {
  RESERVED.add(p.name.trim().toLowerCase());
  RESERVED.add(aiDisplayName(p).trim().toLowerCase());
}
export function isReservedName(name: string): boolean {
  return RESERVED.has((name || '').trim().toLowerCase());
}

// ── 角色發言風格(取自友人工作流;姬雲浮→引擎用字「姬云浮」)─────────────────
export interface RoleStyle {
  style: string;   // 個性
  ability: string; // 能力(發言用語境)
  tone: string;    // 語氣
  example: string; // 範例語句(供模型對齊口吻)
  campLabel: string;
}

export const ROLE_STYLE: Record<RoleId, RoleStyle> = {
  許願:   { style: '穩重、邏輯嚴密、具權威感', ability: '懸絲診脈(準確鑑別真偽)', tone: '沉穩專業,江湖氣重', example: '懸絲診脈看過,此物胎土細膩,是鐵打的真跡。', campLabel: '好人陣營(首領)' },
  方震:   { style: '務實、鐵面無私、講求證據', ability: '刑偵搜查(能得知玩家陣營)', tone: '嚴肅精簡,不苟言笑', example: '辦案講求證據,別搞小動作。', campLabel: '好人陣營' },
  黃煙煙: { style: '火爆直率、嫉惡如仇', ability: '五脈鑑寶(動作俐落)', tone: '強勢直接,說話帶刺', example: '這東西胎釉這麼差,連贗品都稱不上,快扔了。', campLabel: '好人陣營' },
  木戶加奈: { style: '溫和謙虛、細膩多慮', ability: '國際視野(博學多聞)', tone: '客氣委婉,帶詢問口吻', example: '這氣息似乎不對,請問各位對此有何看法?', campLabel: '好人陣營' },
  姬云浮: { style: '冷靜清醒、抗干擾', ability: '破局金睛(免疫老朝奉干擾)', tone: '冷靜直接,就事論事', example: '不受擾亂,我看到的就是我說的。', campLabel: '好人陣營' },
  老朝奉: { style: '城府極深、深藏不露', ability: '幕後佈局(隱藏真實意圖)', tone: '滄桑低沉,話中有話', example: '古玩行水深,依我看這物件氣韻生動,再瞧瞧吧。', campLabel: '邪惡陣營(首領)' },
  藥不然: { style: '傲慢、玩世不恭、擅長擾亂', ability: '偽造技術(能看破贗品漏洞)', tone: '輕浮嘲諷,帶有挑釁', example: '別逗了,這東西一眼假,保它的人怕是腦子進水。', campLabel: '邪惡陣營' },
  鄭國渠: { style: '膽小偽裝、擅長推託', ability: '易容誤導(混淆視聽)', tone: '試探無辜,語帶苦笑', example: '我這門外漢看不準,你們帶風向太快了吧。', campLabel: '邪惡陣營' },
};
