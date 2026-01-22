import { mulberry32 } from "./rng.js";

export const MapSize = {
  SMALL: 24,
  MEDIUM: 48,
  LARGE: 72
};



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
  const a1 = world.map?.areasById?.["1"];
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
