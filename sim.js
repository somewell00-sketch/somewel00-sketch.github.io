import { cloneWorld } from "./state.js";
import { generateNpcIntents } from "./ai.js";

export function isAdjacent(world, fromId, toId){
  const adj = world.map.adjById[String(fromId)] || [];
  return adj.includes(toId);
}

export function advanceDay(world, playerActionsForDay = []){
  const next = cloneWorld(world);

  const events = [];
  const day = next.meta.day;

  // 1) NPC intents
  const npcIntents = generateNpcIntents(next);

  // 2) juntar ações: player first (você pode inverter depois)
  const actions = [
    ...playerActionsForDay.map(a => ({ ...a, source: "player" })),
    ...npcIntents
  ];

  // 3) aplicar ações com regras
  for (const act of actions){
    if (act.type === "MOVE"){
      applyMove(next, act.source, act.payload.toAreaId, events);
    } else if (act.type === "REST"){
      events.push({ type: "REST", who: act.source });
    }
  }

  // 4) avançar o dia
  next.meta.day += 1;

  // 5) log
  next.log.days.push({ day, events });

  return { nextWorld: next, dayEvents: events };
}

function applyMove(world, who, toAreaId, events){
  const entity = (who === "player")
    ? world.entities.player
    : world.entities.npcs[who];

  if (!entity) return;

  const from = entity.areaId;
  const to = Number(toAreaId);

  // regra: só move para adjacente
  if (!isAdjacent(world, from, to)) {
    events.push({ type: "MOVE_BLOCKED", who, from, to, reason: "not_adjacent" });
    return;
  }

  entity.areaId = to;
  events.push({ type: "MOVE", who, from, to });

  // flags (somente player marca visitado)
  if (who === "player"){
    const v = new Set(world.flags.visitedAreas);
    v.add(to);
    v.add(1);
    world.flags.visitedAreas = Array.from(v).sort((a,b)=>a-b);
  }
}
