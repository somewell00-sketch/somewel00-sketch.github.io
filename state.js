export const MapSize = {
  SMALL: 24,
  MEDIUM: 48,
  LARGE: 72
};

export function createInitialWorld({ seed, mapSize, mapData, npcCount = 6 }){
  const npcs = {};
  for (let i = 1; i <= npcCount; i++){
    const id = `npc_${i}`;
    npcs[id] = {
      id,
      name: `NPC ${i}`,
      areaId: 1,
      hp: 10,
      stamina: 10,
      status: [],
      inventory: {},
      memory: { goal: "explore" }
    };
  }

  return {
    meta: {
      version: 1,
      seed,
      day: 1,
      mapSize
    },
    map: mapData, // { areasById, adjById, uiGeom }
    entities: {
      player: {
        id: "player",
        name: "Jogador",
        areaId: 1,
        hp: 10,
        stamina: 10,
        status: [],
        inventory: {},
        memory: {}
      },
      npcs
    },
    flags: {
      visitedAreas: [1]
    },
    log: {
      days: [] // [{day, events:[]}]
    },
    replay: {
      playerActionsByDay: [] // array index day-1
    }
  };
}

export function cloneWorld(world){
  return structuredClone(world);
}
