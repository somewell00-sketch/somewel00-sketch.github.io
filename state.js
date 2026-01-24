import { mulberry32 } from "./rng.js";

export const MapSize = {
  SMALL: 24,
  MEDIUM: 48,
  LARGE: 72
};

function createEmptyInventory(){
  return {
    // items: [{ defId, qty, usesLeft, meta }]
    items: [],
    equipped: {
      weaponDefId: null,
      defenseDefId: null
    }
  };
}



const DISTRICT_NAMES = {
  "1": {
    first: [
      "Amira",
      "Zahra",
      "Soraya",
      "Nayeli",
      "Samira",
      "Laila",
      "Inara",
      "Yara",
      "Aisha",
      "Zuleika",
      "Farah",
      "Malika",
      "Esmeria",
      "Aziza",
      "Kalila",
      "Naima",
      "Sahar",
      "Mireya",
      "Jasira",
      "Alina"
    ],
    last: [
      "Zahiri",
      "Amarat",
      "Qalir",
      "Samheen",
      "Dorai",
      "Kalem",
      "Azhar",
      "Lumari",
      "Sahal",
      "Mireth",
      "Alqen",
      "Raziq",
      "Belanir",
      "Yashim",
      "Kareth",
      "Inzari",
      "Solune",
      "Fariel",
      "Naqem",
      "Jassur"
    ]
  },
  "2": {
    first: [
      "Aresia",
      "Kael",
      "Dario",
      "Tarek",
      "Malik",
      "Rayan",
      "Idris",
      "Basil",
      "Oren",
      "Samir",
      "Kadir",
      "Enzo",
      "Nadir",
      "Ilias",
      "Omar",
      "Farid",
      "Zahir",
      "Lucan",
      "Adil",
      "Arman"
    ],
    last: [
      "Kadar",
      "Barak",
      "Tharun",
      "Malrek",
      "Qorin",
      "Zaim",
      "Dorsha",
      "Rakhim",
      "Talvek",
      "Ashkar",
      "Borun",
      "Hadrim",
      "Kalzor",
      "Nemat",
      "Yorgal",
      "Fashir",
      "Kurad",
      "Zorim",
      "Ardash",
      "Belkar"
    ]
  },
  "3": {
    first: [
      "Neo",
      "Ivo",
      "Elia",
      "Noa",
      "Soren",
      "Tao",
      "Lin",
      "Kai",
      "Riku",
      "Zev",
      "Milo",
      "Arun",
      "Ezra",
      "Yuki",
      "Aiko",
      "Nilo",
      "Remi",
      "Io",
      "Sami",
      "Lior"
    ],
    last: [
      "Lin",
      "Var",
      "Solk",
      "Nema",
      "Tesh",
      "Kiro",
      "Anix",
      "Rell",
      "Ikan",
      "Mova",
      "Zyn",
      "Kesh",
      "Ulon",
      "Pher",
      "Yuto",
      "Sarn",
      "Oxi",
      "Leth",
      "Kova",
      "Tain"
    ]
  },
  "4": {
    first: [
      "Nerina",
      "Kaiara",
      "Moana",
      "Luan",
      "Yumi",
      "Nerea",
      "Amani",
      "Talia",
      "Maris",
      "Sirah",
      "Iara",
      "Calan",
      "Miro",
      "Nael",
      "Selka",
      "Rhea",
      "Anahí",
      "Sumi",
      "Dilan",
      "Aris"
    ],
    last: [
      "Maru",
      "Narel",
      "Kalua",
      "Senda",
      "Aroha",
      "Lemor",
      "Iqari",
      "Tavek",
      "Yorin",
      "Selu",
      "Amaru",
      "Koral",
      "Nemi",
      "Ulani",
      "Varek",
      "Moeri",
      "Talua",
      "Iskai",
      "Ruma",
      "Kaien"
    ]
  },
  "5": {
    first: [
      "Luxa",
      "Elen",
      "Zain",
      "Kira",
      "Solan",
      "Iri",
      "Nox",
      "Aven",
      "Ciro",
      "Anil",
      "Rumi",
      "Vega",
      "Asha",
      "Orion",
      "Luma",
      "Eron",
      "Sena",
      "Timo",
      "Kali",
      "Ylen"
    ],
    last: [
      "Zahir",
      "Lumen",
      "Ankor",
      "Keshan",
      "Virek",
      "Solari",
      "Yelem",
      "Arqan",
      "Tivar",
      "Helun",
      "Qiro",
      "Satek",
      "Nural",
      "Ixon",
      "Belor",
      "Rasen",
      "Kadin",
      "Elzar",
      "Orel",
      "Syk"
    ]
  },
  "6": {
    first: [
      "Ruta",
      "Mavi",
      "Iker",
      "Nilo",
      "Dara",
      "Jano",
      "Kemi",
      "Lior",
      "Enai",
      "Rami",
      "Olin",
      "Zola",
      "Teo",
      "Sira",
      "Yara",
      "Arel",
      "Noem",
      "Pavi",
      "Kato",
      "Elun"
    ],
    last: [
      "Rava",
      "Nomu",
      "Kair",
      "Tarek",
      "Ulto",
      "Sivan",
      "Jorel",
      "Pash",
      "Nexo",
      "Odan",
      "Yarek",
      "Vilo",
      "Enra",
      "Zair",
      "Kodo",
      "Luma",
      "Rish",
      "Toma",
      "Aven",
      "Deru"
    ]
  },
  "7": {
    first: [
      "Cedra",
      "Ilex",
      "Rowan",
      "Silan",
      "Tora",
      "Ligna",
      "Bira",
      "Yvon",
      "Arvo",
      "Nara",
      "Olin",
      "Faye",
      "Timo",
      "Elow",
      "Suri",
      "Kaori",
      "Brisa",
      "Iara",
      "Lume",
      "Viro"
    ],
    last: [
      "Arvo",
      "Lignar",
      "Koru",
      "Temba",
      "Yari",
      "Selan",
      "Borel",
      "Noki",
      "Iram",
      "Farel",
      "Tika",
      "Oren",
      "Silu",
      "Maku",
      "Kaori",
      "Vesh",
      "Rokan",
      "Elun",
      "Pira",
      "Naru"
    ]
  },
  "8": {
    first: [
      "Seda",
      "Lila",
      "Yuna",
      "Mire",
      "Anisa",
      "Tessa",
      "Imani",
      "Rina",
      "Soli",
      "Nema",
      "Cora",
      "Avel",
      "Lina",
      "Sira",
      "Malu",
      "Kesi",
      "Zira",
      "Asha",
      "Meli",
      "Ylen"
    ],
    last: [
      "Sari",
      "Luma",
      "Anan",
      "Tilu",
      "Kesi",
      "Miraq",
      "Zena",
      "Rinu",
      "Avel",
      "Kora",
      "Yani",
      "Meli",
      "Soli",
      "Nira",
      "Pashu",
      "Esha",
      "Tami",
      "Ravel",
      "Ina",
      "Kalu"
    ]
  },
  "9": {
    first: [
      "Ciro",
      "Mila",
      "Jara",
      "Enai",
      "Olin",
      "Sima",
      "Kavi",
      "Ruel",
      "Dara",
      "Noem",
      "Iara",
      "Tavi",
      "Luma",
      "Arel",
      "Sami",
      "Yori",
      "Bina",
      "Elan",
      "Nuri",
      "Sol"
    ],
    last: [
      "Tera",
      "Amil",
      "Kavi",
      "Selo",
      "Jara",
      "Noma",
      "Ruma",
      "Padi",
      "Elan",
      "Kora",
      "Bani",
      "Suma",
      "Tavi",
      "Aru",
      "Deka",
      "Muna",
      "Sori",
      "Lani",
      "Omi",
      "Hela"
    ]
  },
  "10": {
    first: [
      "Tau",
      "Brava",
      "Ivo",
      "Lobo",
      "Nara",
      "Kora",
      "Juno",
      "Aric",
      "Madu",
      "Taro",
      "Bela",
      "Kito",
      "Rumi",
      "Sela",
      "Zeca",
      "Duna",
      "Bori",
      "Cora",
      "Iman",
      "Vela"
    ],
    last: [
      "Tau",
      "Brak",
      "Selo",
      "Kora",
      "Rumo",
      "Daro",
      "Belaq",
      "Vanu",
      "Kesh",
      "Iram",
      "Lodo",
      "Nara",
      "Tamu",
      "Orek",
      "Bori",
      "Sika",
      "Garo",
      "Paku",
      "Madu",
      "Reka"
    ]
  },
  "11": {
    first: [
      "Amadou",
      "Ayo",
      "Zuri",
      "Kofi",
      "Dandara",
      "Nala",
      "Sefu",
      "Imani",
      "Ayana",
      "Binta",
      "Kaleb",
      "Jamila",
      "Omari",
      "Lemba",
      "Amina",
      "Tafari",
      "Nuru",
      "Sade",
      "Kwame",
      "Zola"
    ],
    last: [
      "Okoye",
      "Dlamin",
      "Mbala",
      "Quila",
      "Nzuri",
      "Abeni",
      "Kalunga",
      "Tunde",
      "Sanko",
      "Amari",
      "Zemba",
      "Lemba",
      "Makori",
      "Ayode",
      "Jafari",
      "Bantu",
      "Sefu",
      "Nago",
      "Tola",
      "Kintu"
    ]
  },
  "12": {
    first: [
      "Cinza",
      "Lio",
      "Bram",
      "Iva",
      "Nox",
      "Doro",
      "Kela",
      "Sila",
      "Jax",
      "Rena",
      "Vico",
      "Marn",
      "Tesa",
      "Orel",
      "Fira",
      "Ciro",
      "Lume",
      "Noa",
      "Eron",
      "Kali"
    ],
    last: [
      "Kora",
      "Ashen",
      "Nox",
      "Brum",
      "Sile",
      "Daro",
      "Lume",
      "Kren",
      "Marn",
      "Orel",
      "Tesk",
      "Fira",
      "Gorn",
      "Reka",
      "Zim",
      "Cavo",
      "Nira",
      "Vesh",
      "Kalo",
      "Drim"
    ]
  }
};

