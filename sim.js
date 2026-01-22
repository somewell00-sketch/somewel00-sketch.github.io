import { cloneWorld } from "./state.js";

export function isAdjacent(world, fromId, toId){
  const adj = world.map.adjById[String(fromId)] || [];
  return adj.includes(toId);
}

export function maxSteps(entity){
  const hp = entity.hp ?? 100;
  const fp = entity.fp ?? 70;
  return (hp > 30 && fp > 20) ? 3 : 1;
}

function isAreaActive(world, areaId){
  const a = world.map.areasById[String(areaId)];
  return !!a && a.isActive !== false;
}

export function isRouteValid(world, fromAreaId, route, entity){
  if(!Array.isArray(route) || route.length === 0) return { ok:false, reason:"empty_route" };

  const stepsAllowed = maxSteps(entity);
  if(route.length > stepsAllowed) return { ok:false, reason:"too_many_steps", stepsAllowed };

  let cur = fromAreaId;
  for(const raw of route){
    const to = Number(raw);
    if(!isAreaActive(world, to)) return { ok:false, reason:"area_closed", at: to };
    if(!isAdjacent(world, cur, to)) return { ok:false, reason:"not_adjacent", from: cur, to };

    const dest = world.map.areasById[String(to)];
    if(dest?.hasWater && !dest?.hasBridge){
      return { ok:false, reason:"water_no_bridge", to };
    }
    cur = to;
  }
  return { ok:true, finalAreaId: cur };
}

export function advanceDay(world, actions = []){
  const next = cloneWorld(world);
  const day = next.meta.day;
  const events = [];
  const stepsTaken = {}; // actorId -> steps used today

  // 0) Apply closures effective today + schedule new ones (warning -> close next day)
  applyClosuresForDay(next, day);

  // 1) Action 1: declarations
  const declarations = buildDeclarations(actions);
  // store defend/attack intent for the day
  next.systems.combat = { declarations };

  // 2) Action 2: movement/stay
  for(const act of actions){
    if(act.type === "MOVE"){
      applyMove(next, act.source, act.payload || {}, events);
    } else if (act.type === "STAY"){
      events.push({ type: "STAY", who: act.source });
    }
  }

  // 3) Encounters + Combat (MVP)
  resolveCombat(next, declarations, events);

  // 4) Maintenance: FP -10; Cornucopia auto food
  for(const e of [next.entities.player, ...Object.values(next.entities.npcs)]){
    if((e.hp ?? 0) <= 0) continue;

    const inCorn = (e.areaId === 1);
    if(inCorn){
      e.fp = 70;
    } else {
      e.fp = (e.fp ?? 70) - 10;
    }
  }

  // 5) Next day + log
  next.meta.day += 1;
  next.log.days.push({ day, events });

  return next;
}

function buildDeclarations(actions){
  const decl = {}; // id -> { attackTargetId?, defend?, doNothing? }
  for(const act of actions){
    if(!act || !act.source) continue;
    if(!decl[act.source]) decl[act.source] = {};
    if(act.type === "ATTACK"){
      decl[act.source].attackTargetId = act.payload?.targetId ?? null;
    } else if(act.type === "DEFEND"){
      decl[act.source].defend = true;
    } else if(act.type === "DO_NOTHING"){
      decl[act.source].doNothing = true;
    }
  }
  return decl;
}

function actorById(world, id){
  if(id === "player") return world.entities.player;
  return world.entities.npcs[id];
}

function applyMove(world, who, payload, events){
  const entity = actorById(world, who);
  if(!entity) return;

  const from = entity.areaId;
  const route = Array.isArray(payload.route) ? payload.route.map(Number)
    : (payload.toAreaId != null ? [Number(payload.toAreaId)] : []);

  if(route.length === 0){
    events.push({ type: "MOVE_BLOCKED", who, from, reason: "empty_route" });
    return;
  }

  if(!isAreaActive(world, from)){
    events.push({ type: "MOVE_BLOCKED", who, from, reason: "start_area_closed" });
    return;
  }

  const res = isRouteValid(world, from, route, entity);
  if(!res.ok){
    events.push({ type: "MOVE_BLOCKED", who, from, to: route[0], reason: res.reason, details: res });
    return;
  }

  const to = res.finalAreaId;
  entity.areaId = to;
  stepsTaken[entity.id] = used + 1;
  events.push({ type: "MOVE", who, from, to, route });

  if(who === "player"){
    const v = new Set(world.flags.visitedAreas || []);
    v.add(1);
    v.add(to);
    world.flags.visitedAreas = Array.from(v).sort((a,b)=>a-b);
  }
}

