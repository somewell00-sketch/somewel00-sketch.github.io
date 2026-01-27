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

  // --- Global AI phase (macro behavior) ---
  // CHAOS_EARLY  : > 2/3 alive
  // STRATEGIC    : (1/3, 2/3]
  // CHAOS_LATE   : <= 1/3 alive
  const alive = countAlivePlayers(world);
  const total = Math.max(1, Number(world?.meta?.totalPlayers ?? (alive || 1)));
  const ratio = alive / total;
  const aiPhase = (ratio > (2/3)) ? "CHAOS_EARLY" : (ratio > (1/3) ? "STRATEGIC" : "CHAOS_LATE");
  // Store on meta for debug/logging (safe, purely informational)
  if(world?.meta) world.meta.aiPhase = aiPhase;
  const phaseProfile = getPhaseProfile(aiPhase);

  // Per-day anti-collision reservations for COLLECT in the same area.
  // Keyed by areaId => { itemIndex: count }
  const reservedCollectByArea = {};

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
    const actionIntent = decidePosture(world, npc, obs, traits, {
      seed,
      day,
      playerDistrict,
      aiPhase,
      phaseProfile,
      reservedCollectByArea
    });
    if(actionIntent) intents.push(actionIntent);

    // Reserve collected index to increase diversity.
    if(actionIntent?.type === "COLLECT"){
      const aId = String(npc.areaId);
      const idx = Number(actionIntent?.payload?.itemIndex);
      if(Number.isFinite(idx)){
        reservedCollectByArea[aId] = reservedCollectByArea[aId] || {};
        reservedCollectByArea[aId][idx] = (reservedCollectByArea[aId][idx] || 0) + 1;
      }
      // Mark for Cornucopia exit rule (leave after getting any item).
      if(Number(obs?.area?.id) === 1) npc.memory._plannedCornCollect = true;
    }

    // --- Movement intent ---
    const moveIntent = decideMove(world, npc, obs, traits, { seed, day, aiPhase, phaseProfile });
    if(moveIntent) intents.push(moveIntent);
  }

  return intents;
}

function countAlivePlayers(world){
  let n = 0;
  const p = world?.entities?.player;
  if(p && Number(p.hp ?? 0) > 0) n++;
  for(const npc of Object.values(world?.entities?.npcs || {})){
    if(npc && Number(npc.hp ?? 0) > 0) n++;
  }
  return n;
}