function generateTributeName(district, rng){
  const pool = DISTRICT_NAMES[district];
  if (!pool) return "Unknown Tribute";
  const first = pool.first[Math.floor(rng.next() * pool.first.length)];
  const last = pool.last[Math.floor(rng.next() * pool.last.length)];
  return `${first} ${last}`;
}

export function createInitialWorld({ seed, mapSize, mapData, totalPlayers = 12, playerDistrict = 12, playerAttrs = null }){
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
  const district = pool[i-1] ?? rng.int(1,12);

  npcs[id] = {
    id,
    name: generateTributeName(district, rng),
    district,
    areaId: 1,
    hp: 100,
    fp: 70,
    kills: 0,
    attrs: randomAttrs7(rng),
    status: [],
    inventory: createEmptyInventory(),
    memory: { goal: "survive" }
  };
}

  const resolvedPlayerAttrs = normalizeAttrs7(playerAttrs) || { F: 3, D: 2, P: 2 };

  const world = {
    meta: {
      version: 1,
      seed,
      day: 1,
      mapSize,
      totalPlayers: total
    },
    map: mapData,
    entities: {
      player: {
        id: "player",
        name: "Player",
        district: pd,
        areaId: 1,
        hp: 100,
        fp: 70,
        kills: 0,
        attrs: resolvedPlayerAttrs,
        status: [],
        inventory: createEmptyInventory(),
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
  const a1 = world.map?.areasById?.["1"];
  if(a1){
    a1.biome = "Cornucopia";
  }

  // --- Food availability (FP system) ---
  // Areas with food automatically restore FP to 70 at the start of the day.
  // Cornucopia always has food. Other areas are assigned deterministically by seed.
  for(const a of Object.values(world.map?.areasById || {})){
    if(!a) continue;
    if(a.id === 1){
      a.hasFood = true;
      continue;
    }
    const biome = String(a.biome || "").toLowerCase();
    let chance = 0.18;
    if(biome.includes("desert") || biome.includes("glacier")) chance = 0.04;
    if(biome.includes("tundra") || biome.includes("mountain")) chance = 0.08;
    if(biome.includes("lake") || biome.includes("swamp") || biome.includes("jungle") || biome.includes("forest")) chance = 0.26;
    a.hasFood = rng.next() < chance;
  }

  // Initialize ground items for all areas
  for(const a of Object.values(world.map?.areasById || {})){
    if(!a) continue;
    if(!Array.isArray(a.groundItems)) a.groundItems = [];
  }


  // Initialize threats / active elements / finite resources (special elements)
  initAreaThreatsElementsAndResources(world, rng);

  // Cornucopia starting loot: backpacks = 2/3 of total players
  // Each backpack contains 2–3 items.
  const backpacks = Math.max(1, Math.floor((total * 2) / 3));
  const weaponsPool = ["sword","club","spear","trident","axe","wand","knife","dagger","bow","blowgun","grenade","shield","camouflage","flask"];

  for(let i=0;i<backpacks;i++){
    a1.groundItems.push({ defId: "backpack", qty: 1, meta: { seedTag: `bp_${i}` } });
  }
  // A few loose items too
  const loose = Math.max(3, Math.floor(total / 2));
  for(let i=0;i<loose;i++){
    const pick = weaponsPool[Math.floor(rng.next() * weaponsPool.length)];
    const qty = (pick === "knife" || pick === "dagger") ? (1 + Math.floor(rng.next()*3)) : 1;
    const meta = {};
    if(pick === "flask"){
      // Pre-roll what the flask is. Revealed only when consumed.
      meta.hiddenKind = (rng.next() < 0.5) ? "medicine" : "poison";
    }
    a1.groundItems.push({ defId: pick, qty, meta });
  }

  return world;
}


// --- Threats / Elements / Resources (consolidated system) ---
const BIOME_LIST = [
  "glacier","tundra","mountain",
  "desert","caatinga","savanna",
  "plains","woods","forest","jungle",
  "fairy","swamp","lake","industrial"
];

const CREATURE_GROUPS = {
  cold: [
    { name:"Wolf-Bear", dmgMin:15, dmgMax:25 },
    { name:"Iron Eagle", dmgMin:10, dmgMax:18 },
    { name:"Thermal Serpent", dmgMin:8, dmgMax:12 },
    { name:"Mimetic Yeti", dmgMin:20, dmgMax:30 }
  ],
  arid: [
    { name:"Whip Scorpion", dmgMin:12, dmgMax:20 },
    { name:"Bomb Armadillo", dmgMin:25, dmgMax:35 },
    { name:"Vigilant Vulture", dmgMin:5, dmgMax:10 },
    { name:"Glass Lizard", dmgMin:10, dmgMax:15 }
  ],
  green: [
    { name:"Tracker Wasp", dmgMin:8, dmgMax:14 },
    { name:"Shadow Panther", dmgMin:18, dmgMax:28 },
    { name:"Howler Monkey", dmgMin:5, dmgMax:12 },
    { name:"Thorn Wolf", dmgMin:12, dmgMax:22 }
  ],
  special: [
    { name:"Giant Bullfrog", dmgMin:15, dmgMax:20 },
    { name:"Blade Dragonfly", dmgMin:10, dmgMax:16 },
    { name:"Mechanical Dog", dmgMin:20, dmgMax:30 },
    { name:"Pulse Eel", dmgMin:15, dmgMax:25 }
  ]
};

const BIOME_TO_GROUP = {
  glacier: "cold", tundra: "cold", mountain: "cold",
  desert: "arid", caatinga: "arid", savanna: "arid",
  plains: "green", woods: "green", forest: "green", jungle: "green",
  fairy: "special", swamp: "special", lake: "special", industrial: "special"
};

const CREATURE_MODIFIERS = [
  { kind:"Brutal", type:"damage_add", value:10 },
  { kind:"Ferocious", type:"damage_add", value:5 },
  { kind:"Cyborg", type:"damage_add", value:8 },
  { kind:"Alpha", type:"damage_mul", value:1.5 },
  { kind:"Savage", type:"damage_add", value:12 },

  { kind:"Poisonous", type:"poison" },
  { kind:"Radioactive", type:"poison" },
  { kind:"Venomous", type:"poison" },
  { kind:"Toxic", type:"poison" },
  { kind:"Contaminated", type:"poison" },

  { kind:"Hungry", type:"flavor" },
  { kind:"Wandering", type:"flavor" },
  { kind:"Ancient", type:"flavor" },
  { kind:"Blind", type:"flavor" },
  { kind:"Giant", type:"flavor" },
  { kind:"Wounded", type:"flavor" },
  { kind:"Solitary", type:"flavor" },
  { kind:"Legendary", type:"flavor" },
  { kind:"Scary", type:"flavor" },
  { kind:"Slow", type:"flavor" }
];

function pickCreatureForBiome(rng, biome){
  const key = BIOME_TO_GROUP[String(biome || "").toLowerCase()] || "green";
  const pool = CREATURE_GROUPS[key] || CREATURE_GROUPS.green;
  return pool[Math.floor(rng.next() * pool.length)];
}

function maybePickCreatureModifier(rng){
  if(rng.next() > 0.35) return null; // not all creatures get modifiers
  return CREATURE_MODIFIERS[Math.floor(rng.next() * CREATURE_MODIFIERS.length)];
}

function initAreaThreatsElementsAndResources(world, rng){
  for(const a of Object.values(world.map?.areasById || {})){
    if(!a) continue;

    // Threat class
    const b = String(a.biome || "").toLowerCase();
    const threatening = !["plains","woods"].includes(b) && a.id !== 1;
    a.threatClass = threatening ? "threatening" : "neutral";

    // Threat pool (simple initial version, biome-driven)
    // Weighting is represented by duplicates in the array.
    if(threatening){
      a.threatPool = ["creature_attack","creature_attack","hazard","hazard","hazard"];
    } else {
      a.threatPool = ["hazard"];
    }

    // Active elements list (persistents)
    if(!Array.isArray(a.activeElements)) a.activeElements = [];
    a._rewardSpawned = false;

    // 20% chance: special element (creature / rare resource / favorable structure placeholder)
    if(a.id !== 1 && rng.next() < 0.20){
      const roll = rng.next();
      if(roll < 0.55){
        const base = pickCreatureForBiome(rng, b);
        const mod = maybePickCreatureModifier(rng);
        a.activeElements.push({
          kind: "creature",
          id: `cre_${a.id}_${Math.floor(rng.next()*1e9)}`,
          name: base.name,
          dmgMin: base.dmgMin,
          dmgMax: base.dmgMax,
          modifier: mod ? mod.kind : null,
          modifierType: mod ? mod.type : null,
          modifierValue: mod ? mod.value ?? null : null
        });
      } else if(roll < 0.80){
        // Rare resource spawn as a real ground item (finite)
        a.groundItems = Array.isArray(a.groundItems) ? a.groundItems : [];
        a.groundItems.push({ defId: "capital_ration", qty: 1, meta: { special: true } });
        a.activeElements.push({ kind:"resource", id:`res_${a.id}_${Math.floor(rng.next()*1e9)}`, name:"Capital Ration" });
      } else {
        // Favorable structure placeholder (kept as active element; effects can be added later)
        const options = [
          { name:"Safe Cave", biomeOk:["mountain","glacier"] },
          { name:"Oasis", biomeOk:["desert","caatinga"] },
          { name:"Fruit Tree", biomeOk:["jungle","forest"] },
          { name:"Abandoned Industrial Shelter", biomeOk:["industrial"] },
          { name:"Crystal Spring", biomeOk:["fairy"] }
        ];
        const pick = options[Math.floor(rng.next() * options.length)];
        a.activeElements.push({ kind:"structure", id:`str_${a.id}_${Math.floor(rng.next()*1e9)}`, name: pick.name });
      }
    }
  }
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
  return {
    turnDraft: null, F: arr[0], D: arr[1], P: arr[2] };
}

function normalizeAttrs7(input){
  if(!input) return null;
  const F = Number(input.F);
  const D = Number(input.D);
  const P = Number(input.P);
  if(!Number.isFinite(F) || !Number.isFinite(D) || !Number.isFinite(P)) return null;
  const f = Math.max(0, Math.floor(F));
  const d = Math.max(0, Math.floor(D));
  const p = Math.max(0, Math.floor(P));
  if(f + d + p !== 7) return null;
  return { F: f, D: d, P: p };
}

export function cloneWorld(world){
  return JSON.parse(JSON.stringify(world));
}
