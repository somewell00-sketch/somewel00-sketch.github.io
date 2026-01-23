import { getItemDef, ItemTypes, strongestWeaponInInventory, inventoryCount, INVENTORY_LIMIT } from "./items.js";

// NPC AI (incremental, score-based):
// - builds a limited ObservedWorld per NPC
// - chooses 1 posture intent (ATTACK/DEFEND/NOTHING/DRINK/COLLECT/SET_TRAP)
// - chooses 1 movement intent (MOVE/STAY)
// Deterministic: all tiebreaks use hash(seed, day, actorId, salt).

export function generateNpcIntents(world){
  const intents = [];
  const day = Number(world?.meta?.day ?? 1);
  const seed = Number(world?.meta?.seed ?? 1);
  const playerDistrict = world?.entities?.player?.district ?? null;

  const npcs = Object.values(world?.entities?.npcs || {});

  for(const npc of npcs){
    if(!npc || (npc.hp ?? 0) <= 0) continue;

    npc.memory = npc.memory || {};
    npc.memory.visited = npc.memory.visited || [];
    npc.memory.lastAreas = npc.memory.lastAreas || [];
    npc.memory.traits = npc.memory.traits || makeTraits(seed, npc.id, npc.district);

    const traits = npc.memory.traits;
    const obs = buildObservedWorld(world, npc);

    // --- Posture/action intent ---
    const actionIntent = decidePosture(world, npc, obs, traits, { seed, day, playerDistrict });
    if(actionIntent) intents.push(actionIntent);

    // --- Movement intent ---
    const moveIntent = decideMove(world, npc, obs, traits, { seed, day });
    if(moveIntent) intents.push(moveIntent);
  }

  return intents;
}

function buildObservedWorld(world, npc){
  const area = world.map?.areasById?.[String(npc.areaId)] || null;
  const hereActors = [];
  // Player
  const p = world?.entities?.player;
  if(p && (p.hp ?? 0) > 0 && p.areaId === npc.areaId){
    // Camouflage: invisible actors are not seen.
    if(!(p._today?.invisible)) hereActors.push({ id: p.id, kind: "player", entity: p });
  }
  for(const other of Object.values(world.entities.npcs || {})){
    if(!other || (other.hp ?? 0) <= 0) continue;
    if(other.id === npc.id) continue;
    if(other.areaId !== npc.areaId) continue;
    if(other._today?.invisible) continue;
    hereActors.push({ id: other.id, kind: "npc", entity: other });
  }

  const adj = Array.isArray(world.map?.adjById?.[String(npc.areaId)])
    ? world.map.adjById[String(npc.areaId)].map(Number)
    : [];

  // Observed: current area always. Adjacent area info is only partial and treated as "unknown" unless visited.
  const visitedSet = new Set(Array.isArray(npc.memory?.visited) ? npc.memory.visited : []);
  const adjacent = adj.map(id => {
    const a = world.map.areasById[String(id)];
    if(!a) return { id, known: false };
    const known = visitedSet.has(id);
    return {
      id,
      known,
      biome: known ? a.biome : null,
      threatClass: known ? a.threatClass : null,
      willCloseOnDay: known ? a.willCloseOnDay : null,
      isActive: a.isActive !== false,
      hasFood: known ? !!a.hasFood : null,
      hasWater: known ? !!a.hasWater : null,
      groundCount: known ? (Array.isArray(a.groundItems) ? a.groundItems.length : 0) : null,
      creatures: known ? ((a.activeElements || []).filter(e => e?.kind === "creature").length) : null
    };
  });

  return { area, hereActors, adjacent };
}

