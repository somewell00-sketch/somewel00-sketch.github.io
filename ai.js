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
    // Per-day flags (reset each day)
    npc.memory._plannedCornCollect = false;
    npc.memory._wantsFlee = false;

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
    const wantsFlee = !!npc?.memory?._wantsFlee;
  const hpP = hpPercent(npc);
  const offensive = hasDamageItem(npc.inventory);
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

function hpPercent(entity){
  const hp = Number(entity?.hp ?? 0);
  const max = 100;
  return max > 0 ? (hp / max) : 0;
}

function hasDamageItem(inv){
  const items = inv?.items || [];
  for(const it of items){
    if(!it) continue;
    const def = getItemDef(it.defId);
    const dmg = Number(def?.damage ?? 0);
    if(dmg > 0 && (def?.type === ItemTypes.WEAPON || def?.type === ItemTypes.TRAP)) return true;
  }
  return false;
}

function decidePosture(world, npc, obs, traits, { seed, day, playerDistrict }){
  if((npc.trappedDays ?? 0) > 0) return { source: npc.id, type: "NOTHING", payload: { reason: "trapped" } };

  const area = obs.area;
  const invN = inventoryCount(npc.inventory);
  const hasWater = !!area?.hasWater;
  const ground = Array.isArray(area?.groundItems) ? area.groundItems : [];

  // FORCE_COLLECT_CORN: Cornucopia scramble.
  // Cornucopia starts with lots of finite loot. If an NPC still has space,
  // it should keep trying to collect there (especially early), otherwise
  // the ground ends up cluttered with untouched items.
  const inCorn = Number(area?.id) === 1;
  if(inCorn && ground.length && invN < INVENTORY_LIMIT){
    // Strong push to collect on day 1–3.
    const baseChance = (day <= 3) ? 0.92 : 0.55;
    // If they have 0–1 items, they are still gearing up.
    // Empty-handed tributes are extra motivated to grab *something* (especially a weapon).
    const invBoost = (invN === 0) ? 0.55 : (invN === 1 ? 0.25 : 0);
    const rForce = hash01(seed, day, `corn_collect|${npc.id}|${invN}|${ground.length}`);
    if(rForce < Math.min(0.98, baseChance + invBoost)){
    const scoredItems = [];
    for(let i=0;i<ground.length;i++){
      const inst = ground[i];
      const def = getItemDef(inst?.defId);
      const dmg = Number(def?.damage ?? 0);
      // Cornucopia: empty-handed NPCs strongly prefer damage-capable items first.
      const firstWeaponBoost = (invN === 0 && dmg > 0) ? 25 : 0;
      scoredItems.push({ idx: i, score: itemValue(def, inst) + firstWeaponBoost });
    }
    scoredItems.sort((a,b)=>b.score-a.score);
    const topK = scoredItems.slice(0, Math.min(4, scoredItems.length));
    const r = hash01(seed, day, `collect_pick|${npc.id}|corn`);
    const pickPos = Math.floor(r * topK.length);
    const chosen = topK[Math.max(0, Math.min(topK.length - 1, pickPos))];
    // Mark that this NPC is grabbing something from the Cornucopia today.
    // Movement logic uses this to force immediate dispersal.
    npc.memory = npc.memory || {};
    npc.memory._plannedCornCollect = true;
    // Reset empty-handed attempt counter once they commit to grabbing something.
    npc.memory.cornEmptyTries = 0;
    return { source: npc.id, type: "COLLECT", payload: { itemIndex: chosen.idx } };
    }
  }

  // Hunger/FP: if low and water exists, prefer drinking.
  if((npc.fp ?? 0) <= 15 && hasWater){
    return { source: npc.id, type: "DRINK", payload: {} };
  }

  // Very low FP: cannot attack (only DEFEND / DRINK / NOTHING / COLLECT).
  if((npc.fp ?? 0) < 10){
    if(hasWater && (npc.fp ?? 0) <= 25) return { source: npc.id, type: "DRINK", payload: {} };
    return { source: npc.id, type: "DEFEND", payload: {} };
  }

  
  // Low FP: prioritize food. If there is an FP-restoring consumable on the ground, try to collect it.
  if((npc.fp ?? 0) <= 20 && ground.length && invN < INVENTORY_LIMIT){
    let bestIdx = -1;
    let bestGain = -1;
    for(let i=0;i<ground.length;i++){
      const inst = ground[i];
      const def = getItemDef(inst?.defId);
      const gain = Number(def?.effects?.healFP ?? 0);
      if(gain > bestGain){
        bestGain = gain;
        bestIdx = i;
      }
    }
    if(bestGain > 0 && bestIdx >= 0){
      return { source: npc.id, type: "COLLECT", payload: { itemIndex: bestIdx } };
    }
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


  // Injured NPCs avoid combat (System 3)
  if(hpPercent(npc) < 0.30){
    npc.memory = npc.memory || {};
    npc.memory._wantsFlee = true;
    return { source: npc.id, type: "DEFEND", payload: {} };
  }

  // Attack/Defend/Nothing: evaluate targets in the same area.
  const targets = obs.hereActors
    .map(x => x.entity)
    .filter(t => t && (t.hp ?? 0) > 0 && t.areaId === npc.areaId);

  
  // If the NPC has a strong weapon (>= 30 damage), prioritize attacking someone in the same area.
  // This is a hard bias (not absolute) and still respects camouflage and district bias.
  const strongW = strongestWeaponInInventory(npc.inventory) ;
  const hasStrongWeapon = (strongW && (strongW.dmg ?? 0) >= 30);

let bestAttack = null;
  let bestAttackScore = -1e9;

  for(const t of targets){
    // District bias: less likely to attack same district and less likely to attack player's district.
    const sameDistrict = (t.district != null && npc.district != null && t.district === npc.district);
    const playerDistrictBias = (playerDistrict != null && t.district != null && t.district === playerDistrict);

    const killChance = estimateKillChance(world, npc, t, { seed, day });
    const risk = estimateRisk(world, npc, t);

    let score = killChance * (0.9 + traits.aggression) - risk * (0.6 + traits.caution);

    // Presence pressure: if someone is here, the situation tends to escalate.
    // This increases same-area fights without making low-HP NPCs suicidal.
    score += (hpPercent(npc) >= 0.70) ? 0.28 : 0.16;
    if(hasDamageItem(npc.inventory)) score += 0.10;

    // Aggressiveness by HP (System 3)
    const hpP = hpPercent(npc);
    if(hpP >= 0.70) score += 0.20;
    if(hpP < 0.30) score -= 0.65;

    if(hasStrongWeapon) score += 0.55;
    if(sameDistrict) score -= 0.55;
    if(playerDistrictBias) score -= 0.20;
    // Player interaction (System 3)
    if(t.id === "player"){
      const playerW = strongestWeaponInInventory(world?.entities?.player?.inventory);
      const playerDmg = Number(playerW?.dmg ?? 0);
      if(hpPercent(npc) >= 0.70) score += 0.15;
      if(hpPercent(npc) < 0.30 && playerDmg >= 30) score -= 0.55;
    }
    // Prefer weaker-looking targets.
    // Prefer weaker-looking targets (more if we're healthy).
    const weakFactor = clamp01((100 - (t.hp ?? 100)) / 100);
    score += weakFactor * (hpPercent(npc) >= 0.70 ? 0.55 : 0.35);

    if(score > bestAttackScore){
      bestAttackScore = score;
      bestAttack = t;
    }
  }

  let defendScore = 0.35 + traits.caution * 0.45 + fearFactor(npc) * 0.6;
  // If there is a live target right here, defending becomes less attractive compared to acting.
  // Healthy NPCs are more willing to take initiative.
  if(targets.length){
    const hpP = hpPercent(npc);
    if(hpP >= 0.70) defendScore -= 0.14;
    else defendScore -= 0.06;
  }
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

  
  const lowFp = (npc.fp ?? 0) <= 20;
  const currentArea = world.map?.areasById?.[String(npc.areaId)];
  const inCornucopia = Number(currentArea?.id) === 1;
  const invCountNow = inventoryCount(npc.inventory);
  const grabbedCornToday = !!npc?.memory?._plannedCornCollect;
  const wantsFlee = !!npc?.memory?._wantsFlee;

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
      // Movement constraints: skip impassable water areas.
      if(a.hasWater && !a.hasBridge) continue;
      // Avoid areas that will vanish tomorrow.
      const willCloseTomorrow = (a.willCloseOnDay != null) && (Number(a.willCloseOnDay) === day + 1);
      if(willCloseTomorrow) continue;
      q.push({ id: nid, steps: cur.steps + 1, route: [...cur.route, nid] });
    }
  }

  // Evaluate stay + destinations.
  const scored = [{ id: start, steps: 0, route: [], isStay: true } , ...candidates]
    .map(c => ({
      ...c,
      score: scoreArea(world, npc, c.id, c.steps, traits, visitedSet, { seed, day })
    }))
    .sort((a,b)=>b.score-a.score);

  const stayScore = scored.find(s => s.isStay)?.score ?? -1e9;
  const bestScore = scored[0]?.score ?? stayScore;


