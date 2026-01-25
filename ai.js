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

  // --- AI Phase (chaos ↔ strategy) ---
  // CHAOS_EARLY: > 2/3 alive
  // STRATEGIC:   <= 2/3 and > 1/3 alive
  // CHAOS_LATE:  <= 1/3 alive
  const debugPhase = computeAiPhase(world);
  if(world && world.meta){
    // Non-breaking: adds optional metadata used for debugging/exported logs.
    world.meta.aiPhase = debugPhase;
  }

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
    const actionIntent = decidePosture(world, npc, obs, traits, { seed, day, playerDistrict, debugPhase });
    if(actionIntent) intents.push(actionIntent);

    // --- Movement intent ---
    const moveIntent = decideMove(world, npc, obs, traits, { seed, day, debugPhase });
    if(moveIntent) intents.push(moveIntent);
  }

  return intents;
}

function computeAiPhase(world){
  const total = Number(world?.meta?.totalPlayers ?? 0) || 0;
  // Fallback: if total is missing, keep behavior stable.
  if(total <= 0) return "STRATEGIC";

  let alive = 0;
  const p = world?.entities?.player;
  if(p && (p.hp ?? 0) > 0) alive++;
  for(const npc of Object.values(world?.entities?.npcs || {})){
    if(npc && (npc.hp ?? 0) > 0) alive++;
  }

  const ratio = alive / total;
  if(ratio > (2/3)) return "CHAOS_EARLY";
  if(ratio > (1/3)) return "STRATEGIC";
  return "CHAOS_LATE";
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

function decidePosture(world, npc, obs, traits, { seed, day, playerDistrict, debugPhase }){
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
    // After day 5, ease off so Cornucopia doesn't become a forever-loot vacuum.
    const baseChance = (day <= 3) ? 0.92 : (day <= 5 ? 0.55 : 0.30);
    // If they have 0–1 items, they are still gearing up.
    const invBoost = (invN <= 1) ? 0.25 : 0;
    const rForce = hash01(seed, day, `corn_collect|${npc.id}|${invN}|${ground.length}`);
    if(rForce < Math.min(0.98, baseChance + invBoost)){
    const scoredItems = [];
    for(let i=0;i<ground.length;i++){
      const inst = ground[i];
      const def = getItemDef(inst?.defId);
      scoredItems.push({ idx: i, score: itemValue(def, inst) });
    }
    scoredItems.sort((a,b)=>b.score-a.score);
    const topK = scoredItems.slice(0, Math.min(4, scoredItems.length));
    const r = hash01(seed, day, `collect_pick|${npc.id}|corn`);
    const pickPos = Math.floor(r * topK.length);
    const chosen = topK[Math.max(0, Math.min(topK.length - 1, pickPos))];
    return { source: npc.id, type: "COLLECT", payload: { itemIndex: chosen.idx } };
    }
  }

  // Hunger/FP: if low and water exists, prefer drinking.
  if((npc.fp ?? 0) <= 15 && hasWater){
    return { source: npc.id, type: "DRINK", payload: {} };
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

  // --- Phase knobs ---
  const isChaosEarly = debugPhase === "CHAOS_EARLY";
  const isStrategic = debugPhase === "STRATEGIC";
  const isChaosLate = debugPhase === "CHAOS_LATE";
  const isChaos = isChaosEarly || isChaosLate;

  // Global: max kills for "threat focus" normalization.
  const maxKills = Math.max(1,
    Number(world?.entities?.player?.kills ?? 0),
    ...Object.values(world?.entities?.npcs || {}).map(n => Number(n?.kills ?? 0))
  );

  // Coalition heuristic: if 3+ actors are in the same area, weaker ones are more likely to dogpile the strongest.
  const areaActors = [npc, ...targets].filter(Boolean);
  const canCoalition = areaActors.length >= 3;
  const strongestIdInArea = canCoalition ? strongestActorId(areaActors) : null;
  const selfIsStrongest = (strongestIdInArea != null) && (strongestIdInArea === npc.id);

  for(const t of targets){
    // District bias: less likely to attack same district and less likely to attack player's district.
    const sameDistrict = (t.district != null && npc.district != null && t.district === npc.district);
    const playerDistrictBias = (playerDistrict != null && t.district != null && t.district === playerDistrict);

    const killChance = estimateKillChance(world, npc, t, { seed, day });
    const risk = estimateRisk(world, npc, t);

    // Base: expected gain - expected pain.
    // In CHAOS phases we weight aggression more and inject noise; in STRATEGIC we weight risk more.
    const aggrW = isStrategic ? (0.85 + traits.aggression * 0.65) : (1.05 + traits.aggression * 0.85);
    const riskW = isStrategic ? (0.85 + traits.caution * 1.00) : (0.45 + traits.caution * 0.65);

    let score = killChance * aggrW - risk * riskW;

    // Strong weapon makes them more willing to start fights.
    if(hasStrongWeapon) score += isStrategic ? 0.40 : 0.65;

    // District bias: keep it, but soften it so the player doesn't become a "never attack" target.
    if(sameDistrict) score -= isChaos ? 0.18 : 0.35;
    if(playerDistrictBias && t.id !== "player") score -= isChaos ? 0.05 : 0.12;

    // Cowardice: they still like finishing weak targets.
    const hpFrac = clamp01((t.hp ?? 100) / 100);
    const weakBonus = (1 - hpFrac) * (isStrategic ? 0.28 : 0.40);
    score += weakBonus;
    if((t.hp ?? 100) <= 35) score += isStrategic ? 0.20 : 0.32;

    // Threat focus: higher kill count draws attention (especially in STRATEGIC and late-game CHAOS).
    const killFrac = clamp01(Number(t.kills ?? 0) / maxKills);
    const killFocus = (isStrategic ? 0.55 : (isChaosLate ? 0.65 : 0.30));
    score += killFrac * killFocus;

    // Coalition: if 3+ in the area, non-strongest actors are more likely to attack the strongest.
    if(canCoalition && !selfIsStrongest && strongestIdInArea && t.id === strongestIdInArea){
      const selfThreat = combatThreatScore(npc);
      const strongThreat = combatThreatScore(t);
      const gap = clamp01((strongThreat - selfThreat) / Math.max(1, strongThreat));
      const coalitionBase = isStrategic ? 0.55 : 0.35;
      score += coalitionBase + gap * (isStrategic ? 0.35 : 0.55);
    }

    // CHAOS: inject randomness + more willingness to swing at strong targets.
    if(isChaos){
      const noise = (hash01(seed, day, `atk_noise|${npc.id}|${t.id}|${debugPhase}`) * 2 - 1);
      score += noise * (isChaosEarly ? 0.22 : 0.30);
      // Early chaos: sometimes go for the strongest just because.
      if(isChaosEarly && canCoalition && t.id === strongestIdInArea){
        score += 0.10;
      }
    }

    if(score > bestAttackScore){
      bestAttackScore = score;
      bestAttack = t;
    }
  }

  // Defensive posture shifts with phase.
  const defendScore = (isStrategic ? 0.42 : 0.28) + traits.caution * (isStrategic ? 0.55 : 0.35) + fearFactor(npc) * (isStrategic ? 0.70 : 0.45);
  const nothingScore = isChaos ? 0.05 : 0.15;

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

function decideMove(world, npc, obs, traits, { seed, day, debugPhase }){
  if((npc.trappedDays ?? 0) > 0) return { source: npc.id, type: "STAY", payload: { reason: "trapped" } };

  const max = maxStepsForNpc(npc);
  if(max <= 0) return { source: npc.id, type: "STAY", payload: {} };

  
  const lowFp = (npc.fp ?? 0) <= 20;
  const currentArea = world.map?.areasById?.[String(npc.areaId)];
  const inCornucopia = Number(currentArea?.id) === 1;
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
const invCount = inventoryCount(npc.inventory);
let stayBias = 0;
if(Number(start) === 1){
  if(invCount === 0) stayBias = +0.22;
  else if(invCount === 1) stayBias = -0.28;
  else stayBias = -0.55;
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
  const forceMove = emptyHere || (Number(start) === 1 && invCount >= 2 && cornLootLow);

  const moveThreshold = (0.14 + traits.caution * 0.10) + (invCount === 0 && Number(start) === 1 ? 0.06 : 0) - (invCount >= 2 ? 0.06 : 0);
  const canMove = forceMove || scored.some(s => !s.isStay && (s.score - adjustedStayScore) >= moveThreshold);
  if(!canMove) return { source: npc.id, type: "STAY", payload: {} };

  // Deterministic weighted choice among the top few candidates.
  // More cautious NPCs behave more deterministically (lower temperature).
  // CHAOS phases are more erratic (higher temperature).
  const isChaos = (debugPhase === "CHAOS_EARLY" || debugPhase === "CHAOS_LATE");
  const temperatureBase = (isChaos ? 0.68 : 0.55);
  const temperature = temperatureBase - traits.caution * (isChaos ? 0.22 : 0.30); // ~0.30..0.68
  const pool = scored.filter(s => !s.isStay).slice(0, 6);
  const pickR = hash01(seed, day, `move_pick|${npc.id}`);
  const chosen = weightedPick(pool, pickR, temperature) || pool[0];

  return { source: npc.id, type: "MOVE", payload: { route: chosen.route } };
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

  const fpNow = Number(npc.fp ?? 0);
  let needFood = clamp01((40 - fpNow) / 40);
  if(fpNow <= 20) needFood = Math.min(1, needFood + 0.35);
  const safety = (a.threatClass === "safe" ? 0.45 : (a.threatClass === "neutral" ? 0.2 : -0.25));
  const threat = (a.threatClass === "threatening" ? 0.35 : 0.05) + (creatures * 0.25);
  const revisitPenalty = (Number(areaId) === Number(npc.areaId)) ? 0 : (known ? 0.02 : 0.06);

  // Memory: discourage "train" movement where NPCs follow the same loop.
  const last = Array.isArray(npc.memory?.lastAreas) ? npc.memory.lastAreas : [];
  const recentPenalty = last.includes(Number(areaId)) ? 0.12 : 0;

  const distanceCost = steps * 0.12;

  const score =
    lootValue * (0.4 + traits.greed) +
    foodValue * (0.35 + needFood) +
    safety * (0.25 + traits.caution) -
    threat * (0.25 + traits.caution) -
    distanceCost -
    revisitPenalty -
    crowdPenalty +
    explore -
    recentPenalty;

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
  const fpRisk = clamp01((20 - (attacker.fp ?? 70)) / 20);
  return clamp01(crowd * 0.55 + hpRisk * 0.35 + fpRisk * 0.25);
}

function combatThreatScore(actor){
  if(!actor) return 0;
  const hp = Number(actor.hp ?? 0);
  const fp = Number(actor.fp ?? 0);
  const kills = Number(actor.kills ?? 0);
  const attrs = actor.attrs || {};
  const F = Number(attrs.F ?? 0);
  const D = Number(attrs.D ?? 0);
  const P = Number(attrs.P ?? 0);

  const w = strongestWeaponInInventory(actor.inventory);
  let dmg = 0;
  if(w?.def){
    const qty = Number(w.inst?.qty || 1);
    dmg = w.def.stackable ? Number(w.def.damage ?? 0) * qty : Number(w.def.damage ?? 0);
  }

  // Tuned to feel right, not to be "true" combat math.
  return hp * 0.55 + fp * 0.12 + dmg * 1.05 + kills * 18 + (F + D + P) * 4;
}

function strongestActorId(actors){
  let bestId = null;
  let best = -1e9;
  for(const a of (actors || [])){
    if(!a || (a.hp ?? 0) <= 0) continue;
    const s = combatThreatScore(a);
    if(s > best){ best = s; bestId = a.id; }
  }
  return bestId;
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
