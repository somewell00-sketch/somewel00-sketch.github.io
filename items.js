// Data-driven item definitions + helpers
//
// IMPORTANT:
// All items are defined in a real JSON file: ./data/items.json
// The simulation/UI reads this data and applies *generic* rules based on fields.
//
// To add new items in the future:
// 1) Add an entry to data/items.json
// 2) (Only if needed) extend the generic interpretation in sim.js/items.js

export const ItemTypes = {
  WEAPON: "weapon",
  PROTECTION: "protection",
  CONSUMABLE: "consumable",
  TRAP: "trap",
  UTILITY: "utility"
};

/**
 * @typedef {Object} ItemDefinition
 * @property {string} id
 * @property {string} type
 * @property {string} name
 * @property {string} icon
 * @property {string} description
 * @property {number|null} damage
 * @property {number|null} uses
 * @property {boolean} stackable
 * @property {boolean} breaksShield
 * @property {Object} requirements
 * @property {number|null} requirements.minDex
 * @property {boolean} requirements.dexGteTarget
 * @property {Object} effects
 */

let ITEM_DEFS = /** @type {Record<string, ItemDefinition>} */ ({});

let _initPromise = null;

function _normalizeType(t){
  // Accept either our internal types or JSON strings.
  switch(String(t || "").toLowerCase()){
    case "weapon": return ItemTypes.WEAPON;
    case "protection": return ItemTypes.PROTECTION;
    case "consumable": return ItemTypes.CONSUMABLE;
    case "trap": return ItemTypes.TRAP;
    case "utility": return ItemTypes.UTILITY;
    default: return String(t || "");
  }
}

function _normalizeDef(raw){
  if(!raw || !raw.id) return null;
  return {
    id: String(raw.id),
    type: _normalizeType(raw.type),
    name: String(raw.name || raw.id),
    icon: String(raw.icon || ""),
    description: String(raw.description || ""),
    damage: raw.damage == null ? null : Number(raw.damage),
    uses: raw.uses == null ? null : Number(raw.uses),
    stackable: !!raw.stackable,
    breaksShield: !!raw.breaksShield,
    requirements: {
      minDex: raw.requirements?.minDex == null ? null : Number(raw.requirements.minDex),
      dexGteTarget: !!raw.requirements?.dexGteTarget,
    },
    effects: raw.effects || {},
  };
}

export async function initItems(){
  if(_initPromise) return _initPromise;
  _initPromise = (async () => {
    const url = new URL("./data/items.json", import.meta.url);
    const res = await fetch(url);
    if(!res.ok) throw new Error(`Failed to load items.json (${res.status})`);
    const json = await res.json();
    const next = {};
    for(const [k, v] of Object.entries(json || {})){
      const def = _normalizeDef(v);
      if(def) next[def.id] = def;
      else if(v?.id) next[String(v.id)] = v;
      else if(k && v){
        const def2 = _normalizeDef({ ...v, id: v.id || k });
        if(def2) next[def2.id] = def2;
      }
    }
    ITEM_DEFS = next;
    return ITEM_DEFS;
  })();
  return _initPromise;
}

export const itemsReady = initItems();

export function getItemDef(id){
  return ITEM_DEFS[id] || null;
}

export function getAllItemDefs(){
  return ITEM_DEFS;
}

export function isStackable(defId){
  const d = getItemDef(defId);
  return !!d?.stackable;
}


export function getItemIcon(defId){
  const d = getItemDef(defId);
  if(d?.icon) return String(d.icon);
  // fallback by type
  switch(d?.type){
    case ItemTypes.WEAPON: return "⚔️";
    case ItemTypes.PROTECTION: return "🛡️";
    case ItemTypes.CONSUMABLE: return "🧪";
    case ItemTypes.UTILITY: return "🎒";
    case ItemTypes.TRAP: return "🪤";
    default: return "📦";
  }
}

export function displayDamageLabel(defId, qty = 1){
  const d = getItemDef(defId);
  if(!d || d.type !== ItemTypes.WEAPON) return "";
  const base = Number(d.damage) || 0;
  const dmg = d.stackable ? base * Math.max(1, qty) : base;
  if(dmg <= 0) return "";
  return `+${dmg}`;
}

