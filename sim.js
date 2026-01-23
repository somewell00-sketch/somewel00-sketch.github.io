import { cloneWorld } from "./state.js";
import {
  getItemDef,
  getAllItemDefs,
  ItemTypes,
  computeWeaponDamage,
  isBlockedByShield,
  isAxeShieldBreak,
  INVENTORY_LIMIT,
  inventoryCount,
  addToInventory,
  removeInventoryItem,
  strongestWeaponInInventory,
  isPoisonWeapon
} from "./items.js";

export function isAdjacent(world, fromId, toId){
  const adj = world.map.adjById[String(fromId)] || [];
  return adj.includes(Number(toId));
}

export function maxSteps(entity){
  const hp = entity.hp ?? 100;
  const fp = entity.fp ?? 70;
  if((entity.trappedDays ?? 0) > 0) return 0;
  return (hp > 30 && fp > 20) ? 3 : 1;
}

function isAreaActive(world, areaId){
  const a = world.map.areasById[String(areaId)];
  return !!a && a.isActive !== false;
}

function canEnter(world, toAreaId){
  const a = world.map.areasById[String(toAreaId)];
  if(!a) return { ok:false, reason:"missing_area" };
  if(a.isActive === false) return { ok:false, reason:"area_closed" };
  if(a.hasWater && !a.hasBridge) return { ok:false, reason:"water_no_bridge" };
  return { ok:true };
}

function actorById(world, id){
  if(id === "player") return world.entities.player;
  return world.entities.npcs?.[id];
}