function getPhaseProfile(aiPhase){
  // These are multipliers applied to existing scoring so we don't break balance.
  // CHAOS phases deliberately increase randomness and group escalation.
  switch(String(aiPhase)){
    case "CHAOS_EARLY":
      return {
        risk: 0.75,
        aggression: 1.25,
        group: 0.95,
        killLeader: 0.55,
        coward: 0.55,
        randomness: 0.85
      };
    case "CHAOS_LATE":
      return {
        risk: 0.65,
        aggression: 1.35,
        group: 0.75,
        killLeader: 0.85,
        coward: 0.40,
        randomness: 0.95
      };
    default: // STRATEGIC
      return {
        risk: 1.20,
        aggression: 0.95,
        group: 0.35,
        killLeader: 0.75,
        coward: 0.80,
        randomness: 0.25
      };
  }
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

  // Monsters (always visible; act as special hostile NPC-like entities).
  for(const m of Object.values(world?.entities?.monsters || {})){
    if(!m || m.alive === false || (m.hp ?? 0) <= 0) continue;
    if(m.areaId !== npc.areaId) continue;
    hereActors.push({ id: m.id, kind: "monster", entity: m });
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

function decidePosture(world, npc, obs, traits, { seed, day, playerDistrict, aiPhase, phaseProfile, reservedCollectByArea }){
  if((npc.trappedDays ?? 0) > 0) return { source: npc.id, type: "NOTHING", payload: { reason: "trapped" } };

  const area = obs.area;
  const invN = inventoryCount(npc.inventory);
  const hasWater = !!area?.hasWater;
  const ground = Array.isArray(area?.groundItems) ? area.groundItems : [];

  // --- Cornucopia-specific NPC behavior (Area 1 only) ---
  // Memory (temporary):
  // - cornCollectTries: number of COLLECT attempts made in the Cornucopia.
  // - cornHasWeapon: true if the NPC has collected any weapon.
  // Outside Area 1, the AI works as usual.
  const inCorn = Number(area?.id) === 1;
  const areaIdStr = String(area?.id ?? npc.areaId ?? "");
  const reservedHere = reservedCollectByArea?.[areaIdStr] || {};
  if(inCorn){
    npc.memory = npc.memory || {};
    if(npc.memory.cornCollectTries == null) npc.memory.cornCollectTries = 0;
    if(npc.memory.cornHasWeapon == null) npc.memory.cornHasWeapon = false;

    // If they already have a weapon, treat this as "has weapon" for the exit rule.
    if(!npc.memory.cornHasWeapon){
      const w = strongestWeaponInInventory(npc.inventory);
      if(w) npc.memory.cornHasWeapon = true;
    }

    const invFull = invN >= INVENTORY_LIMIT;
    const noItemsLeft = ground.length === 0;
    const triedTwiceNoWeapon = (npc.memory.cornCollectTries >= 2) && !npc.memory.cornHasWeapon;
    // Rule: Cornucopia is a scramble. If you successfully get *any* item, you leave.
    // If you fail twice to secure a weapon, you may also give up and leave.
    const hasAnyItem = invN >= 1;
    const canLeaveCorn = hasAnyItem || triedTwiceNoWeapon || noItemsLeft || invFull;

    // If not allowed to leave yet, the NPC must keep trying to COLLECT (no swapping in cornucopia).
    if(!canLeaveCorn){
      if(!invFull && ground.length){
        // Cornucopia needs to "spread" NPCs across items; otherwise many will contest the same
        // top-valued pickup and leave empty-handed after 2 tries.
        // We do a weighted pick across ALL ground items (deterministic per NPC/day) so
        // early-game loot gets distributed quickly and more believably.

        const opts = [];
        for(let i=0;i<ground.length;i++){
          const inst = ground[i];
          const def = getItemDef(inst?.defId);
          let v0 = itemValue(def, inst);
          let v = v0;

          // Anti-collision: if many NPCs are already planning to pick this index today, devalue it.
          const reservedCount = Number(reservedHere?.[i] ?? 0);
          if(reservedCount > 0) v *= 1 / (1 + reservedCount * 1.35);

          // Personality-driven preferences in the Cornucopia:
          // - greed => chase stronger weapons more
          // - caution => avoid the single best item (likely contested), accept median value
          // - packrat => value backpacks/utility more
          const isWeapon = def?.type === ItemTypes.WEAPON;
          const isBackpack = (def?.id === "backpack" || def?.id === "first_aid_backpack");

          if(isWeapon){
            // Exponent > 1 makes values more 'peaky' (harder preference for top weapons).
            // Exponent < 1 flattens the field (more willing to take medium weapons).
            const exp = 0.85 + (1 - traits.caution) * 0.75 - traits.caution * 0.10;
            v = Math.pow(Math.max(0.001, v0), exp);
            v *= (1.25 + traits.greed * 0.95);
          } else {
            v *= 0.95 + traits.packrat * 0.20;
          }

          if(isBackpack){
            // Some NPCs will prioritize backpacks over raw weapon power.
            v *= 1.10 + traits.packrat * 2.20 + traits.caution * 0.25;
          }

          // If the NPC still has no weapon, slightly deprioritize non-weapons.
          if(!npc.memory.cornHasWeapon && !isWeapon) v *= 0.80;
          // If they have no weapon and are bold, bump weapons a bit.
          if(!npc.memory.cornHasWeapon && isWeapon) v *= 1.10 + (1 - traits.caution) * 0.20;

          // Add a tiny NPC-specific jitter so ties don't collapse to the same index.
          v += hash01(seed, day, `corn_item_jitter|${npc.id}|${i}`) * 0.02;

          opts.push({ idx: i, score: v });
        }

        // Personality affects how sharply they chase top loot.
        // Cautious NPCs spread out more (avoid heavy contests), bold NPCs focus the best.
        const cornTemp = 0.22 + traits.caution * 0.55 - traits.greed * 0.10;
        const pick = weightedPick(opts, hash01(seed, day, `corn_pick|${npc.id}`), cornTemp) || opts[0];
        return { source: npc.id, type: "COLLECT", payload: { itemIndex: pick.idx } };
      }
    }
    // If they can leave, fall through to normal logic (attack/defend/drink/etc.).
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

  // Collect: greed-based, but with diversity.
  // Instead of always grabbing the single best item (which causes collisions),
  // pick from a larger pool with weighted randomness and an anti-collision penalty.
  if(ground.length && invN < INVENTORY_LIMIT){
    const r = hash01(seed, day, `npc_collect_bias|${npc.id}`);
    const baseChance = 0.10 + traits.greed * 0.35;
    if(r < Math.min(0.85, baseChance + (phaseProfile?.randomness ?? 0) * 0.10)){
      const scored = [];
      for(let i=0;i<ground.length;i++){
        const inst = ground[i];
        const def = getItemDef(inst?.defId);
        let v = itemValue(def, inst);
        // Anti-collision
        const reservedCount = Number(reservedHere?.[i] ?? 0);
        if(reservedCount > 0) v *= 1 / (1 + reservedCount * 1.25);
        // Tiny deterministic jitter so ties don't collapse
        v += hash01(seed, day, `collect_jitter|${npc.id}|${i}`) * 0.015;
        scored.push({ idx: i, score: v });
      }
      scored.sort((a,b)=>b.score-a.score);
      const topN = Math.min(10, scored.length);
      const pool = scored.slice(0, topN);
      const temp = 0.20 + (phaseProfile?.randomness ?? 0) * 0.55 + traits.caution * 0.15;
      const pick = weightedPick(pool, hash01(seed, day, `collect_pick|${npc.id}|${areaIdStr}`), temp) || pool[0];
      return { source: npc.id, type: "COLLECT", payload: { itemIndex: pick.idx } };
    }
  }


  // Injured NPCs avoid combat (System 3)
  if(hpPercent(npc) < 0.30){
    npc.memory = npc.memory || {};
    npc.memory._wantsFlee = true;
    return { source: npc.id, type: "DEFEND", payload: {} };
  }

  // Attack/Defend/Nothing: evaluate targets in the same area.
  const targets = (obs.hereActors || [])
    .filter(x => x && x.entity && (x.entity.hp ?? 0) > 0 && x.entity.areaId === npc.areaId)
    .map(x => ({ kind: x.kind, entity: x.entity }));

  // Context for social pressure / dogpiles
  const allActors = [npc, ...targets.map(t => t.entity)];
  const actorsInArea = allActors.length;

  // Find current "kill leader" among alive entities (for threat targeting)
  let maxKills = 0;
  {
    const p = world?.entities?.player;
    if(p && Number(p.hp ?? 0) > 0) maxKills = Math.max(maxKills, Number(p.kills ?? 0));
    for(const o of Object.values(world?.entities?.npcs || {})){
      if(!o || Number(o.hp ?? 0) <= 0) continue;
      maxKills = Math.max(maxKills, Number(o.kills ?? 0));
    }
  }
  const killLeaderDenom = Math.max(1, maxKills);

  // Identify the strongest actor in this area (used for coalition pressure)
  let strongestId = npc.id;
  let strongestScore = -1e9;
  for(const a of allActors){
    const w = strongestWeaponInInventory(a?.inventory);
    const wDmg = Number(w?.dmg ?? w?.damage ?? 0);
    const s = Number(a?.hp ?? 0) * 0.55 + wDmg * 1.35 + Number(a?.kills ?? 0) * 1.25;
    if(s > strongestScore){ strongestScore = s; strongestId = a?.id; }
  }

  
  // If the NPC has a strong weapon (>= 30 damage), prioritize attacking someone in the same area.
  // This is a hard bias (not absolute) and still respects camouflage and district bias.
  const strongW = strongestWeaponInInventory(npc.inventory) ;
  const hasStrongWeapon = (strongW && (strongW.dmg ?? 0) >= 30);

let bestAttack = null;
  let bestAttackScore = -1e9;

  for(const tWrap of targets){
    const t = tWrap.entity;
    const isMonster = tWrap.kind === "monster" || String(t?.id || "").startsWith("monster_");
    // District bias: less likely to attack same district and less likely to attack player's district.
    const sameDistrict = (t.district != null && npc.district != null && t.district === npc.district);
    const playerDistrictBias = (playerDistrict != null && t.district != null && t.district === playerDistrict);

    const killChance = estimateKillChance(world, npc, t, { seed, day });
    const risk = estimateRisk(world, npc, t);

    const prof = phaseProfile || { risk: 1, aggression: 1, group: 0, killLeader: 0, coward: 0, randomness: 0 };
    // Core expected value, with phase multipliers
    let score = (killChance * (0.9 + traits.aggression) * prof.aggression) - (risk * (0.6 + traits.caution) * prof.risk);

    // Presence pressure: if someone is here, the situation tends to escalate.
    // This increases same-area fights without making low-HP NPCs suicidal.
    score += (hpPercent(npc) >= 0.70) ? 0.28 : 0.16;
    if(hasDamageItem(npc.inventory)) score += 0.10;

    // Aggressiveness by HP (System 3)
    const hpP = hpPercent(npc);
    if(hpP >= 0.70) score += 0.20;
    if(hpP < 0.30) score -= 0.65;

    if(hasStrongWeapon) score += 0.55 * prof.aggression;
    // Special-case: monsters are high-value threats. Bias toward engaging if capable.
    if(isMonster){
      score += 0.95;
      if(hasDamageItem(npc.inventory)) score += 0.35;
      if(hpPercent(npc) < 0.35) score -= 0.85;
    }
    if(sameDistrict) score -= 0.55;
    if(playerDistrictBias) score -= 0.20;

    // --- Kill-leader pressure ---
    // More kills => higher perceived threat => more likely to be targeted.
    const tKills = Number(t?.kills ?? 0);
    const killFrac = tKills / killLeaderDenom;
    score += killFrac * (0.65 * prof.killLeader);

    // --- Coward opportunism (finishing weak targets) ---
    const tHpP = hpPercent(t);
    const tWeapon = strongestWeaponInInventory(t?.inventory);
    const tWeaponDmg = Number(tWeapon?.dmg ?? tWeapon?.damage ?? 0);
    const targetLooksWeak = (tHpP < 0.25) || (tWeaponDmg <= 0) || (Number(t?.fp ?? 100) < 12);
    if(targetLooksWeak) score += (0.55 + (1 - traits.caution) * 0.20) * prof.coward;

    // --- District dynamics: high districts (1-4) have a soft alliance ---
    const npcD = Number(npc?.district ?? 12);
    const tD = Number(t?.district ?? 12);
    const npcHigh = npcD <= 4;
    const tHigh = tD <= 4;
    if(npcHigh){
      if(tHigh){
        // Penalty to attack high-district peers, but allow betrayal when advantageous.
        let pen = 0.25;
        const betrayal = (String(aiPhase) === "STRATEGIC") && ((Number(t?.hp ?? 100) <= 45) || (killFrac >= 0.55));
        if(betrayal) pen *= 0.30;
        score -= pen;
      } else {
        score += 0.20;
      }
    } else {
      // Low districts are slightly wary of high districts, unless they have numbers.
      if(tHigh && !(actorsInArea >= 3 && t.id === strongestId)) score -= 0.10;
    }

    // --- Coalition pressure (3+ in the same area) ---
    // Weak/medium actors coordinate implicitly to bring down the strongest.
    if(actorsInArea >= 3 && t.id === strongestId && npc.id !== strongestId){
      const myHpP = hpPercent(npc);
      const iAmWeaker = myHpP < 0.75 || !hasDamageItem(npc.inventory);
      if(iAmWeaker){
        const groupBonus = (actorsInArea - 2) * (0.35 * prof.group);
        score += groupBonus;
      }
    }

    // --- Phase-driven randomness (keeps it less predictable in CHAOS phases) ---
    if(prof.randomness > 0){
      score += (hash01(seed, day, `attack_noise|${npc.id}|${t.id}`) - 0.5) * (0.45 * prof.randomness);
    }
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

  const prof = phaseProfile || { risk: 1, aggression: 1, group: 0, killLeader: 0, coward: 0, randomness: 0 };
  let defendScore = 0.35 + traits.caution * 0.45 + fearFactor(npc) * 0.6;
  // Phase adjustments: strategic play defends more, chaos defends less.
  if(String(aiPhase) === "STRATEGIC") defendScore += 0.08 + traits.caution * 0.06;
  else defendScore -= 0.08 - (1 - traits.caution) * 0.04;
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

function decideMove(world, npc, obs, traits, { seed, day, aiPhase, phaseProfile }){
  if((npc.trappedDays ?? 0) > 0) return { source: npc.id, type: "STAY", payload: { reason: "trapped" } };

  const max = maxStepsForNpc(npc);
  if(max <= 0) return { source: npc.id, type: "STAY", payload: {} };

  
  const lowFp = (npc.fp ?? 0) <= 20;
  const currentArea = world.map?.areasById?.[String(npc.areaId)];
  const inCornucopia = Number(currentArea?.id) === 1;
  const invCountNow = inventoryCount(npc.inventory);
  const wantsFlee = !!npc?.memory?._wantsFlee;

  // FP recovery rule:
  // If FP drops below 30, the NPC prioritizes returning to the Cornucopia (Area 1).
  // This produces more believable "refuel" behavior without exposing mechanics to the player.
  if(!inCornucopia && (npc.fp ?? 0) < 30){
    const routeToCorn = shortestRoute(world, Number(npc.areaId), 1, max, { day });
    if(routeToCorn && routeToCorn.length){
      return { source: npc.id, type: "MOVE", payload: { route: routeToCorn } };
    }
  }

  const visitedSet = new Set(Array.isArray(npc.memory?.visited) ? npc.memory.visited : []);

  // Cornucopia exit rule:
  // - If the NPC already has at least 1 item OR is planning to collect today, they leave.
  // - If they fail to secure a weapon after 2 tries, they may also give up and leave.
  // - If there are no items left or inventory is full, they can leave.
  let forceLeaveCorn = false;
  if(inCornucopia){
    npc.memory = npc.memory || {};
    if(npc.memory.cornCollectTries == null) npc.memory.cornCollectTries = 0;
    if(npc.memory.cornHasWeapon == null) npc.memory.cornHasWeapon = false;
    if(!npc.memory.cornHasWeapon){
      const w = strongestWeaponInInventory(npc.inventory);
      if(w) npc.memory.cornHasWeapon = true;
    }
    const hereGround = Array.isArray(currentArea?.groundItems) ? currentArea.groundItems : [];
    const invFull = invCountNow >= INVENTORY_LIMIT;
    const noItemsLeft = hereGround.length === 0;
    const triedTwiceNoWeapon = (npc.memory.cornCollectTries >= 2) && !npc.memory.cornHasWeapon;
    const gotAnyOrWillGet = (invCountNow >= 1) || !!npc?.memory?._plannedCornCollect;
    const canLeaveCorn = gotAnyOrWillGet || triedTwiceNoWeapon || noItemsLeft || invFull;
    if(!canLeaveCorn) return { source: npc.id, type: "STAY", payload: { reason: "corn_locked" } };

    // Day 1 linger: 20% chance to stay in the Cornucopia for one more day before dispersing.
    // Deterministic per NPC/day so it doesn't oscillate within the same simulation tick.
    if(Number(day) === 1){
      const lingerR = hash01(seed, day, `corn_linger|${npc.id}`);
      if(lingerR < 0.20){
        return { source: npc.id, type: "STAY", payload: { reason: "corn_day2_linger" } };
      }
    }
    forceLeaveCorn = true;
  }

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


// Movement bias:
// - If the current area has no loot, strongly encourage moving.
// - Outside of that, don't move unless a destination is noticeably better.
const invCount = invCountNow;
let stayBias = 0;
if(invCount >= 2) stayBias = -0.12;
const adjustedStayScore = stayScore + stayBias;

const here = world.map?.areasById?.[String(start)];
const hereGround = Array.isArray(here?.groundItems) ? here.groundItems : [];
const emptyHere = hereGround.length === 0;

// Force movement in a few cases:
// - area is empty (no reason to camp)
// - NPC is fleeing
// - Cornucopia-specific gate says they must leave immediately once allowed
const forceMove = emptyHere || wantsFlee || forceLeaveCorn;

const moveThreshold = (0.14 + traits.caution * 0.10) + (invCount === 0 && Number(start) === 1 ? 0.06 : 0) - (invCount >= 2 ? 0.06 : 0);
  const canMove = forceLeaveCorn || forceMove || scored.some(s => !s.isStay && (s.score - adjustedStayScore) >= moveThreshold);
  if(!canMove) return { source: npc.id, type: "STAY", payload: {} };

  // Deterministic weighted choice among the top few candidates.
  // More cautious NPCs behave more deterministically (lower temperature).
  // Movement randomness is phase-dependent: chaos => more exploration, strategic => more deterministic.
  const prof = phaseProfile || { randomness: 0.25 };
  const temperature = (0.38 + prof.randomness * 0.35) - traits.caution * 0.22; // ~0.20..0.75
  // If we are forcing a Cornucopia exit, prefer a simple 1-step route (clean dispersal).
  const poolBase = scored.filter(s => !s.isStay);
  const pool1 = forceLeaveCorn ? poolBase.filter(s => s.steps === 1) : poolBase;
  const pool = (pool1.length ? pool1 : poolBase).slice(0, 6);
  const pickR = hash01(seed, day, `move_pick|${npc.id}`);
  const chosen = weightedPick(pool, pickR, temperature) || pool[0];

  return { source: npc.id, type: "MOVE", payload: { route: chosen.route } };
}

function shortestRoute(world, startId, goalId, maxSteps, { day }){
  const start = Number(startId);
  const goal = Number(goalId);
  const max = Math.max(1, Number(maxSteps || 1));
  if(start === goal) return [];

  // BFS with route reconstruction, honoring the same movement constraints used by decideMove.
  const q = [{ id: start, steps: 0, route: [] }];
  const seen = new Set([start]);

  while(q.length){
    const cur = q.shift();
    if(cur.steps >= max) continue;
    const adj = world.map?.adjById?.[String(cur.id)] || [];
    for(const nxt of adj){
      const nid = Number(nxt);
      if(seen.has(nid)) continue;
      seen.add(nid);
      const a = world.map?.areasById?.[String(nid)];
      if(!a || a.isActive === false) continue;
      if(a.hasWater && !a.hasBridge) continue;
      const willCloseTomorrow = (a.willCloseOnDay != null) && (Number(a.willCloseOnDay) === Number(day) + 1);
      if(willCloseTomorrow) continue;

      const route = [...cur.route, nid];
      if(nid === goal) return route;
      q.push({ id: nid, steps: cur.steps + 1, route });
    }
  }
  return [];
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

  // Hidden area personality (only trusted if the NPC has been there before, or it is their current area).
  const canReadAreaFeel = known || Number(areaId) === Number(npc.areaId);
  const tags = canReadAreaFeel && Array.isArray(a.tags) ? a.tags : [];
  const history = canReadAreaFeel && Array.isArray(a.historyTags) ? a.historyTags : [];
  const hasHist = (tag) => history.some(h => h && h.tag === tag && Number(h.expiresDay || 0) >= Number(day));

  const lootValue = known ? (groundCount * 0.35) : 0.10;
  const foodValue = (a.hasFood ? 0.45 : 0) + (a.hasWater ? 0.18 : 0);

  // Personality-based interpretation of tags.
  let tagBonus = 0;
  if(tags.includes("rich_loot")) tagBonus += 0.18 + traits.greed * 0.22 - traits.caution * 0.05;
  if(tags.includes("quiet")) tagBonus += (hpP < 0.55 ? (0.14 + traits.caution * 0.12) : (-0.03 + traits.caution * 0.04)) - (offensive && hpP >= 0.75 ? 0.08 : 0);
  if(tags.includes("sheltered")) tagBonus += (hpP < 0.65 ? (0.10 + traits.caution * 0.10) : (0.03 + traits.caution * 0.03));
  if(tags.includes("exposed")) tagBonus -= (hpP < 0.55 ? (0.10 + traits.caution * 0.12) : (0.03 + traits.caution * 0.05));
  if(tags.includes("hazard")) tagBonus -= (0.16 + traits.caution * 0.28) + (hpP < 0.45 ? 0.10 : 0);
  // Light hazard awareness even without the hazard tag (older saves).
  if(canReadAreaFeel && a.hazard && a.hazard.type) tagBonus -= (0.10 + traits.caution * 0.18);

  // Hot-zone memory.
  let historyBonus = 0;
  if(hasHist("recent_death")) historyBonus += (offensive ? 0.03 : -0.05) - (traits.caution * 0.22) - (hpP < 0.50 ? 0.10 : 0);
  if(hasHist("recent_fight")) historyBonus += (offensive ? (0.10 + (1 - traits.caution) * 0.18) : (-0.08 - traits.caution * 0.04));
  if(hasHist("trap_suspected")) historyBonus -= (0.10 + traits.caution * 0.18);
  if(hasHist("explosive_noise")) historyBonus -= (0.06 + traits.caution * 0.12);
  if(hasHist("high_risk")) historyBonus -= (0.08 + traits.caution * 0.22) + (hpP < 0.55 ? 0.06 : 0);

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

  // Lower distance cost encourages wider roaming (2–3 steps) while preserving strategy.
  const distanceCost = steps * 0.07;

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
    populationBonus +
    tagBonus +
    historyBonus;

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
  const p = hash01(seed, 0, `trait_pack|${id}|${district}`);
  // District behavior gradient:
  // 1 = more aggressive, 12 = more cautious/sneaky.
  const d = Number(district ?? 12);
  const t = clamp01((d - 1) / 11); // 0..1
  const aggrBias = (1 - t) * 0.35;  // D1 +0.35 ... D12 +0
  const cautBias = t * 0.35;       // D1 +0 ... D12 +0.35
  const packBias = t * 0.40;       // stealthy/utility bias for low-power districts

  const aggression = clamp01((0.25 + a * 0.75) + aggrBias - cautBias * 0.15);
  const caution = clamp01((0.20 + c * 0.80) + cautBias - aggrBias * 0.10);
  const packrat = clamp01((0.10 + p * 0.90) + packBias);

  return {
    aggression,
    greed: clamp01(0.15 + g * 0.85),
    caution,
    // Loot style: higher = prefers utility/backpacks/safer pickups.
    packrat
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