function decidePosture(world, npc, obs, traits, { seed, day, playerDistrict }){
  if((npc.trappedDays ?? 0) > 0) return { source: npc.id, type: "NOTHING", payload: { reason: "trapped" } };

  const area = obs.area;
  const invN = inventoryCount(npc.inventory);
  const hasWater = !!area?.hasWater;
  const ground = Array.isArray(area?.groundItems) ? area.groundItems : [];

  // Hunger/FP: if low and water exists, prefer drinking.
  if((npc.fp ?? 0) <= 15 && hasWater){
    return { source: npc.id, type: "DRINK", payload: {} };
  }

  // Collect: greed-based; pick the highest-value visible ground item.
  if(ground.length && invN < INVENTORY_LIMIT){
    const r = hash01(seed, day, `npc_collect_bias|${npc.id}`);
    if(r < (0.10 + traits.greed * 0.35)){
      let bestIdx = 0;
      let bestScore = -1e9;
      for(let i=0;i<ground.length;i++){
        const inst = ground[i];
        const def = getItemDef(inst?.defId);
        const score = itemValue(def, inst);
        if(score > bestScore){ bestScore = score; bestIdx = i; }
      }
      return { source: npc.id, type: "COLLECT", payload: { itemIndex: bestIdx } };
    }
  }

  // Attack/Defend/Nothing: evaluate targets in the same area.
  const targets = obs.hereActors
    .map(x => x.entity)
    .filter(t => t && (t.hp ?? 0) > 0 && t.areaId === npc.areaId);

  let bestAttack = null;
  let bestAttackScore = -1e9;

  for(const t of targets){
    // District bias: less likely to attack same district and less likely to attack player's district.
    const sameDistrict = (t.district != null && npc.district != null && t.district === npc.district);
    const playerDistrictBias = (playerDistrict != null && t.district != null && t.district === playerDistrict);

    const killChance = estimateKillChance(world, npc, t, { seed, day });
    const risk = estimateRisk(world, npc, t);

    let score = killChance * (0.9 + traits.aggression) - risk * (0.6 + traits.caution);
    if(sameDistrict) score -= 0.55;
    if(playerDistrictBias) score -= 0.20;
    // Prefer weaker-looking targets.
    score += clamp01((100 - (t.hp ?? 100)) / 100) * 0.35;

    if(score > bestAttackScore){
      bestAttackScore = score;
      bestAttack = t;
    }
  }

  const defendScore = 0.35 + traits.caution * 0.45 + fearFactor(npc) * 0.6;
  const nothingScore = 0.15;

  // If they have no visible targets, bias to defend.
  if(!targets.length){
    return (defendScore >= nothingScore)
      ? { source: npc.id, type: "DEFEND", payload: {} }
      : { source: npc.id, type: "NOTHING", payload: {} };
  }

  if(bestAttack && bestAttackScore > defendScore && bestAttackScore > nothingScore){
    return { source: npc.id, type: "ATTACK", payload: { targetId: bestAttack.id } };
  }

  return (defendScore >= nothingScore)
    ? { source: npc.id, type: "DEFEND", payload: {} }
    : { source: npc.id, type: "NOTHING", payload: {} };
}

function decideMove(world, npc, obs, traits, { seed, day }){
  if((npc.trappedDays ?? 0) > 0) return { source: npc.id, type: "STAY", payload: { reason: "trapped" } };

  const max = maxStepsForNpc(npc);
  if(max <= 0) return { source: npc.id, type: "STAY", payload: {} };

  const visitedSet = new Set(Array.isArray(npc.memory?.visited) ? npc.memory.visited : []);

  // BFS up to 3 steps, but we score only known areas well. Unknown areas get conservative estimates.
  const start = Number(npc.areaId);
  const q = [{ id: start, steps: 0, route: [] }];
  const seen = new Set([start]);
  const candidates = [];

  while(q.length){
    const cur = q.shift();
    if(cur.steps > 0) candidates.push(cur);
    if(cur.steps >= max) continue;
    const adj = world.map?.adjById?.[String(cur.id)] || [];
    for(const nxt of adj){
      const nid = Number(nxt);
      if(seen.has(nid)) continue;
      seen.add(nid);
      const a = world.map?.areasById?.[String(nid)];
      if(!a || a.isActive === false) continue;
      // Avoid areas that will vanish tomorrow.
      const willCloseTomorrow = (a.willCloseOnDay != null) && (Number(a.willCloseOnDay) === day + 1);
      if(willCloseTomorrow) continue;
      q.push({ id: nid, steps: cur.steps + 1, route: [...cur.route, nid] });
    }
  }

  // Decide stay vs move based on "comfort".
  const stayScore = scoreArea(world, npc, start, 0, traits, visitedSet, { seed, day });

  let best = null;
  let bestScore = stayScore;
  for(const c of candidates){
    const s = scoreArea(world, npc, c.id, c.steps, traits, visitedSet, { seed, day });
    if(s > bestScore){ bestScore = s; best = c; }
  }

  // Small inertia: don't move unless the best is meaningfully better.
  if(!best || (bestScore - stayScore) < 0.18){
    return { source: npc.id, type: "STAY", payload: {} };
  }
  return { source: npc.id, type: "MOVE", payload: { route: best.route } };
}

function scoreArea(world, npc, areaId, steps, traits, visitedSet, { seed, day }){
  const a = world.map?.areasById?.[String(areaId)];
  if(!a) return -1e9;
  if(a.isActive === false) return -1e9;

  // Hard avoid areas that will vanish tomorrow.
  if(a.willCloseOnDay != null && Number(a.willCloseOnDay) === day + 1) return -999;

  const known = visitedSet.has(Number(areaId));
  const groundCount = Array.isArray(a.groundItems) ? a.groundItems.length : 0;
  const creatures = (a.activeElements || []).filter(e => e?.kind === "creature").length;

  const lootValue = known ? (groundCount * 0.35) : 0.08;
  const foodValue = (a.hasFood ? 0.45 : 0) + (a.hasWater ? 0.18 : 0);

  // Crowd pressure: NPCs dislike staying packed together (especially in the Cornucopia).
  let crowd = 0;
  const p = world?.entities?.player;
  if(p && (p.hp ?? 0) > 0 && Number(p.areaId) === Number(areaId) && !(p._today?.invisible)) crowd++;
  for(const other of Object.values(world?.entities?.npcs || {})){
    if(!other || (other.hp ?? 0) <= 0) continue;
    if(Number(other.areaId) !== Number(areaId)) continue;
    if(other._today?.invisible) continue;
    crowd++;
  }
  const crowdPenalty = Math.max(0, (crowd - 1)) * (0.04 + traits.caution * 0.03) + ((Number(areaId) === 1 && day >= 2) ? 0.10 : 0);

  const needFood = clamp01((25 - (npc.fp ?? 0)) / 25);
  const safety = (a.threatClass === "safe" ? 0.45 : (a.threatClass === "neutral" ? 0.2 : -0.25));
  const threat = (a.threatClass === "threatening" ? 0.35 : 0.05) + (creatures * 0.25);
  const revisitPenalty = (Number(areaId) === Number(npc.areaId)) ? 0 : (known ? 0.02 : 0.06);

  const distanceCost = steps * 0.12;

  const score =
    lootValue * (0.4 + traits.greed) +
    foodValue * (0.35 + needFood) +
    safety * (0.25 + traits.caution) -
    threat * (0.25 + traits.caution) -
    distanceCost -
    revisitPenalty -
    crowdPenalty;

  // tiny deterministic jitter to break ties.
  return score + (hash01(seed, day, `area_jitter|${npc.id}|${areaId}`) * 0.01);
}

