export function generateNpcIntents(world){
  const intents = [];
  const day = world?.meta?.day ?? 1;
  const seed = world?.meta?.seed ?? 1;

  for (const npc of Object.values(world.entities.npcs)){
    // Action 1: default defend (placeholder)
    intents.push({ source: npc.id, type: "DEFEND", payload: {} });

    // Action 2: small move chance
    const adj = world.map.adjById[String(npc.areaId)] || [];
    if (adj.length === 0) continue;

    const r = prng(seed, day, npc.id);
    if (r < 0.55){
      const idx = Math.floor(prng(seed+999, day, npc.id) * adj.length);
      intents.push({ source: npc.id, type: "MOVE", payload: { route: [adj[idx]] } });
    } else {
      intents.push({ source: npc.id, type: "STAY", payload: {} });
    }
  }
  return intents;
}

function prng(seed, day, id){
  let h = 2166136261 >>> 0;
  const s = String(seed) + "|" + String(day) + "|" + String(id);
  for (let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