function prng(seed, day, salt){
  // deterministic 0..1
  let h = 2166136261 >>> 0;
  const s = String(seed) + "|" + String(day) + "|" + String(salt);
  for (let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // xorshift-ish
  h ^= h << 13; h >>>= 0;
  h ^= h >>> 17; h >>>= 0;
  h ^= h << 5; h >>>= 0;
  return (h >>> 0) / 4294967296;
}

function initiativeScore(seed, day, actorId){
  // Deterministic tiebreaker (single-player friendly): depends on seed + day + actorId.
  // Higher score = acts earlier.
  let h = 2166136261 >>> 0;
  const s = String(seed) + "|" + String(day) + "|init|" + String(actorId);
  for (let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Mix bits
  h ^= h << 13; h >>>= 0;
  h ^= h >>> 17; h >>>= 0;
  h ^= h << 5; h >>>= 0;
  return h >>> 0;
}

function applyDamage(target, dmg){
  target.hp = Math.max(0, (target.hp ?? 100) - dmg);
}

function dropAllItemsToGround(victim, area){
  const items = Array.isArray(victim?.inventory?.items) ? victim.inventory.items : [];
  if(!items.length) return;
  area.groundItems = Array.isArray(area.groundItems) ? area.groundItems : [];
  for(const it of items){
    // Drop unequipped copies too; keep instance shape.
    area.groundItems.push({ defId: it.defId, qty: it.qty || 1, meta: it.meta || {}, usesLeft: it.usesLeft ?? null });
  }
  victim.inventory.items = [];
  victim.inventory.equipped = { weaponDefId: null, defenseDefId: null };
}

function ensureAreaTrapList(area){
  area.traps = Array.isArray(area.traps) ? area.traps : [];
  return area.traps;
}

function applyTrapsAtStartOfDay(world, events, { day }){
  // Traps activate only starting the day after being set.
  for(const area of Object.values(world.map.areasById || {})){
    const traps = Array.isArray(area.traps) ? area.traps : [];
    if(!traps.length) continue;

    // Gather alive actors in this area.
    const actorsHere = [];
    const player = world.entities.player;
    if((player.hp ?? 0) > 0 && player.areaId === area.id) actorsHere.push(player);
    for(const npc of Object.values(world.entities.npcs || {})){
      if((npc.hp ?? 0) <= 0) continue;
      if(npc.areaId === area.id) actorsHere.push(npc);
    }
    if(!actorsHere.length) continue;

    // Process each trap; single-use traps are removed once triggered.
    const remaining = [];
    for(const t of traps){
      if(!t || !t.defId) continue;
      if(Number(t.armedOnDay) > Number(day)){
        remaining.push(t);
        continue;
      }

      if(t.kind === "net"){
        const ownerId = t.ownerId;
        const candidates = actorsHere.filter(a => a.id !== ownerId);
        if(!candidates.length){
          // Still consume the trap once armed.
          events.push({ type:"NET_TRIGGER", areaId: area.id, caught: [], spared: [] });
          continue;
        }

        const maxP = Math.max(...candidates.map(a => a.attrs?.P ?? 0));
        const spared = candidates.filter(a => (a.attrs?.P ?? 0) === maxP).map(a => a.id);
        const caughtActors = candidates.filter(a => (a.attrs?.P ?? 0) < maxP);

        // Optional protection: preventTrapOnce (from Survival Kit) lets you avoid being trapped once.
        const prevented = [];
        const caughtFinal = [];
        for(const a of caughtFinal){
          if(a?._meta?.preventTrapOnce){
            a._meta.preventTrapOnce = false;
            prevented.push(a.id);
          } else {
            caughtFinal.push(a);
          }
        }

        // Apply capture (2 days) to everyone except owner + highest perception.
        for(const a of caughtFinal){
          a.trappedDays = Math.max(a.trappedDays ?? 0, 2);
          events.push({ type:"NET_CAUGHT", who: a.id, areaId: area.id, days: 2 });
        }
        events.push({ type:"NET_TRIGGER", areaId: area.id, caught: caughtFinal.map(a => a.id), spared: [...spared, ...prevented] });
        continue;
      }

      if(t.kind === "mine"){
        const ownerId = t.ownerId;
        const candidates = actorsHere.filter(a => a.id !== ownerId);
        if(!candidates.length){
          events.push({ type:"MINE_BLAST", injured: [], dead: [] });
          continue;
        }

        const minP = Math.min(...candidates.map(a => a.attrs?.P ?? 0));
        const victims = candidates.filter(a => (a.attrs?.P ?? 0) === minP);

        const injured = [];
        const dead = [];
        for(const v of victims){
          applyDamage(v, 60);
          injured.push(v.id);
          events.push({ type:"MINE_HIT", who: v.id, dmg: 60 });
          if((v.hp ?? 0) <= 0){
            dead.push(v.id);
            // Death by mine: drop all items on the ground, no spoils.
            dropAllItemsToGround(v, area);
            events.push({ type:"DEATH", who: v.id, areaId: area.id, reason:"mine" });
          }
        }

        // Whole arena learns there was an accident, but not the area.
        events.push({ type:"MINE_BLAST", injured, dead });
        continue;
      }
    }
    area.traps = remaining;
  }
}

function openBackpackIntoInventory(world, owner, area, backpackInstance, events, { seed, day }){
  // Backpack contains 2–3 items (1d2+1). It disappears when collected.
  const count = 2 + Math.floor(prng(seed, day, `bp_count_${backpackInstance?.meta?.seedTag || ""}`) * 2); // 2 or 3

  const defs = getAllItemDefs();
  const pool = Object.values(defs || {}).filter(d => {
    if(!d || !d.id) return false;
    if(d.id === "backpack") return false;
    if(d.id === "fist") return false;
    // keep it simple: only real items
    return [ItemTypes.WEAPON, ItemTypes.PROTECTION, ItemTypes.CONSUMABLE, ItemTypes.UTILITY].includes(d.type);
  });

  function pickFromPool(i){
    if(!pool.length) return null;
    const r = prng(seed, day, `bp_pick_${backpackInstance?.meta?.seedTag || ""}_${i}`);
    return pool[Math.floor(r * pool.length)];
  }

  events.push({ type:"BACKPACK_OPEN", who: owner.id, areaId: area.id, count });

  for(let i=0;i<count;i++){
    const def = pickFromPool(i);
    if(!def) continue;

    let inst = { defId: def.id, qty: 1, meta: {} };
    if(def.stackable && (def.id === "knife" || def.id === "dagger")){
      const rQty = 1 + Math.floor(prng(seed, day, `bp_qty_${backpackInstance?.meta?.seedTag || ""}_${i}`) * 3);
      inst.qty = Math.max(1, Math.min(7, rQty));
    }

    if(def.id === "flask"){
      inst.meta.hiddenKind = (prng(seed, day, `bp_flask_${backpackInstance?.meta?.seedTag || ""}_${i}`) < 0.5) ? "medicine" : "poison";
    }

    const ok = addToInventory(owner.inventory, inst);
    if(ok.ok){
      events.push({ type:"BACKPACK_ITEM", ok:true, who: owner.id, itemDefId: inst.defId, qty: inst.qty || 1, areaId: area.id });
    } else {
      // Inventory full: drop to ground.
      area.groundItems = Array.isArray(area.groundItems) ? area.groundItems : [];
      area.groundItems.push(inst);
      events.push({ type:"BACKPACK_ITEM", ok:false, who: owner.id, itemDefId: inst.defId, qty: inst.qty || 1, areaId: area.id, reason:"inventory_full" });
    }
  }
}


function applyOnCollect(world, collector, area, itemInst, events){
  const def = getItemDef(itemInst?.defId);
  if(!def) return { consumed:false };

  if(def.effects?.autoConsumeOnCollect){
    // Restore FP (food/energy)
    if(def.effects?.restoreFP){
      const amt = Number(def.effects.restoreFP) || 0;
      if(amt > 0){
        collector.fp = Math.min(70, (collector.fp ?? 70) + amt);
        events.push({ type:"FP_GAIN", who: collector.id, by: "resource", amount: amt, itemDefId: def.id, areaId: area.id });
      }
    }

    // Heal HP (medical)
    if(def.effects?.healHP){
      const amt = Number(def.effects.healHP) || 0;
      if(amt > 0){
        collector.hp = Math.min(100, (collector.hp ?? 100) + amt);
        events.push({ type:"HEAL", who: collector.id, by: "resource", amount: amt, itemDefId: def.id, areaId: area.id });
      }
    }
    // Cure poison
    if(def.effects?.curePoison){
      const hadPoison = (collector.status || []).some(s => s?.type === "poison");
      if(hadPoison){
        collector.status = (collector.status || []).filter(s => s?.type !== "poison");
        events.push({ type:"POISON_CURED", who: collector.id, by: "resource", itemDefId: def.id, areaId: area.id });
      }
    }
    // Prevent trap once
    if(def.effects?.preventTrapOnce){
      collector._meta = collector._meta || {};
      collector._meta.preventTrapOnce = true;
      events.push({ type:"BUFF", who: collector.id, kind:"prevent_trap_once", itemDefId: def.id, areaId: area.id });
    }
    // Ignore move block today
    if(def.effects?.ignoreMoveBlockToday){
      collector._today = collector._today || {};
      collector._today.ignoreMoveBlock = true;
      events.push({ type:"BUFF", who: collector.id, kind:"ignore_move_block_today", itemDefId: def.id, areaId: area.id });
    }
    return { consumed:true };
  }

  return { consumed:false };
}


function spawnEnterRewardsIfNeeded(world, area, { seed, day }){
  if(!area || area.id === 1) return;
  if(area._rewardSpawned) return;
  area._rewardSpawned = true;

  const biome = String(area.biome || "").toLowerCase();
  area.groundItems = Array.isArray(area.groundItems) ? area.groundItems : [];

  // Food / healing resources (finite, consumed on collect)
  const vegetation = ["plains","woods","forest","jungle","savanna","caatinga"];
  const isVeg = vegetation.includes(biome);
  const isWater = (biome === "lake" || biome === "swamp");

  if(prng(seed, day, `spawn_food_${area.id}`) < (isVeg ? 0.40 : isWater ? 0.40 : 0.12)){
    let pick = "wild_fruits";
    if(["plains","savanna","caatinga"].includes(biome)) pick = "edible_roots";
    if(isWater) pick = "freshwater_fish";
    // Rare ration (very low)
    if(prng(seed+991, day, `spawn_ration_${area.id}`) < 0.03) pick = "capital_ration";
    area.groundItems.push({ defId: pick, qty: 1, meta: { spawned:true } });
  }

  // Backpack chance
  const bpChance = (biome === "industrial") ? 0.25 : 0.10;
  if(prng(seed, day, `spawn_backpack_${area.id}`) < bpChance){
    area.groundItems.push({ defId: "backpack", qty: 1, meta: { seedTag: `bp_enter_${area.id}_${day}` } });
  }
}

function applyDailyThreats(world, events, { seed, day }){
  const areas = Object.values(world.map?.areasById || {});
  for(const area of areas){
    if(!area) continue;
    if(area.id === 1) continue;
    if(area.isActive === false) continue;
    if(String(area.threatClass) !== "threatening") continue;

    const present = getAliveActorsInArea(world, area.id);
    if(present.length === 0) continue;

    const creatures = (area.activeElements || []).filter(e => e?.kind === "creature");
    let chance = 0.22;
    if(creatures.length) chance += 0.15;
    if(prng(seed, day, `threat_roll_${area.id}`) >= chance) continue;

    // Pick target: lowest Perception, tie by initiative
    const scored = present.map(a => ({
      id: a.id,
      P: a.attrs?.P ?? 0,
      init: initiativeScore(seed, day, a.id)
    })).sort((x,y)=>x.P-y.P || y.init-x.init);
    const target = actorById(world, scored[0].id);
    if(!target || (target.hp ?? 0) <= 0) continue;

    // Choose threat type
    const roll = prng(seed, day, `threat_kind_${area.id}`);
    let threatType = "hazard";
    if(creatures.length && roll < 0.70) threatType = "creature_attack";
    else if(roll < 0.45) threatType = "creature_attack";

    if(threatType === "creature_attack"){
      // Choose creature: prefer existing, else spawn a biome creature now (non-persistent)
      let creature = creatures.length ? creatures[Math.floor(prng(seed+17, day, `threat_cre_${area.id}`) * creatures.length)] : null;
      if(!creature){
        creature = { name:"Unknown Creature", dmgMin:8, dmgMax:18, modifier:null, modifierType:null, modifierValue:null };
      }

      let dmg = creature.dmgMin + Math.floor(prng(seed, day, `threat_dmg_${area.id}`) * (creature.dmgMax - creature.dmgMin + 1));
      if(creature.modifierType === "damage_add") dmg += Number(creature.modifierValue) || 0;
      if(creature.modifierType === "damage_mul") dmg = Math.floor(dmg * (Number(creature.modifierValue) || 1));

      applyDamage(target, dmg);
      events.push({ type:"THREAT", kind:"creature", areaId: area.id, target: target.id, creature: creature.modifier ? `${creature.modifier} ${creature.name}` : creature.name, dmg });

      if(creature.modifierType === "poison"){
        target.status = target.status || [];
        if(!(target.status || []).some(s => s?.type === "poison")){
          target.status.push({ type:"poison", perDay: 10, by:"creature" });
          events.push({ type:"POISON_APPLIED", who: target.id, by:"creature" });
        }
      }

      if((target.hp ?? 0) <= 0){
        events.push({ type:"DEATH", who: target.id, areaId: target.areaId, reason:"threat" });
      }
    } else {
      const dmg = 5 + Math.floor(prng(seed, day, `haz_dmg_${area.id}`) * 11); // 5..15
      applyDamage(target, dmg);
      events.push({ type:"THREAT", kind:"hazard", areaId: area.id, target: target.id, dmg });
      if((target.hp ?? 0) <= 0) events.push({ type:"DEATH", who: target.id, areaId: target.areaId, reason:"threat" });
    }
  }
}

function getAliveActorsInArea(world, areaId){
  const out = [];
  const p = world.entities?.player;
  if(p && (p.hp ?? 0) > 0 && p.areaId === areaId) out.push(p);
  for(const npc of Object.values(world.entities?.npcs || {})){
    if(npc && (npc.hp ?? 0) > 0 && npc.areaId === areaId) out.push(npc);
  }
  return out;
}



export function commitPlayerAction(world, action){
  // Applies immediately. Returns { nextWorld, events }.
  const next = cloneWorld(world);
  const day = next.meta.day;
  const seed = next.meta.seed;

  const events = [];
  const player = next.entities.player;
  if((player.hp ?? 0) <= 0){
    events.push({ type:"NO_ACTION", reason:"player_dead" });
    return { nextWorld: next, events };
  }

  // If trapped by a Net, the player cannot take normal actions or move.
  // The only allowed escape is cutting the net using a Dagger.
  if((player.trappedDays ?? 0) > 0){
    const kind = action?.kind || "NOTHING";
    if(kind !== "CUT_NET"){
      events.push({ type:"TRAPPED", days: player.trappedDays, areaId: player.areaId });
      return { nextWorld: next, events };
    }
  }

  // reset one-day combat flags (preserve hunger/other day state)
  player._today = player._today || {};
  player._today.defendedWithShield = false;
  player._today.invisible = false;

  const kind = action?.kind || "NOTHING";

  const npcsHere = Object.values(next.entities.npcs || {})
    .filter(n => (n.hp ?? 0) > 0 && n.areaId === player.areaId);

  function pickRandomNpc(tag){
    if(!npcsHere.length) return null;
    const r = prng(seed, day, tag);
    return npcsHere[Math.floor(r * npcsHere.length)];
  }

  function getEquippedWeapon(entity){
    const defId = entity?.inventory?.equipped?.weaponDefId || null;
    if(!defId) return null;
    const inst = (entity.inventory.items || []).find(it => it.defId === defId) || null;
    if(!inst) return null;
    const def = getItemDef(defId);
    if(!def || def.type !== ItemTypes.WEAPON) return null;
    return { def, inst };
  }

  function computeAttackDamage(attacker, target, { forDispute = false } = {}){
    const w = getEquippedWeapon(attacker);
    if(!w){
      // fists
      const base = 5;
      const bonus = Math.floor(prng(seed, day, `rpg_bonus_${attacker.id}`) * 4); // 0..3
      return { ok:true, dmg: base + bonus, weaponDefId: null, meta: { fists: true } };
    }

    const res = computeWeaponDamage(w.def, w.inst.qty, attacker, target, { forDispute });
    if(!res.ok) return { ok:false, reason: res.reason, dmg:0, weaponDefId: w.def.id, meta:{} };

    return { ok:true, dmg: res.dmg, weaponDefId: w.def.id, meta: { weapon: w.def.name } };
  }

  function spendWeaponUse(entity, weaponDefId){
    if(!weaponDefId) return;
    const inst = (entity.inventory.items || []).find(it => it.defId === weaponDefId);
    if(!inst) return;
    if(inst.usesLeft == null) return;
    inst.usesLeft = Math.max(0, inst.usesLeft - 1);
    if(inst.usesLeft <= 0){
      // remove item
      const idx = (entity.inventory.items || []).findIndex(it => it.defId === weaponDefId);
      if(idx !== -1) removeInventoryItem(entity.inventory, idx);
    }
  }

  function addStatus(entity, status){
    if(!entity.status) entity.status = [];
    entity.status.push(status);
  }

  function hasStatus(entity, kind){
    return (entity.status || []).some(s => s?.type === kind);
  }

  
  if(kind === "COLLECT"){
    const area = next.map.areasById[String(player.areaId)];
    if(!area || !Array.isArray(area.groundItems) || area.groundItems.length === 0){
      events.push({ type:"COLLECT", ok:false, reason:"no_item" });
      return { nextWorld: next, events };
    }

    const idx = Number(action?.itemIndex ?? 0);
    const item = area.groundItems[idx] ?? area.groundItems[0];
    if(!item){
      events.push({ type:"COLLECT", ok:false, reason:"missing_item" });
      return { nextWorld: next, events };
    }

    // Determine NPC contenders who are also trying to collect this same ground item today.
    // We mirror the NPC intent generator to keep this deterministic and single-player friendly.
    const contenders = [{ id:"player", actor: player }];
    for(const npc of Object.values(next.entities.npcs || {})){
      if((npc.hp ?? 0) <= 0) continue;
      if(npc.areaId !== player.areaId) continue;

      const npcArea = next.map.areasById[String(npc.areaId)];
      const ground = Array.isArray(npcArea?.groundItems) ? npcArea.groundItems : [];
      if(!ground.length) continue;

      const invCount = inventoryCount(npc.inventory);
      const rCollect = prng(seed, day, `collect_${npc.id}`);
      if(invCount < INVENTORY_LIMIT && rCollect < 0.25){
        const pickIdx = Math.floor(prng(seed+1337, day, `collect_pick_${npc.id}`) * ground.length);
        if(pickIdx === idx){
          contenders.push({ id: npc.id, actor: npc });
        }
      }
    }

    // Decide winner: higher Dexterity wins. Tie for best => fight now.
    const scored = contenders.map(c => ({
      ...c,
      D: c.actor.attrs?.D ?? 0,
      init: initiativeScore(seed, day, c.id)
    })).sort((a,b)=>b.D-a.D || b.init-a.init);

    const bestD = scored[0].D;
    const best = scored.filter(x => x.D === bestD);

    let winnerId = null;
    if(best.length === 1){
      winnerId = best[0].id;
      events.push({ type:"GROUND_CONTEST", areaId: area.id, itemDefId: item.defId, outcome:"dex_win", winner: winnerId });
    } else {
      const startAreas = { player: player.areaId };
      for(const npc of Object.values(next.entities.npcs || {})) startAreas[npc.id] = npc.areaId;

      const fight = resolveTieFight(next, best.map(b=>b.id), area.id, { seed, day, killsThisDay: (next.flags?.killsThisDay || (next.flags.killsThisDay=[])), itemDefId: item.defId, startAreas });
      winnerId = fight.winner || null;
      events.push({ type:"GROUND_CONTEST", areaId: area.id, itemDefId: item.defId, outcome:"tie_fight", tied: best.map(b=>b.id), winner: winnerId });
    }

    const winner = winnerId ? actorById(next, winnerId) : null;
    if(!winner || (winner.hp ?? 0) <= 0){
      events.push({ type:"COLLECT", ok:false, reason:"no_winner", itemDefId: item.defId, areaId: area.id });
      return { nextWorld: next, events };
    }

    // Remove the item from the ground now (it is claimed by the winner).
    const removed = area.groundItems.splice(idx, 1)[0];

    // Backpack rule: opens immediately into 2–3 items, backpack disappears.
    if(removed.defId === "backpack"){
      const lootEvents = [];
      openBackpackIntoInventory(next, winner, area, removed, lootEvents, { seed, day });
      events.push({ type:"COLLECT", ok:true, who: winnerId, itemDefId:"backpack", qty:1, areaId: area.id, note:"opened" });
      events.push(...lootEvents);
      return { nextWorld: next, events };
    }

    // Normal item pickup.

    // Auto-consume resources on collect (finite).
    const consumed = applyOnCollect(next, winner, area, removed, events);
    if(consumed.consumed){
      events.push({ type:"COLLECT", ok:true, who: winnerId, itemDefId: removed.defId, qty: removed.qty || 1, areaId: area.id, note:"consumed_on_collect" });
      return { nextWorld: next, events };
    }
    const ok = addToInventory(winner.inventory, removed);
    if(!ok.ok){
      // Can't take: drop it back to ground (end) and report.
      area.groundItems.push(removed);
      events.push({ type:"COLLECT", ok:false, who: winnerId, reason:"inventory_full", itemDefId: removed.defId, areaId: area.id });
      return { nextWorld: next, events };
    }

    events.push({ type:"COLLECT", ok:true, who: winnerId, itemDefId: removed.defId, qty: removed.qty || 1, areaId: area.id });
    return { nextWorld: next, events };
  }

  if(kind === "SET_TRAP"){
    const trapDefId = action?.trapDefId;
    const def = trapDefId ? getItemDef(trapDefId) : null;
    if(!def || def.type !== "trap"){
      events.push({ type:"TRAP_SET", ok:false, reason:"invalid_trap" });
      return { nextWorld: next, events };
    }
    // Consume one trap item from inventory.
    const rem = removeInventoryItem(player.inventory, trapDefId, 1);
    if(!rem.ok){
      events.push({ type:"TRAP_SET", ok:false, reason:"missing_item", trapDefId });
      return { nextWorld: next, events };
    }

    const area = next.map.areasById[String(player.areaId)];
    if(!area){
      events.push({ type:"TRAP_SET", ok:false, reason:"missing_area", trapDefId });
      return { nextWorld: next, events };
    }

    const traps = ensureAreaTrapList(area);
    const kind = def.effects?.trapKind || trapDefId;
    traps.push({ defId: trapDefId, kind, ownerId: "player", armedOnDay: day + 1 });
    events.push({ type:"TRAP_SET", ok:true, trapDefId, areaId: player.areaId, armedOnDay: day + 1 });
    return { nextWorld: next, events };
  }

  if(kind === "CUT_NET"){
    // Use one Dagger to escape. The Dagger becomes useless (we remove it).
    const hasDagger = (player.inventory?.items || []).some(it => it.defId === "dagger" && (it.qty || 1) > 0);
    if(!hasDagger){
      events.push({ type:"CUT_NET", ok:false, reason:"no_dagger" });
      return { nextWorld: next, events };
    }
    removeInventoryItem(player.inventory, "dagger", 1);
    player.trappedDays = 0;
    events.push({ type:"CUT_NET", ok:true, areaId: player.areaId });
    return { nextWorld: next, events };
  }

  if(kind === "DEFEND"){
    // If you have a Shield equipped as defense, it becomes active for the day.
    const defId = player.inventory?.equipped?.defenseDefId;
    if(defId === "shield"){
      player._today.defendedWithShield = true;
      events.push({ type:"DEFEND", ok:true, with:"Shield" });
    } else {
      events.push({ type:"DEFEND", ok:true });
    }

    if(!npcsHere.length){
      events.push({ type:"INFO", msg:"No threats nearby." });
      return { nextWorld: next, events };
    }

    // 50% chance of being attacked while defending
    const attacked = prng(seed, day, "def_atk") < 0.5;
    if(!attacked){
      events.push({ type:"INFO", msg:"No one attacked you." });
      return { nextWorld: next, events };
    }

    const attacker = pickRandomNpc("def_attacker");
    const atk = computeAttackDamage(attacker, player);
    let incoming = atk.ok ? atk.dmg : 8;

    // Shield blocks incoming (unless weapon is not blocked)
    if(player._today.defendedWithShield){
      const w = getEquippedWeapon(attacker);
      const blocked = w ? isBlockedByShield(w.def) : true;
      if(blocked){
        incoming = 0;
        events.push({ type:"SHIELD_BLOCK", who:"player", from: attacker?.id ?? "unknown" });
      }
    }

    if(incoming > 0){
      applyDamage(player, incoming);
      events.push({ type:"DAMAGE_RECEIVED", from: attacker?.id ?? "unknown", dmg: incoming });
      if((player.hp ?? 0) <= 0) events.push({ type:"DEATH", who:"player", areaId: player.areaId });
    }
    return { nextWorld: next, events };
  }

  if(kind === "DRINK"){
    const area = next.map?.areasById?.[String(player.areaId)];
    if(!area?.hasWater){
      events.push({ type:"DRINK", ok:false, reason:"no_water" });
      return { nextWorld: next, events };
    }
    const before = Number(player.fp ?? 70);
    player.fp = Math.min(70, before + 5);
    const gained = Math.max(0, player.fp - before);
    // Drinking counts as feeding for starvation rules
    player._today = player._today || {};
    player._today.fed = true;
    player._today.mustFeed = false;
    events.push({ type:"DRINK", ok:true, gained, fp: player.fp, areaId: player.areaId });
    return { nextWorld: next, events };
  }

  if(kind === "ATTACK"){
    const targetId = action?.targetId || null;
    const target = targetId ? actorById(next, targetId) : null;

    if(!target || (target.hp ?? 0) <= 0 || target.areaId !== player.areaId){
      events.push({ type:"ATTACK", ok:false, reason:"no_valid_target" });
      return { nextWorld: next, events };
    }

    // Camouflage: you cannot be attacked, but can still attack.
    if(target._today?.invisible){
      events.push({ type:"ATTACK", ok:false, reason:"target_invisible" });
      return { nextWorld: next, events };
    }

    const atk = computeAttackDamage(player, target);
    if(!atk.ok){
      events.push({ type:"ATTACK", ok:false, reason: atk.reason || "requirements" });
      return { nextWorld: next, events };
    }

    let dmg = atk.dmg;

    const w = atk.weaponDefId ? getItemDef(atk.weaponDefId) : null;

    // Target shield block if they defended with shield
    if(target._today?.defendedWithShield && w && isBlockedByShield(w)){
      dmg = 0;
      events.push({ type:"SHIELD_BLOCK", who: targetId, from: "player" });
    }

    // Axe breaks shield: removes shield, no damage
    if(w && isAxeShieldBreak(w) && target._today?.defendedWithShield){
      dmg = 0;
      target._today.defendedWithShield = false;
      events.push({ type:"SHIELD_BROKEN", who: targetId, by:"player" });
    }

    if(dmg > 0){
      applyDamage(target, dmg);
      events.push({ type:"ATTACK", ok:true, target: targetId, dmgDealt: dmg, weapon: w?.name || "Fists" });
    } else {
      events.push({ type:"ATTACK", ok:true, target: targetId, dmgDealt: 0, weapon: w?.name || "Fists", note:"blocked" });
    }

    // Weapon use consumption
    if(atk.weaponDefId) spendWeaponUse(player, atk.weaponDefId);

    // Grenade self-damage
    if(w?.effects?.selfDamage){
      applyDamage(player, Number(w.effects.selfDamage) || 0);
      events.push({ type:"SELF_DAMAGE", who:"player", dmg: Number(w.effects.selfDamage) || 0, weapon: w.name });
    }

    // Blowgun poison
    if(w && isPoisonWeapon(w)){
      if(!hasStatus(target, "poison")) addStatus(target, { type:"poison", perDay: 10 });
      events.push({ type:"POISON_APPLIED", who: targetId, by:"player" });
    }

    if((target.hp ?? 0) <= 0){
      events.push({ type:"DEATH", who: targetId, areaId: target.areaId });
      player.kills = (player.kills ?? 0) + 1;
      // Record kill for deterministic spoils.
      next.flags = next.flags || {};
      next.flags.killsThisDay = Array.isArray(next.flags.killsThisDay) ? next.flags.killsThisDay : [];
      next.flags.killsThisDay.push({ deadId: targetId, areaId: target.areaId, participants: ["player"], reason: "attack" });
    }
    if((player.hp ?? 0) <= 0){
      events.push({ type:"DEATH", who: "player", areaId: player.areaId });
    }

    return { nextWorld: next, events };
  }

  // NOTHING
  // If there are NPCs here, there is a chance you get hit (you were careless).
  if(npcsHere.length && prng(seed, day, "nth_atk") < 0.35){
    const attacker = pickRandomNpc("nth_attacker");
    const atk = computeAttackDamage(attacker, player);
    let dmg = atk.ok ? atk.dmg : 5;

    // If you are invisible (camouflage), name not revealed, but you still take trap damage only.
    // For now, NOTHING damage is considered a sneak hit; camouflage prevents being attacked.
    if(player._today?.invisible){
      dmg = 0;
      events.push({ type:"NOTHING", ok:true, note:"camouflage_prevented_attack" });
      return { nextWorld: next, events };
    }

    applyDamage(player, dmg);
    events.push({ type:"NOTHING", ok:true, note:"caught_off_guard" });
    events.push({ type:"DAMAGE_RECEIVED", from: attacker?.id ?? "unknown", dmg });
    if((player.hp ?? 0) <= 0) events.push({ type:"DEATH", who:"player", areaId: player.areaId });
    return { nextWorld: next, events };
  }

  // Environmental hazard chance even if alone.
  if(prng(seed, day, "nth_haz") < 0.15){
    const dmg = 3 + Math.floor(prng(seed, day, "nth_haz_dmg") * 5); // 3..7
    applyDamage(player, dmg);
    events.push({ type:"NOTHING", ok:true });
    events.push({ type:"DAMAGE_RECEIVED", from:"environment", dmg });
    if((player.hp ?? 0) <= 0) events.push({ type:"DEATH", who:"player", areaId: player.areaId });
    return { nextWorld: next, events };
  }

  events.push({ type:"NOTHING", ok:true, note:"quiet_day" });
  return { nextWorld: next, events };
}

export function useInventoryItem(world, who, itemIndex, targetId = who){
  const next = cloneWorld(world);
  const day = next.meta.day;
  const seed = next.meta.seed;
  const events = [];

  const user = actorById(next, who);
  const target = actorById(next, targetId);
  if(!user || !target) return { nextWorld: next, events: [{ type:"USE_ITEM", ok:false, reason:"missing_actor" }] };
  if((user.hp ?? 0) <= 0) return { nextWorld: next, events: [{ type:"USE_ITEM", ok:false, reason:"user_dead" }] };

  const inv = user.inventory;
  const it = (inv?.items || [])[itemIndex];
  if(!it) return { nextWorld: next, events: [{ type:"USE_ITEM", ok:false, reason:"missing_item" }] };
  const def = getItemDef(it.defId);
  if(!def || def.type !== ItemTypes.CONSUMABLE) return { nextWorld: next, events: [{ type:"USE_ITEM", ok:false, reason:"not_consumable" }] };

  // Apply effects (data-driven flags)
  if(def.effects?.invisibleOneDay){
    user._today = user._today || {};
    user._today.invisible = true;
    events.push({ type:"USE_ITEM", ok:true, who, itemDefId:def.id });
    events.push({ type:"INVISIBLE", who });
  } else if(def.id === "flask" && def.effects?.revealOnUse){
    const kind = it.meta?.hiddenKind || (prng(seed, day, `flask_${who}_${itemIndex}`) < 0.5 ? "medicine" : "poison");
    if(kind === "medicine"){
      const hadPoison = (target.status || []).some(s => s?.type === "poison");
      if(hadPoison){
        target.status = (target.status || []).filter(s => s?.type !== "poison");
        events.push({ type:"FLASK_REVEAL", who, kind:"Medicine" });
        events.push({ type:"POISON_CURED", who: targetId, by: who });
      } else {
        target.hp = Math.min(100, (target.hp ?? 100) + 30);
        events.push({ type:"FLASK_REVEAL", who, kind:"Medicine" });
        events.push({ type:"HEAL", who: targetId, by: who, amount: 30 });
      }
    } else {
      events.push({ type:"FLASK_REVEAL", who, kind:"Poison" });
      // Poison only works if target "accepts"; for now: self-use always accepts.
      if(targetId === who){
        target.hp = 0;
        events.push({ type:"POISON_DRINK", who: targetId });
        events.push({ type:"DEATH", who: targetId, areaId: target.areaId, note:"poison" });
      } else {
        events.push({ type:"USE_ITEM", ok:false, reason:"target_must_accept" });
        return { nextWorld: next, events };
      }
    }
  } else {
    events.push({ type:"USE_ITEM", ok:false, reason:"unhandled" });
    return { nextWorld: next, events };
  }

  // Consume one use and remove item
  removeInventoryItem(inv, itemIndex);
  return { nextWorld: next, events };
}

export function moveActorOneStep(world, who, toAreaId){
  // Mutates world. Returns { ok, events: [] }
  const events = [];
  const entity = actorById(world, who);
  if(!entity) return { ok:false, events };

  if((entity.hp ?? 0) <= 0) return { ok:false, events };

  if((entity.trappedDays ?? 0) > 0){
    if(entity._today?.ignoreMoveBlock){
      entity._today.ignoreMoveBlock = false;
      events.push({ type:"MOVE_BLOCK_IGNORED", who, reason:"trapped" });
    } else {
      events.push({ type:"MOVE_BLOCKED", who, from: entity.areaId, to: Number(toAreaId), reason:"trapped" });
      return { ok:false, events };
    }
  }

  const from = entity.areaId;
  const to = Number(toAreaId);

  if(!isAreaActive(world, from)){
    events.push({ type:"MOVE_BLOCKED", who, from, to, reason:"start_area_closed" });
    return { ok:false, events };
  }
  if(!isAdjacent(world, from, to)){
    events.push({ type:"MOVE_BLOCKED", who, from, to, reason:"not_adjacent" });
    return { ok:false, events };
  }
  const enter = canEnter(world, to);
  if(!enter.ok){
    events.push({ type:"MOVE_BLOCKED", who, from, to, reason: enter.reason });
    return { ok:false, events };
  }

  entity.areaId = to;
  events.push({ type:"MOVE", who, from, to });

  // Finite resource spawns happen on first entry (data-driven).
  const area = world.map?.areasById?.[String(to)];
  spawnEnterRewardsIfNeeded(world, area, { seed: world.meta.seed, day: world.meta.day });

  // Creature encounters: if the destination has any creature elements, a creature will attack immediately.
  // Target selection follows the same ordering rule as daily threats: lowest Perception, tie by initiative.
  if(area && area.isActive !== false){
    // If the player is the one entering, always make the creature hit the entrant.
    // Otherwise, use the usual target rule (lowest Perception, tie by initiative).
    const forcedTargetId = (who === "player") ? "player" : null;
    triggerCreatureEncounterOnEnter(world, area, { seed: world.meta.seed, day: world.meta.day, forcedTargetId }, events);
  }


  if(who === "player"){
    const v = new Set(world.flags.visitedAreas || []);
    v.add(1); v.add(to);
    world.flags.visitedAreas = Array.from(v).sort((a,b)=>a-b);
  }
  return { ok:true, events };
}

function triggerCreatureEncounterOnEnter(world, area, { seed, day, forcedTargetId = null }, events){
  const creatures = (area.activeElements || []).filter(e => e?.kind === "creature");
  if(!creatures.length) return;

  const present = getAliveActorsInArea(world, area.id);
  if(present.length === 0) return;

  let target = null;
  if(forcedTargetId){
    target = actorById(world, forcedTargetId);
  }
  if(!target){
    // Pick target: lowest Perception, tie by initiative.
    const scored = present.map(a => ({
      id: a.id,
      P: a.attrs?.P ?? 0,
      init: initiativeScore(seed, day, a.id)
    })).sort((x,y)=>x.P-y.P || y.init-x.init);
    target = actorById(world, scored[0].id);
  }
  if(!target || (target.hp ?? 0) <= 0) return;

  // Pick one creature deterministically (keeps encounters readable even if multiple creatures exist).
  const idx = Math.floor(prng(seed + 17, day, `enter_cre_${area.id}_${target.id}`) * creatures.length);
  const creature = creatures[Math.max(0, Math.min(creatures.length - 1, idx))];

  let dmg = (creature.dmgMin ?? 8) + Math.floor(prng(seed, day, `enter_cre_dmg_${area.id}_${target.id}`) * ((creature.dmgMax ?? 18) - (creature.dmgMin ?? 8) + 1));
  if(creature.modifierType === "damage_add") dmg += Number(creature.modifierValue) || 0;
  if(creature.modifierType === "damage_mul") dmg = Math.floor(dmg * (Number(creature.modifierValue) || 1));

  applyDamage(target, dmg);
  const creatureName = creature.modifier ? `${creature.modifier} ${creature.name}` : (creature.name || "Unknown Creature");
  const ev = { type:"CREATURE_ATTACK", areaId: area.id, target: target.id, creature: creatureName, dmg, onEnter:true };

  // Poison modifier
  if(creature.modifierType === "poison"){
    target.status = target.status || [];
    if(!(target.status || []).some(s => s?.type === "poison")){
      target.status.push({ type:"poison", perDay: 10, by:"creature" });
      events.push({ type:"POISON_APPLIED", who: target.id, by:"creature" });
      ev.poisonApplied = true;
    }
  }

  events.push(ev);

  if((target.hp ?? 0) <= 0){
    events.push({ type:"DEATH", who: target.id, areaId: target.areaId, reason:"creature" });
  }
}

export function endDay(world, npcIntents = [], dayEvents = []){
  // Ends the day, applies NPC movement + maintenance, logs events, advances day.
  const next = cloneWorld(world);
  const day = next.meta.day;
  const seed = next.meta.seed;
  const events = [...(dayEvents || [])];

  // Collect kill records accumulated during the day (e.g., from manual attacks).
  // Used for deterministic loot distribution.
  const killsThisDay = Array.isArray(next.flags?.killsThisDay) ? next.flags.killsThisDay : [];

  // Track positions to report who moved into the player's area when the day ends.
  const playerArea = next.entities.player.areaId;
  const prevNpcAreas = {};
  for(const npc of Object.values(next.entities.npcs || {})){
    prevNpcAreas[npc.id] = npc.areaId;
  }

  // Snapshot starting positions for deterministic action resolution (collect disputes).
  const startAreas = { player: next.entities.player.areaId };
  for(const npc of Object.values(next.entities.npcs || {})) startAreas[npc.id] = npc.areaId;

  // --- 6.1 Ground items: resolve COLLECT disputes (before moves) ---
  const collectReqs = [];
  // Player collects resolve immediately on click.
  // NPC collect intents
  for(const act of (npcIntents || [])){
    if(act?.type === "COLLECT" && act?.source){
      const idx = Number(act.payload?.itemIndex ?? 0);
      collectReqs.push({ who: act.source, areaId: startAreas[act.source], itemIndex: idx });
    }
  }

  resolveCollectContests(next, collectReqs, events, { seed, day, killsThisDay, startAreas });


  // NPC movement intents (ignore combat declarations for now)
  for(const act of (npcIntents || [])){
    if(!act || !act.source) continue;
    if(act.type === "MOVE"){
      const route = Array.isArray(act.payload?.route) ? act.payload.route : [];
      const to = (route.length ? route[route.length-1] : act.payload?.toAreaId);
      if(to != null){
        const res = moveActorOneStep(next, act.source, to);
        events.push(...res.events);
      }
    } else if(act.type === "STAY"){
      events.push({ type:"STAY", who: act.source });
    }
  }

  // After NPC moves, report anyone who moved into the player's area.
  for(const npc of Object.values(next.entities.npcs || {})){
    if((npc.hp ?? 0) <= 0) continue;
    const from = prevNpcAreas[npc.id];
    const to = npc.areaId;
    if(from !== to && to === playerArea){
      events.push({ type:"ARRIVAL", who: npc.id, from, to });
    }
  }

  // Ongoing status effects (poison)
  for(const e of [next.entities.player, ...Object.values(next.entities.npcs || {})]){
    if((e.hp ?? 0) <= 0) continue;
    const poison = (e.status || []).find(s => s?.type === "poison");
    if(poison){
      const dmg = Number(poison.perDay) || 10;
      applyDamage(e, dmg);
      events.push({ type:"POISON_TICK", who: e.id, dmg });
      if((e.hp ?? 0) <= 0) events.push({ type:"DEATH", who: e.id, areaId: e.areaId });
    }
  }



// --- Starvation rule (7.1) ---
// If an actor started this day at 0 FP (mustFeed=true) and ends the day without gaining FP, they die.
for(const e of [next.entities.player, ...Object.values(next.entities.npcs || {})]){
  if((e.hp ?? 0) <= 0) continue;
  const mustFeed = !!e._today?.mustFeed && (e._today?.day === day);
  if(mustFeed && (Number(e.fp ?? 0) <= 0)){
    e.hp = 0;
    events.push({ type:"DEATH", who: e.id, areaId: e.areaId, reason:"starvation" });
  }
}

  // Apply traps (Net / Mine) now that the new day has begun.
  // Traps only activate starting the day after they were set.
  applyTrapsAtStartOfDay(next, events, { day: next.meta.day });

  // Daily threats: only threatening areas roll when they contain players.
  applyDailyThreats(next, events, { seed: seed, day: next.meta.day });


  // --- 6.2 Spoils after a kill ---
  // Loot is distributed among participants (who dealt damage / were in the dispute)
  // ordered by Dexterity (tie-breaker: initiative).
  distributeSpoils(next, killsThisDay, events, { seed, day });
  // Clear for next day
  next.flags = next.flags || {};
  next.flags.killsThisDay = [];

  // --- 7.1 FP maintenance ---
  //  - Start: 70
  //  - -10 per day
  //  - If the area has food, eating is automatic and restores to 70
  //  - If someone starts a day at 0 FP and doesn't eat that day, they die
  for(const e of [next.entities.player, ...Object.values(next.entities.npcs || {})]){
    if((e.hp ?? 0) <= 0) continue;
        e.fp = Math.max(0, Number(e.fp ?? 70) - 10);
  }

  // Advance to the next day first, then apply area closures/scheduling so that
  // the map state the player sees on the new day already contains:
  // - areas that disappeared today (isActive=false)
  // - areas that will disappear tomorrow (willCloseOnDay=newDay+1)
  // This timing is important for the "red border one day before" UI.
  next.meta.day += 1;
  applyClosuresForDay(next, next.meta.day);

  // Decrement Net trap imprisonment counters as the new day begins.
  for(const e of [next.entities.player, ...Object.values(next.entities.npcs || {})]){
    if((e.hp ?? 0) <= 0) continue;
    if((e.trappedDays ?? 0) > 0){
      e.trappedDays = Math.max(0, Number(e.trappedDays) - 1);
      if(e.trappedDays === 0) events.push({ type:"NET_RELEASE", who: e.id, areaId: e.areaId });
    }
  }


// At the start of the new day:
// - reset per-day flags
// - auto-eat in areas with food (restores FP to 70)
// - if FP is 0 and there is no food, mark "mustFeed" for this day (death checked at endDay)
for(const e of [next.entities.player, ...Object.values(next.entities.npcs || {})]){
  if((e.hp ?? 0) <= 0) continue;

  e._today = e._today || {};
  e._today.day = next.meta.day;
  e._today.fed = false;
  e._today.mustFeed = false;
  e._today.defendedWithShield = false;
  e._today.invisible = false;

  const a = next.map.areasById[String(e.areaId)];
  const hasFood = !!a?.hasFood;

  if(hasFood){
    if((Number(e.fp ?? 0)) < 70) events.push({ type:"EAT", who: e.id, areaId: e.areaId });
    e.fp = 70;
    e._today.fed = true;
  } else {
    if(Number(e.fp ?? 0) <= 0){
      // They must gain FP sometime during this day (drink/eat/consumable) or they'll die at day end.
      e._today.mustFeed = true;
      events.push({ type:"STARVING", who: e.id, areaId: e.areaId });
    }
  }
}


  // If the player's current area is closed after day advancement, the player dies.
  // This ensures "standing on a vanished area" is treated as an instant death.
  const playerNow = next.entities.player;
  const playerAreaNow = next.map.areasById[String(playerNow.areaId)];
  if(playerAreaNow && playerAreaNow.isActive === false && (playerNow.hp ?? 0) > 0){
    playerNow.hp = 0;
    events.push({ type:"DEATH", who:"player", areaId: playerNow.areaId, reason:"area_closed" });
  }

  next.log.days.push({ day, events });

  return next;
}

function resolveCollectContests(world, collectReqs, events, { seed, day, killsThisDay, startAreas }){
  if(!collectReqs.length) return;

  // Group requests by area then itemIndex. We resolve itemIndex ascending to keep deterministic.
  const byArea = new Map();
  for(const r of collectReqs){
    if(r == null) continue;
    const key = String(r.areaId);
    if(!byArea.has(key)) byArea.set(key, []);
    byArea.get(key).push(r);
  }

  for(const [areaKey, reqs] of byArea.entries()){
    const area = world.map.areasById[areaKey];
    if(!area || !Array.isArray(area.groundItems) || area.groundItems.length === 0) continue;

    const byIndex = new Map();
    for(const r of reqs){
      const idx = Number(r.itemIndex ?? 0);
      if(!byIndex.has(idx)) byIndex.set(idx, []);
      byIndex.get(idx).push(r);
    }

    const indices = Array.from(byIndex.keys()).sort((a,b)=>a-b);
    for(const idx of indices){
      const item = area.groundItems[idx];
      if(!item) continue;

      const contenders = byIndex.get(idx)
        .map(r => ({ who: r.who, actor: actorById(world, r.who) }))
        .filter(x => x.actor && (x.actor.hp ?? 0) > 0 && (startAreas?.[x.who] ?? x.actor.areaId) === area.id);

      if(contenders.length === 0) continue;

      // Dexterity contest (higher D wins). Tie for best D => weapon fight.
      const scored = contenders.map(c => ({
        ...c,
        D: c.actor.attrs?.D ?? 0,
        init: initiativeScore(seed, day, c.who)
      }));
      scored.sort((a,b)=>b.D-a.D || b.init-a.init);

      const bestD = scored[0].D;
      const best = scored.filter(s => s.D === bestD);

      let winner = null;
      if(best.length === 1){
        winner = best[0];
        events.push({ type:"GROUND_CONTEST", areaId: area.id, itemDefId: item.defId, outcome:"dex_win", winner: winner.who });
      } else {
        // Fight among tied best dex.
        const fight = resolveTieFight(world, best.map(b => b.who), area.id, { seed, day, killsThisDay, itemDefId: item.defId, startAreas });
        winner = fight.winner ? { who: fight.winner, actor: actorById(world, fight.winner) } : null;
        events.push({ type:"GROUND_CONTEST", areaId: area.id, itemDefId: item.defId, outcome:"tie_fight", tied: best.map(b=>b.who), winner: winner?.who ?? null });
      }

      if(!winner || !winner.actor || (winner.actor.hp ?? 0) <= 0) {
        // Nobody alive at the end; item stays.
        continue;
      }

      // Attempt to pick up.
      if(inventoryCount(winner.actor.inventory) >= INVENTORY_LIMIT){
        events.push({ type:"COLLECT", ok:false, who: winner.who, reason:"inventory_full", itemDefId: item.defId, areaId: area.id });
        continue;
      }

      // Remove from ground and add to inventory.
      const removed = area.groundItems.splice(idx, 1)[0];

      // Auto-consume resources on collect (finite).
      const consumed = applyOnCollect(world, winner.actor, area, removed, events);
      if(consumed.consumed){
        events.push({ type:"COLLECT", ok:true, who: winner.who, itemDefId: removed.defId, qty: removed.qty || 1, areaId: area.id, note:"consumed_on_collect" });
        continue;
      }
      const ok = addToInventory(winner.actor.inventory, removed);
      if(!ok.ok){
        // Put it back at the front if we couldn't add (shouldn't happen if count check passed).
        area.groundItems.unshift(removed);
        events.push({ type:"COLLECT", ok:false, who: winner.who, reason: ok.reason || "failed", itemDefId: removed.defId, areaId: area.id });
      } else {
        events.push({ type:"COLLECT", ok:true, who: winner.who, itemDefId: removed.defId, qty: removed.qty || 1, areaId: area.id });
      }
    }
  }
}

function resolveTieFight(world, whoIds, areaId, { seed, day, killsThisDay, itemDefId, startAreas }){
  // Free-for-all among whoIds, deterministic order by initiative. Continues until 1 remains.
  const alive = new Set(whoIds.filter(id => {
    const a = actorById(world, id);
    const at = startAreas?.[id] ?? a?.areaId;
    return a && (a.hp ?? 0) > 0 && at === areaId;
  }));
  const order = Array.from(alive).sort((a,b)=>initiativeScore(seed, day, b) - initiativeScore(seed, day, a));
  if(order.length <= 1) return { winner: order[0] || null };

  const maxRounds = 12; // small cap for safety
  const participants = Array.from(alive);
  for(let round=0; round<maxRounds && alive.size > 1; round++){
    for(const attackerId of order){
      if(alive.size <= 1) break;
      if(!alive.has(attackerId)) continue;
      const attacker = actorById(world, attackerId);
      const attackerArea = startAreas?.[attackerId] ?? attacker?.areaId;
      if(!attacker || (attacker.hp ?? 0) <= 0 || attackerArea !== areaId){
        alive.delete(attackerId);
        continue;
      }

      const targets = Array.from(alive).filter(id => id !== attackerId);
      if(targets.length === 0) break;
      // Target: lowest initiative among remaining (so order has meaning)
      targets.sort((a,b)=>initiativeScore(seed, day, a) - initiativeScore(seed, day, b));
      const targetId = targets[0];
      const target = actorById(world, targetId);
      if(!target || (target.hp ?? 0) <= 0){
        alive.delete(targetId);
        continue;
      }

      const bestW = strongestWeaponInInventory(attacker.inventory, { forDispute: true });
      const dmg = bestW ? bestW.dmg : (5 + Math.floor(prng(seed, day, `dispute_bonus_${attackerId}_${round}`) * 4));
      applyDamage(target, dmg);
      // No shield/defense during dispute fights.
      // Record damage event (compact)
      // Note: we do not consume weapon uses in disputes for now.
      
      if((target.hp ?? 0) <= 0){
        alive.delete(targetId);
        // Record kill participants for spoils
        killsThisDay.push({ deadId: targetId, areaId, participants, reason: "item_dispute", itemDefId });
      }
    }
  }

  const winner = Array.from(alive)[0] || null;
  return { winner };
}

function distributeSpoils(world, kills, events, { seed, day }){
  for(const k of (kills || [])){
    const dead = actorById(world, k.deadId);
    if(!dead) continue;
    const area = world.map.areasById[String(k.areaId)];
    if(!area) continue;

    const participants = (k.participants || [])
      .map(id => ({ id, actor: actorById(world, id) }))
      .filter(x => x.actor && (x.actor.hp ?? 0) > 0 && x.actor.areaId === k.areaId);

    if(participants.length === 0) continue;
    if(!dead.inventory || !(dead.inventory.items || []).length) continue;

    // Sort by Dexterity desc, tie by initiative desc.
    participants.sort((a,b)=>{
      const dA = a.actor.attrs?.D ?? 0;
      const dB = b.actor.attrs?.D ?? 0;
      if(dB !== dA) return dB - dA;
      return initiativeScore(seed, day, b.id) - initiativeScore(seed, day, a.id);
    });

    const loot = [...(dead.inventory.items || [])];
    dead.inventory.items = [];
    dead.inventory.equipped = { weaponDefId: null, defenseDefId: null };

    let i = 0;
    while(loot.length){
      const picker = participants[i % participants.length];
      i += 1;
      if(inventoryCount(picker.actor.inventory) >= INVENTORY_LIMIT){
        // Can't take more; skip.
        // If everyone is full, break.
        const allFull = participants.every(p => inventoryCount(p.actor.inventory) >= INVENTORY_LIMIT);
        if(allFull) break;
        continue;
      }
      const nextItem = loot.shift();
      const ok = addToInventory(picker.actor.inventory, nextItem);
      if(ok.ok){
        events.push({ type:"SPOILS_PICK", who: picker.id, from: k.deadId, itemDefId: nextItem.defId, qty: nextItem.qty || 1, areaId: k.areaId });
      } else {
        // drop to ground
        area.groundItems = Array.isArray(area.groundItems) ? area.groundItems : [];
        area.groundItems.push(nextItem);
        events.push({ type:"SPOILS_DROP", from: k.deadId, itemDefId: nextItem.defId, qty: nextItem.qty || 1, areaId: k.areaId });
      }
    }

    // Remaining loot drops to ground.
    if(loot.length){
      area.groundItems = Array.isArray(area.groundItems) ? area.groundItems : [];
      for(const it of loot){
        area.groundItems.push(it);
        events.push({ type:"SPOILS_DROP", from: k.deadId, itemDefId: it.defId, qty: it.qty || 1, areaId: k.areaId });
      }
    }
  }
}

function applyClosuresForDay(world, day){
  // Close anything scheduled for today
  for(const idStr of Object.keys(world.map.areasById || {})){
    const a = world.map.areasById[idStr];
    if(a?.isActive !== false && a?.willCloseOnDay === day){
      a.isActive = false;
      world.flags.closedAreas = Array.from(new Set([...(world.flags.closedAreas||[]), a.id])).sort((x,y)=>x-y);
    }
  }

  // Starting day 3, every 2 days: mark 4 highest-id active areas (excluding 1) to close next day.
  if(day >= 3 && ((day - 3) % 2 === 0)){
    const active = Object.values(world.map.areasById || {})
      .filter(a => a && a.id !== 1 && a.isActive !== false);

    active.sort((a,b)=>b.id-a.id);
    const toMark = active.slice(0, 4);
    for(const a of toMark){
      if(a.willCloseOnDay == null){
        a.willCloseOnDay = day + 1;
      }
    }
  }
}