// Dispersal rule (Cornucopia + general):
// 0 items -> tends to stay and fight for loot
// 1 item  -> starts considering leaving
// 2+ items -> strongly prefers leaving
const invCount = invCountNow;
let stayBias = 0;
if(Number(start) === 1){
  // After grabbing *anything* from the Cornucopia, NPCs should disperse quickly.
  // This keeps Day 1 dynamic and prevents permanent Cornucopia camping.
  if(invCount === 0 && !grabbedCornToday) stayBias = +0.10;
  else if(invCount === 0 && grabbedCornToday) stayBias = -0.75;
  else if(invCount === 1) stayBias = -0.85;
  else stayBias = -1.05;
} else {
  if(invCount >= 2) stayBias = -0.12;
}
const adjustedStayScore = stayScore + stayBias;


  // Inertia: don't move unless it is noticeably better.
  // NOTE: We also add an explicit "leave empty areas" rule so NPCs don't freeze when there's
  // no loot to fight for.
  const here = world.map?.areasById?.[String(start)];
  const hereGround = Array.isArray(here?.groundItems) ? here.groundItems : [];
  const emptyHere = hereGround.length === 0;

  // If the current area is empty, strongly encourage moving.
  // Cornucopia: don't force early dispersal too fast or most loot will never be contested.
  // Start forcing dispersal only after getting at least 2 items, and only when the pile is small.
  const cornLootLow = (Number(start) === 1) && (hereGround.length <= 6);
  // FORCE DISPERSAL: if they grabbed an item today (or already have one) and are in area 1,
  // they should move out immediately (unless trapped).
  const forceLeaveCorn = (Number(start) === 1) && (grabbedCornToday || invCount >= 1);

  // Cornucopia rule: NPCs try to grab at least one item before fleeing.
  // Only ~20% will leave the Cornucopia empty-handed if loot is available.
  const cornHasLoot = (Number(start) === 1) && (hereGround.length > 0);
  const cornEmptyHanded = (Number(start) === 1) && (invCount === 0) && !grabbedCornToday;
  // Empty-handed exit is only allowed (20%) after at least 2 "tries".
  // A "try" = starting a day in the Cornucopia empty-handed while loot exists.
  npc.memory = npc.memory || {};
  if(cornHasLoot && cornEmptyHanded){
    npc.memory.cornEmptyTries = Number(npc.memory.cornEmptyTries ?? 0) + 1;
  } else if(Number(start) === 1 && (invCount > 0 || grabbedCornToday)){
    npc.memory.cornEmptyTries = 0;
  }
  const triesNow = Number(npc.memory.cornEmptyTries ?? 0);
  const cornLeaveEmptyRoll = hash01(seed, day, `corn_leave_empty|${npc.id}|${day}`);
  const allowLeaveEmpty = cornHasLoot && cornEmptyHanded && (triesNow >= 2) && (cornLeaveEmptyRoll < 0.20);
  // If we are empty-handed in the Cornucopia and loot exists, do not force movement
  // unless we rolled the 20% exception or we are explicitly fleeing.
  const cornBlocksForcedMove = cornHasLoot && cornEmptyHanded && !allowLeaveEmpty && !wantsFlee;
  // If we haven't reached the 2-try threshold yet, block movement outright (loot scramble).
  if(cornHasLoot && cornEmptyHanded && (triesNow < 2) && !wantsFlee){
    return { source: npc.id, type: "STAY", payload: { reason: "corn_try" } };
  }
  const forceMove = (!cornBlocksForcedMove) && (emptyHere || forceLeaveCorn || wantsFlee || (Number(start) === 1 && invCount >= 2 && cornLootLow));

  const moveThreshold = (0.14 + traits.caution * 0.10) + (invCount === 0 && Number(start) === 1 ? 0.06 : 0) - (invCount >= 2 ? 0.06 : 0);
  const canMove = forceMove || scored.some(s => !s.isStay && (s.score - adjustedStayScore) >= moveThreshold);
  if(!canMove) return { source: npc.id, type: "STAY", payload: {} };

  // Deterministic weighted choice among the top few candidates.
  // More cautious NPCs behave more deterministically (lower temperature).
  const temperature = 0.55 - traits.caution * 0.30; // 0.25..0.55
  // If we are forcing a Cornucopia exit, prefer a simple 1-step route (clean dispersal).
  const poolBase = scored.filter(s => !s.isStay);
  const pool1 = forceLeaveCorn ? poolBase.filter(s => s.steps === 1) : poolBase;
  const pool = (pool1.length ? pool1 : poolBase).slice(0, 6);
  const pickR = hash01(seed, day, `move_pick|${npc.id}`);
  const chosen = weightedPick(pool, pickR, temperature) || pool[0];

  return { source: npc.id, type: "MOVE", payload: { route: chosen.route } };
}

