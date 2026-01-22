import { mulberry32 } from "./rng.js";

export const MapSize = {
  SMALL: 24,
  MEDIUM: 48,
  LARGE: 72
};

export function createInitialWorld({ seed, mapSize, mapData, totalPlayers = 12, playerDistrict = 12 }){
    const total = Math.max(2, Math.min(48, Number(totalPlayers) || 12));
  const npcCount = total - 1;

  // District distribution: 12 -> 1 per district; 24 -> 2 per district; 48 -> 4 per district.
  const perDistrict = Math.max(1, Math.floor(total / 12));
  const rng = mulberry32(seed);

  const pool = [];
  for(let d=1; d<=12; d++){
    for(let k=0; k<perDistrict; k++) pool.push(d);
  }

  // Remove one slot for the player's chosen district.
  const pd = Math.min(12, Math.max(1, Number(playerDistrict) || 12));
  const idx = pool.indexOf(pd);
  if(idx !== -1) pool.splice(idx, 1);

  // Shuffle pool deterministically
  for(let i=pool.length-1; i>0; i--){
    const j = Math.floor(rng.next() * (i+1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }

  const npcs = {};
  for (let i = 1; i <= npcCount; i++){
    const id = `npc_${i}`;
    npcs[id] = {
      id,
      name: `Tribute ${i}`,
      district: pool[i-1] ?? rng.int(1,12),
      areaId: 1,
      hp: 100,
      fp: 70,
      status: [],
      inventory: {},
      memory: { goal: "survive" }
    };
  }

  return {
    meta: {
      version: 1,
      seed,
      day: 1,
      mapSize,
      totalPlayers: total
    },
    map: mapData, // { areasById, adjById, uiGeom }
    entities: {
      player: {
        id: "player",
        name: "Player",
        district: pd,
        areaId: 1,
        hp: 100,
        fp: 70,
        status: [],
        inventory: {},
        memory: {}
      },
      npcs
    },
    flags: {
      visitedAreas: [1],
      closedAreas: []
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