export function computeWeaponDamage(def, qty, attacker, target, { forDispute = false } = {}){
  if(!def || def.type !== ItemTypes.WEAPON) return { ok:false, reason:"not_weapon", dmg:0 };

  // Requirements
  if(def.requirements?.minDex != null){
    if((attacker?.attrs?.D ?? 0) < def.requirements.minDex) return { ok:false, reason:"min_dex", dmg:0 };
  }
  if(def.requirements?.dexGteTarget){
    if((attacker?.attrs?.D ?? 0) < (target?.attrs?.D ?? 0)) return { ok:false, reason:"dex_too_low", dmg:0 };
  }

  let base = Number(def.damage) || 0;
  let dmg = base;

  if(def.stackable){
    dmg = base * Math.max(1, qty || 1);
    if(forDispute){
      dmg = base; // stackable does not stack in item disputes
    }
  }

  // Generic special rule: half damage if target has higher dex
  if(def.effects?.halfIfTargetDexHigher){
    if((target?.attrs?.D ?? 0) > (attacker?.attrs?.D ?? 0)){
      dmg = Math.floor(dmg / 2);
    }
  }

  return { ok:true, dmg };
}

export function isBlockedByShield(def){
  if(!def || def.type !== ItemTypes.WEAPON) return false;
  return !!def.effects?.blocksByShield;
}

export function isAxeShieldBreak(def){
  return !!def?.effects?.breaksShieldOnly;
}

export function isGrenade(def){
  return !!def?.effects?.penetratesShield;
}

export function isPoisonWeapon(def){
  return !!def?.effects?.appliesPoison;
}

export function potionRevealKind(instance){
  // instance.meta.hiddenKind: "medicine" | "poison"
  return instance?.meta?.hiddenKind || null;
}

export const INVENTORY_LIMIT = 7;

export function inventoryCount(inv){
  const items = inv?.items || [];
  let count = 0;
  for(const it of items){
    if(!it) continue;
    count += 1; // each stack occupies 1 slot
  }
  return count;
}

export function findItem(inv, defId){
  const idx = (inv?.items || []).findIndex(it => it?.defId === defId);
  return idx;
}

export function addToInventory(inv, instance){
  // Returns { ok, reason }
  if(!inv || !instance) return { ok:false, reason:"bad_args" };
  const def = getItemDef(instance.defId);
  if(!def) return { ok:false, reason:"unknown_item" };

  // Stack if allowed and stack exists
  if(def.stackable){
    const idx = findItem(inv, def.id);
    if(idx !== -1){
      const cur = inv.items[idx];
      cur.qty = Math.min(7, (cur.qty || 1) + (instance.qty || 1));
      return { ok:true };
    }
  }

  if(inventoryCount(inv) >= INVENTORY_LIMIT) return { ok:false, reason:"full" };
  inv.items.push({
    defId: def.id,
    qty: def.stackable ? Math.min(7, instance.qty || 1) : 1,
    usesLeft: def.uses == null ? null : (instance.usesLeft ?? def.uses),
    meta: instance.meta || {}
  });
  return { ok:true };
}

export function removeInventoryItem(inv, index){
  if(!inv || !Array.isArray(inv.items)) return null;
  if(index < 0 || index >= inv.items.length) return null;
  const removed = inv.items.splice(index, 1)[0];
  if(inv.equipped?.weaponDefId && removed?.defId === inv.equipped.weaponDefId){
    inv.equipped.weaponDefId = null;
  }
  if(inv.equipped?.defenseDefId && removed?.defId === inv.equipped.defenseDefId){
    inv.equipped.defenseDefId = null;
  }
  return removed;
}

export function strongestWeaponInInventory(inv, { forDispute = false } = {}){
  let best = null;
  for(const it of (inv?.items || [])){
    const def = getItemDef(it.defId);
    if(!def || def.type !== ItemTypes.WEAPON) continue;
    const dmg = computeWeaponDamage(def, it.qty, null, null, { forDispute }).dmg;
    if(!best || dmg > best.dmg){
      best = { def, qty: it.qty || 1, dmg };
    }
  }
  return best;
}

export function rankedWeaponsInInventory(inv, { forDispute = false } = {}){
  const list = [];
  for(const it of (inv?.items || [])){
    const def = getItemDef(it.defId);
    if(!def || def.type !== ItemTypes.WEAPON) continue;
    const qty = it.qty || 1;
    const dmg = computeWeaponDamage(def, qty, null, null, { forDispute }).dmg;
    list.push({ def, qty, dmg, defId: def.id });
  }
  list.sort((a,b)=> (b.dmg - a.dmg) || String(a.defId).localeCompare(String(b.defId)));
  return list;
}

export function weaponByRank(inv, rank, { forDispute = false } = {}){
  const list = rankedWeaponsInInventory(inv, { forDispute });
  return list[rank] || null;
}