function scoreArea(world, npc, areaId, steps, traits, visitedSet, { seed, day }){
  const a = world.map?.areasById?.[String(areaId)];
  if(!a) return -1e9;
  if(a.isActive === false) return -1e9;
  // Hard avoid areas that are not enterable (e.g., water without bridge).
  if(a.hasWater && !a.hasBridge) return -1e9;
  // Can't enter water without a bridge.
  if(a.hasWater && !a.hasBridge) return -1e9;

  // Territory noise (System 4)
  // - Healthy NPCs are attracted to noise (more so if they can deal damage)
  // - NPCs without damage items tend to avoid noisy zones
  // - Injured NPCs avoid noise strongly
  const noise = a.noiseState || "quiet";
  const hpP = hpPercent(npc);
  const offensive = hasDamageItem(npc.inventory);

  let noiseBonus = 0;
  if(hpP < 0.30){
    noiseBonus = (noise === "noisy") ? -0.18 : (noise === "highly_noisy" ? -0.35 : +0.05);
  } else if(!offensive){
    noiseBonus = (noise === "noisy") ? -0.06 : (noise === "highly_noisy" ? -0.14 : 0);
  } else if(hpP >= 0.70){
    noiseBonus = (noise === "noisy") ? 0.18 : (noise === "highly_noisy" ? 0.32 : 0);
  } else {
    noiseBonus = (noise === "noisy") ? 0.10 : (noise === "highly_noisy" ? 0.20 : 0);
  }

  // Hard avoid areas that will vanish tomorrow.
  if(a.willCloseOnDay != null && Number(a.willCloseOnDay) === day + 1) return -999;

  const known = visitedSet.has(Number(areaId));
  const groundCount = Array.isArray(a.groundItems) ? a.groundItems.length : 0;
  const creatures = (a.activeElements || []).filter(e => e?.kind === "creature").length;

  const lootValue = known ? (groundCount * 0.35) : 0.10;
  const foodValue = (a.hasFood ? 0.45 : 0) + (a.hasWater ? 0.18 : 0);

  // Exploration bonus: unknown areas can be attractive, but only for less cautious NPCs.
  const explore = (!known && Number(areaId) !== Number(npc.areaId)) ? (0.18 + traits.greed * 0.18 - traits.caution * 0.12) : 0;

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
  let crowdPenalty = Math.max(0, (crowd - 1)) * (0.04 + traits.caution * 0.03) + ((Number(areaId) === 1 && day >= 2) ? 0.10 : 0);
  // Early Cornucopia: allow crowding so more NPCs contest loot.
  if(Number(areaId) === 1 && day === 1) crowdPenalty *= 0.2;

  // FP defaults to full if missing (older saves / initial generation).
  const fpNow = Number(npc.fp ?? 100);
  let needFood = clamp01((40 - fpNow) / 40);
  if(fpNow <= 20) needFood = Math.min(1, needFood + 0.35);
  const safety = (a.threatClass === "safe" ? 0.45 : (a.threatClass === "neutral" ? 0.2 : -0.25));
  const threat = (a.threatClass === "threatening" ? 0.35 : 0.05) + (creatures * 0.25);
  const revisitPenalty = (Number(areaId) === Number(npc.areaId)) ? 0 : (known ? 0.02 : 0.06);

  // Memory: discourage "train" movement where NPCs follow the same loop.
  const last = Array.isArray(npc.memory?.lastAreas) ? npc.memory.lastAreas : [];
  const recentPenalty = last.includes(Number(areaId)) ? 0.12 : 0;

  const distanceCost = steps * 0.12;

  // HUNT: healthy + armed NPCs bias toward populated areas (higher chance to find a target).
  // We use the true world state here to keep behavior punchy; the player only sees diegetic hints.
  let populationBonus = 0;
  if(offensive && hpP >= 0.70){
    let pop = 0;
    const p2 = world?.entities?.player;
    if(p2 && (p2.hp ?? 0) > 0 && Number(p2.areaId) === Number(areaId) && !(p2._today?.invisible)) pop++;
    for(const other of Object.values(world?.entities?.npcs || {})){
      if(!other || (other.hp ?? 0) <= 0) continue;
      if(other.id === npc.id) continue;
      if(Number(other.areaId) !== Number(areaId)) continue;
      if(other._today?.invisible) continue;
      pop++;
    }
    populationBonus = Math.min(0.45, pop * 0.14);
  }

  const score =
    lootValue * (0.4 + traits.greed) +
    foodValue * (0.35 + needFood) +
    safety * (0.25 + traits.caution) -
    threat * (0.25 + traits.caution) -
    distanceCost -
    revisitPenalty -
    crowdPenalty +
    explore -
    recentPenalty +
    noiseBonus +
    populationBonus;

  // tiny deterministic jitter to break ties.
  return score + (hash01(seed, day, `area_jitter|${npc.id}|${areaId}`) * 0.01);
}

