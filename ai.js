// AI gera INTENTS. Não aplica nada no mundo.
export function generateNpcIntents(world){
  const intents = [];
  const currentDay = world.meta.day;

  // exemplo simples: cada NPC tenta se mover para um vizinho aleatório
  for (const npc of Object.values(world.entities.npcs)){
    const adj = world.map.adjById[String(npc.areaId)] || [];
    if (adj.length === 0) continue;

    // leve chance de descansar
    const r = pseudoRandom(world.meta.seed, currentDay, npc.id);
    if (r < 0.25){
      intents.push({ source: npc.id, type: "REST", payload: {} });
      continue;
    }

    const idx = Math.floor(pseudoRandom(world.meta.seed + 999, currentDay, npc.id) * adj.length);
    const toAreaId = adj[idx];

    intents.push({ source: npc.id, type: "MOVE", payload: { toAreaId } });
  }

  return intents;
}

// determinístico sem RNG global (usa seed+day+npcId)
function pseudoRandom(seed, day, str){
  let h = 2166136261 >>> 0;
  const s = `${seed}|${day}|${str}`;
  for (let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // xorshift
  h ^= h << 13; h >>>= 0;
  h ^= h >>> 17; h >>>= 0;
  h ^= h << 5; h >>>= 0;
  return (h >>> 0) / 4294967296;
}