function estimateKillChance(world, attacker, target, { seed, day }){
  // Simple proxy: weapon damage + attributes + target condition.
  const w = strongestWeaponInInventory(attacker.inventory);
  let dmg = 5;
  if(w?.def){
    const qty = w.inst?.qty || 1;
    // For kill chance estimation, treat stackable as full stack.
    dmg = (w.def.stackable ? (w.def.damage * qty) : w.def.damage);
  }
  // Shield reduces chance.
  const shielded = !!target?._today?.defendedWithShield;
  if(shielded) dmg *= 0.55;

  const hpFactor = clamp01((100 - (target.hp ?? 100)) / 100);
  const strEdge = clamp01(((attacker.attrs?.F ?? 0) - (target.attrs?.F ?? 0) + 7) / 14);
  const dexEdge = clamp01(((attacker.attrs?.D ?? 0) - (target.attrs?.D ?? 0) + 7) / 14);

  // Convert to 0..1 "kill chance" feel.
  const raw = (dmg / 105) * 0.65 + hpFactor * 0.35;
  return clamp01(raw * (0.75 + 0.25 * strEdge) * (0.85 + 0.15 * dexEdge));
}

function estimateRisk(world, attacker, target){
  // Risk proxy: number of other actors in area, low HP/FP.
  let count = 0;
  const areaId = attacker.areaId;
  const p = world?.entities?.player;
  if(p && (p.hp ?? 0) > 0 && p.areaId === areaId && !(p._today?.invisible)) count++;
  for(const n of Object.values(world?.entities?.npcs || {})){
    if(!n || (n.hp ?? 0) <= 0) continue;
    if(n.areaId !== areaId) continue;
    if(n.id === attacker.id) continue;
    if(n._today?.invisible) continue;
    count++;
  }
  const crowd = clamp01(count / 5);
  const hpRisk = clamp01((40 - (attacker.hp ?? 100)) / 40);
  const fpRisk = clamp01((20 - (attacker.fp ?? 70)) / 20);
  return clamp01(crowd * 0.55 + hpRisk * 0.35 + fpRisk * 0.25);
}

function fearFactor(npc){
  const hp = npc.hp ?? 100;
  const fp = npc.fp ?? 70;
  const lowHp = clamp01((35 - hp) / 35);
  const lowFp = clamp01((15 - fp) / 15);
  return clamp01(lowHp * 0.9 + lowFp * 0.6);
}

function itemValue(def, inst){
  if(!def) return 0.05;
  if(def.type === ItemTypes.PROTECTION) return 0.9;
  if(def.type === ItemTypes.CONSUMABLE) return 0.7;
  if(def.type === ItemTypes.WEAPON){
    let base = (def.damage ?? 0) / 100;
    if(def.stackable) base *= 0.8;
    if(def.effects?.appliesPoison) base += 0.25;
    if(def.effects?.breaksShield) base += 0.15;
    if(def.uses != null) base *= 0.8;
    return base;
  }
  return 0.15;
}

function maxStepsForNpc(npc){
  const hp = npc.hp ?? 100;
  const fp = npc.fp ?? 70;
  return (hp > 30 && fp > 20) ? 3 : 1;
}

function makeTraits(seed, id, district){
  // Stable per NPC. Values are 0..1.
  const a = hash01(seed, 0, `trait_aggr|${id}|${district}`);
  const g = hash01(seed, 0, `trait_greed|${id}|${district}`);
  const c = hash01(seed, 0, `trait_caut|${id}|${district}`);
  return {
    aggression: 0.25 + a * 0.75,
    greed: 0.15 + g * 0.85,
    caution: 0.20 + c * 0.80
  };
}

function hash01(seed, day, salt){
  let h = 2166136261 >>> 0;
  const s = String(seed) + "|" + String(day) + "|" + String(salt);
  for(let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h << 13; h >>>= 0;
  h ^= h >>> 17; h >>>= 0;
  h ^= h << 5; h >>>= 0;
  return (h >>> 0) / 4294967296;
}

function clamp01(x){
  if(x <= 0) return 0;
  if(x >= 1) return 1;
  return x;
}