function weightedPick(options, r01, temperature){
  if(!options || !options.length) return null;
  const t = Math.max(0.15, Math.min(0.75, Number(temperature) || 0.45));
  // Softmax on normalized scores.
  const maxS = Math.max(...options.map(o => o.score));
  const weights = options.map(o => Math.exp((o.score - maxS) / t));
  const sum = weights.reduce((a,b)=>a+b, 0) || 1;
  let acc = 0;
  for(let i=0;i<options.length;i++){
    acc += weights[i] / sum;
    if(r01 <= acc) return options[i];
  }
  return options[options.length - 1];
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
  const fpRisk = clamp01((20 - (attacker.fp ?? 100)) / 20);
  return clamp01(crowd * 0.55 + hpRisk * 0.35 + fpRisk * 0.25);
}

function fearFactor(npc){
  const hp = npc.hp ?? 100;
  const fp = npc.fp ?? 100;
  const lowHp = clamp01((35 - hp) / 35);
  const lowFp = clamp01((15 - fp) / 15);
  return clamp01(lowHp * 0.9 + lowFp * 0.6);
}

function itemValue(def, inst){
  if(!def) return 0.05;
  // Backpacks are extremely valuable because they explode into 2–3 items.
  if(def.id === "backpack") return 0.98;
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
  const fp = npc.fp ?? 100;
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