function resolveCombat(world, decl, events){
  // Group actors by area
  const byArea = new Map();
  for(const a of [world.entities.player, ...Object.values(world.entities.npcs)]){
    if((a.hp ?? 0) <= 0) continue;
    const arr = byArea.get(a.areaId) || [];
    arr.push(a);
    byArea.set(a.areaId, arr);
  }

  const baseDmg = 5;

  for(const [areaId, actors] of byArea.entries()){
    // build attack pairs within area
    for(const attacker of actors){
      const ad = decl[attacker.id === world.entities.player.id ? "player" : attacker.id] || decl[attacker.id] || {};
      const targetId = ad.attackTargetId;
      if(!targetId) continue;

      const target = actorById(world, targetId) || actors.find(x => x.id === targetId);
      if(!target) continue;
      if(target.areaId !== attacker.areaId) continue;

      // Only counter if target also attacked attacker
      const td = decl[targetId] || {};
      const targetAttacksBack = (td.attackTargetId === (attacker.id === world.entities.player.id ? "player" : attacker.id));

      // Determine order if mutual attack
      if(targetAttacksBack){
        resolveMutualAttack(world, attacker, target, baseDmg, decl, events);
      } else {
        applyDamage(world, attacker, target, baseDmg, decl, events);
      }
    }
  }
}

function strengthOf(e){ return e.attrs?.F ?? 0; }

function resolveMutualAttack(world, a, b, baseDmg, decl, events){
  // Order by strength; tie => both deal damage
  const fa = strengthOf(a), fb = strengthOf(b);
  if(fa === fb){
    applyDamage(world, a, b, baseDmg, decl, events);
    applyDamage(world, b, a, baseDmg, decl, events);
    return;
  }
  const first = (fa > fb) ? a : b;
  const second = (first === a) ? b : a;

  applyDamage(world, first, second, baseDmg, decl, events);

  // "Dead weaker can't strike back" MVP:
  // if second died and second's strength < first's strength, no return damage.
  if((second.hp ?? 0) <= 0 && strengthOf(second) < strengthOf(first)){
    return;
  }
  applyDamage(world, second, first, baseDmg, decl, events);
}

function applyDamage(world, attacker, target, dmg, decl, events){
  if((attacker.hp ?? 0) <= 0) return;
  if((target.hp ?? 0) <= 0) return;

  const tDecl = decl[target.id] || {};
  const defended = !!tDecl.defend;
  const finalDmg = defended ? Math.ceil(dmg * 0.5) : dmg;

  target.hp = (target.hp ?? 100) - finalDmg;
  events.push({ type:"HIT", attacker: attacker.id === world.entities.player.id ? "player" : attacker.id, target: target.id === world.entities.player.id ? "player" : target.id, dmg: finalDmg, defended });

  if(target.hp <= 0){
    target.hp = 0;
    events.push({ type:"DEATH", who: target.id === world.entities.player.id ? "player" : target.id, areaId: target.areaId });

    // Kill count MVP: only if attacker is alive
    if(attacker.id === world.entities.player.id){
      world.entities.player.kills = (world.entities.player.kills ?? 0) + 1;
    } else {
      attacker.kills = (attacker.kills ?? 0) + 1;
    }
  }
}

function applyClosuresForDay(world, day){
  // Close anything scheduled for today
  for(const idStr of Object.keys(world.map.areasById)){
    const a = world.map.areasById[idStr];
    if(a.isActive !== false && a.willCloseOnDay === day){
      a.isActive = false;
      world.flags.closedAreas = Array.from(new Set([...(world.flags.closedAreas||[]), a.id])).sort((x,y)=>x-y);
    }
  }

  // Starting day 3, every 2 days: mark 4 highest-id active areas (excluding 1) to close next day.
  if(day >= 3 && ((day - 3) % 2 === 0)){
    const active = Object.values(world.map.areasById)
      .filter(a => a.id !== 1 && a.isActive !== false);

    active.sort((a,b)=>b.id-a.id);
    const toMark = active.slice(0, 4);
    for(const a of toMark){
      if(a.willCloseOnDay == null){
        a.willCloseOnDay = day + 1; // warning today, closes tomorrow
      }
    }
  }
}function maxStepsFor(entity){
  // MVP: up to 3 steps/day. Later: depend on HP/FP.
  return 3;
}


