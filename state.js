import { mulberry32 } from "./rng.js";

export const MapSize = {
  SMALL: 24,
  MEDIUM: 48,
  LARGE: 72
};

export function createInitialWorld({ seed, mapSize, mapData, totalPlayers = 12, playerDistrict = 12 }){
  const total = Math.max(2, Math.min(48, Number(totalPlayers) || 12));
  const npcCount = total - 1;

  const perDistrict = Math.max(1, Math.floor(total / 12));
  const rng = mulberry32(seed);

  const pool = [];
  for(let d=1; d<=12; d++){
    for(let k=0; k<perDistrict; k++) pool.push(d);
  }
  const pd = Math.min(12, Math.max(1, Number(playerDistrict) || 12));
  const idx = pool.indexOf(pd);
  if(idx !== -1) pool.splice(idx, 1);

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
      kills: 0,
      attrs: randomAttrs7(rng),
      status: [],
      inventory: {},
      memory: { goal: "survive" }
    };
  }

  const world = {
    meta: {
      version: 1,
      seed,
      day: 1,
      mapSize,
      totalPlayers: total
    },
    map: mapData.map,
    entities: {
      player: {
        id: "player",
        name: "Player",
        district: pd,
        areaId: 1,
        hp: 100,
        fp: 70,
        kills: 0,
        attrs: { F: 3, D: 2, P: 2 },
        status: [],
        inventory: {},
        memory: { goal: "survive" }
      },
      npcs
    },
    systems: {
      combat: { declarations: {} }
    },
    flags: {
      visitedAreas: [1],
      closedAreas: []
    },
    log: {
      days: []
    },
    replay: {
      playerActionsByDay: []
    }
  };

  // Ensure area 1 is Cornucopia biome
  const a1 = world.map.areasById?.["1"];
  if(a1){
    a1.biome = "Cornucopia";
  }

  return world;
}

function randomAttrs7(rng){
  // random non-negative ints summing to 7
  let F = rng.int(0,7);
  let D = rng.int(0,7-F);
  let P = 7 - F - D;
  // shuffle distribution a bit
  const arr = [F,D,P];
  for(let i=2;i>0;i--){
    const j = Math.floor(rng.next() * (i+1));
    const t = arr[i]; arr[i]=arr[j]; arr[j]=t;
  }
  return { F: arr[0], D: arr[1], P: arr[2] };
}

export function cloneWorld(world){
  return JSON.parse(JSON.stringify(world));
}
