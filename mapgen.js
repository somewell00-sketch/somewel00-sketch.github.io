import { mulberry32 } from "./rng.js";

const polylabelFn =
  (typeof window.polylabel === "function") ? window.polylabel :
  (window.polylabel && typeof window.polylabel.default === "function") ? window.polylabel.default :
  null;

function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function dist(ax,ay,bx,by){ const dx=ax-bx, dy=ay-by; return Math.sqrt(dx*dx+dy*dy); }

function pointInPoly(x,y, poly){
  let inside = false;
  for(let i=0,j=poly.length-1; i<poly.length; j=i++){
    const xi=poly[i][0], yi=poly[i][1];
    const xj=poly[j][0], yj=poly[j][1];
    const intersect = ((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi+1e-9) + xi);
    if(intersect) inside = !inside;
  }
  return inside;
}

function pointToSegDist(px, py, ax, ay, bx, by){
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx*abx + aby*aby;
  let t = ab2 ? (apx*abx + apy*aby)/ab2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx, dy = py - cy;
  return Math.sqrt(dx*dx + dy*dy);
}

function inradiusAtPoint(poly, x, y){
  let minD = Infinity;
  for(let i=0, j=poly.length-1; i<poly.length; j=i++){
    const ax = poly[j][0], ay = poly[j][1];
    const bx = poly[i][0], by = poly[i][1];
    const d = pointToSegDist(x, y, ax, ay, bx, by);
    if (d < minD) minD = d;
  }
  return minD;
}

function polyCenter(poly){
  if (polylabelFn){
    const p = polylabelFn([poly], 1.0);
    return { x: p[0], y: p[1], r: inradiusAtPoint(poly, p[0], p[1]) };
  }
  return { x: poly[0][0], y: poly[0][1], r: 10 };
}

function makeNoise(rng){
  const grid = new Map();
  const key = (x,y)=> `${x},${y}`;
  function randGrid(ix,iy){
    const k = key(ix,iy);
    if(!grid.has(k)) grid.set(k, rng.next());
    return grid.get(k);
  }
  const fade = t => t*t*(3-2*t);
  const lerp = (a,b,t)=> a + (b-a)*t;
  return function noise(x,y){
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const a = randGrid(ix,iy);
    const b = randGrid(ix+1,iy);
    const c = randGrid(ix,iy+1);
    const d = randGrid(ix+1,iy+1);
    const u = fade(fx), v = fade(fy);
    return lerp(lerp(a,b,u), lerp(c,d,u), v);
  }
}

function fbm(noise, x, y, octaves=4, lacunarity=2.0, gain=0.5){
  let amp = 1.0, freq = 1.0, sum = 0.0, norm = 0.0;
  for(let i=0;i<octaves;i++){
    sum += amp * (noise(x*freq, y*freq) - 0.5);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return (sum / (norm || 1)) * 0.5 + 0.5;
}

function computeFeatures(x, y, noiseSlow, noiseFast, W, H, CX, CY, blobRadius){
  const radial = clamp01(dist(x,y,CX,CY) / blobRadius);
  const lat = y / H;

  const nT = fbm(noiseSlow, x*0.0032 + 11, y*0.0032 + 11, 4, 2.0, 0.55);
  const nM = fbm(noiseSlow, x*0.0030 + 77, y*0.0030 + 77, 4, 2.0, 0.55);
  const nA = fbm(noiseSlow, x*0.0040 + 33, y*0.0040 + 33, 5, 2.1, 0.52);

  const nMagic = fbm(noiseFast, x*0.010 + 210, y*0.010 + 210, 3, 2.0, 0.50);
  const nUrban = fbm(noiseFast, x*0.011 + 510, y*0.011 + 510, 3, 2.0, 0.50);
  const nLake  = fbm(noiseSlow, x*0.006 + 120, y*0.006 + 120, 4, 2.0, 0.55);
  const nSwamp = fbm(noiseSlow, x*0.006 + 320, y*0.006 + 320, 4, 2.0, 0.55);

  let alt = (nA * 0.80 + (1 - radial) * 0.35) - radial * 0.15;
  alt = clamp01(alt);

  let temp = (1 - lat) * 0.72 + nT * 0.35 - alt * 0.55;
  temp = clamp01(temp);

  let moist = nM * 0.85 + (1 - radial) * 0.10 - radial * 0.08;
  moist = clamp01(moist);

  const lowland = 1 - alt;

  let lake = 0;
  if (radial < 0.93) {
    lake = clamp01((nLake - 0.55) * 2.2) * clamp01((lowland - 0.55) * 2.0) * clamp01((moist - 0.40) * 1.6);
  }

  let swampy = 0;
  if (radial < 0.96) {
    swampy = clamp01((nSwamp - 0.50) * 2.0) * clamp01((lowland - 0.45) * 1.8) * clamp01((moist - 0.55) * 2.0);
    swampy *= (1 - lake*0.8);
  }

  let urban = clamp01((nUrban - 0.62) * 2.3) * clamp01((1 - radial - 0.05) * 1.4 + 0.4);
  let magic = clamp01((nMagic - 0.60) * 2.2) * clamp01((1 - urban) * 1.2);

  return { temp, moist, alt, magic, urban, lake, swampy, lat, radial };
}

const BIOMES = [
  "glacier","tundra","mountain",
  "desert","caatinga","savanna",
  "plains","woods","forest","jungle",
  "fairy","swamp","lake","industrial"
];

const QUOTAS = {
  glacier:    { min: 1, max: 8 },
  tundra:     { min: 1, max: 8 },
  mountain:   { min: 2, max: 12 },
  desert:     { min: 2, max: 12 },
  caatinga:   { min: 2, max: 12 },
  savanna:    { min: 1, max: 10 },
  plains:     { min: 2, max: 18 },
  woods:      { min: 2, max: 14 },
  forest:     { min: 2, max: 14 },
  jungle:     { min: 1, max: 12 },
  fairy:      { min: 1, max: 8 },
  swamp:      { min: 1, max: 10 },
  lake:       { min: 1, max: 10 },
  industrial: { min: 1, max: 8 }
};

function biomeScores(f){
  const t = f.temp, m = f.moist, a = f.alt, g = f.magic, u = f.urban;
  const lk = f.lake, sw = f.swampy;

  const cold = clamp01((0.40 - t) / 0.40);
  const hot  = clamp01((t - 0.50) / 0.50);
  const dry  = clamp01((0.45 - m) / 0.45);
  const wet  = clamp01((m - 0.50) / 0.50);
  const high = clamp01((a - 0.55) / 0.45);

  return {
    lake:        lk * (0.7 + wet*0.3),
    swamp:       sw * (0.6 + wet*0.4),
    industrial:  u * (0.7 + (1 - m)*0.3) * (0.6 + (1 - g)*0.4),
    fairy:       g * (0.7 + wet*0.3) * (0.7 + (1 - u)*0.3),
    glacier:     cold * (0.6 + high*0.4),
    tundra:      cold * (0.7 + (1 - high)*0.3),
    mountain:    high * (0.7 + (1 - wet)*0.3),
    jungle:      wet * hot * (0.7 + (1 - u)*0.3),
    forest:      wet * (1 - hot*0.3) * (0.7 + (1 - u)*0.3),
    woods:       (0.6*wet + 0.4*(1-dry)) * (0.6 + (1 - u)*0.4) * (1 - hot*0.25),
    plains:      (1 - dry*0.6) * (1 - wet*0.4) * (1 - high*0.4) * (0.7 + (1 - u)*0.3),
    savanna:     hot * (1 - wet*0.6),
    caatinga:    hot * dry,
    desert:      hot * dry * (0.6 + (1 - wet)*0.4)
  };
}

function pickBiomeByScore(scores, rng, allowed=null){
  let sum = 0;
  const items = [];
  for (const [k,v] of Object.entries(scores)){
    if (allowed && !allowed.has(k)) continue;
    const w = Math.max(0.00001, v);
    const ww = Math.pow(w, 1.35);
    items.push([k, ww]);
    sum += ww;
  }
  let r = rng.next() * sum;
  for (const [k,w] of items){
    r -= w;
    if (r <= 0) return k;
  }
  return items.length ? items[items.length-1][0] : "plains";
}

function bfsOrderFromOne(cells, adj){
  const ids = new Set(cells.map(c => c.id));
  const start = ids.has(1) ? 1 : (cells[0]?.id ?? 1);

  const order = [];
  const dist = new Map();
  const q = [start];
  dist.set(start, 0);

  let qi = 0;
  while(qi < q.length){
    const v = q[qi++];
    order.push(v);
    const neigh = adj.get(v);
    if(!neigh) continue;
    const neighSorted = Array.from(neigh).sort((a,b)=>a-b);
    for(const n of neighSorted){
      if(!ids.has(n)) continue;
      if(dist.has(n)) continue;
      dist.set(n, dist.get(v) + 1);
      q.push(n);
    }
  }

  for(const c of cells){
    if(!dist.has(c.id)){
      dist.set(c.id, Infinity);
      order.push(c.id);
    }
  }
  return { order, start };
}

function renumberCellsByBFS(cells, adj){
  const { order } = bfsOrderFromOne(cells, adj);
  const idMap = new Map();
  for(let i=0;i<order.length;i++) idMap.set(order[i], i+1);

  for(const cell of cells){
    cell.id = idMap.get(cell.id) ?? cell.id;
  }

  const newAdj = new Map();
  for(const [oldId, neigh] of adj.entries()){
    const newId = idMap.get(oldId);
    if(!newId) continue;
    const set = new Set();
    for(const nOld of neigh){
      const nNew = idMap.get(nOld);
      if(nNew) set.add(nNew);
    }
    newAdj.set(newId, set);
  }

  return { cells, adj: newAdj, idMap };
}

// --- Paletas + nomes PT (UI usa) ---
export const BIOME_PT = {
  glacier: "Geleira",
  tundra: "Tundra",
  mountain: "Montanha",
  desert: "Deserto",
  caatinga: "Caatinga",
  savanna: "Savana",
  plains: "Planície",
  woods: "Bosque",
  forest: "Floresta",
  jungle: "Selva",
  fairy: "Bosque Fada",
  swamp: "Pântano",
  lake: "Lago",
  industrial: "Área Industrial"


// --- Arena titles (UI) ---
export const ARENA_TITLES = {
  regular: "Survival Arena",

  glacier: "Himani Arena",
  tundra: "Kunlun Arena",
  mountain: "Orqo Arena",
  desert: "Sahari Arena",
  caatinga: "Baraúna Arena",
  savanna: "Savanaari Arena",
  plains: "Pampaari Arena",
  woods: "Aranya Arena",
  forest: "Ka’aguay Arena",
  jungle: "Yvapurũ Arena",
  fairy: "Tianxian Arena",
  swamp: "Pantanari Arena",
  lake: "Mayu Arena",
  industrial: "Karkhan Arena"
};

};

export const PALETTES = [
  {
    ocean: "#070813",
    biomes: {
      glacier: ["#f7fbff","#eef6ff","#e4f1ff"],
      tundra:  ["#e9efe8","#dbe5d8","#cfdccc"],
      mountain:["#a7b3be","#8f9eac","#7a8895"],
      desert:  ["#e1c48b","#d7b676","#c9a760"],
      caatinga:["#cdbb7b","#bfae6c","#b09f5e"],
      savanna: ["#c7c06a","#bdb45a","#b1a84a"],
      plains:  ["#8fc56d","#7dbd5c","#6bb34a"],
      woods:   ["#4c8f55","#3f7e49","#356c3f"],
      forest:  ["#3f9b55","#2f8646","#25713a"],
      jungle:  ["#1f8f5a","#167a4c","#105f3b"],
      fairy:   ["#5aa06f","#6fb2a8","#8c6fd0"],
      swamp:   ["#2d6b5a","#235c4c","#1a4d3f"],
      lake:    ["#2a6fb0","#225f98","#1b5182"],
      industrial:["#7b7f8a","#656a76","#505662"]
    }
  }
];

function pick(arr, rng){ return arr[Math.floor(rng.next()*arr.length)]; }

function colorForBiome(biome, rng, paletteIndex){
  const pal = PALETTES[paletteIndex];
  const list = pal.biomes[biome] || pal.biomes.plains;
  return pick(list, rng);
}

function cellAtPoint(cells, x, y){
  for (let i = cells.length - 1; i >= 0; i--){
    const cell = cells[i];
    if (pointInPoly(x, y, cell.poly)) return cell;
  }
  return null;
}

export function generateMapData({ seed, regions, width=820, height=820, paletteIndex=0 }){
  const rng = mulberry32(seed);

  // 20% chance de arena temática
  const themed = rng.next() < 0.20;
  const dominantBiome = themed ? rng.pick(BIOMES) : null;

  const W = width, H = height;
  const CX = W/2, CY = H/2;
  const blobRadius = 290;
  const padding = 40;

  const noiseSlow = makeNoise(mulberry32(seed ^ 0x9e3779b9));
  const noiseFast = makeNoise(mulberry32(seed ^ 0x85ebca6b));

  // blob
  const blob = [];
  const steps = 95;
  const blobJitter = 0.32;

  for(let i=0;i<steps;i++){
    const t = (i/steps) * Math.PI*2;
    const wave =
      Math.sin(t*2 + rng.next()*0.5)*0.18 +
      Math.sin(t*3 + rng.next()*0.5)*0.12 +
      Math.sin(t*5 + rng.next()*0.5)*0.08;

    const nn = (noiseSlow(Math.cos(t)*2 + 10, Math.sin(t)*2 + 10) - 0.5);
    const rr = blobRadius * (1 + wave + nn*blobJitter);
    blob.push([CX + Math.cos(t)*rr, CY + Math.sin(t)*rr]);
  }

  // points inside
  const pts = [];
  let tries = 0;
  while(pts.length < regions && tries < 500000){
    tries++;
    const x = padding + rng.next()*(W-padding*2);
    const y = padding + rng.next()*(H-padding*2);
    if(pointInPoly(x,y,blob)) pts.push([x,y]);
  }

  const delaunay = d3.Delaunay.from(pts);
  const vor = delaunay.voronoi([0,0,W,H]);

  let cells = [];
  for(let i=0;i<pts.length;i++){
    const poly = vor.cellPolygon(i);
    if(!poly) continue;

    const id = i + 1;
    const center = polyCenter(poly);
    const features = computeFeatures(center.x, center.y, noiseSlow, noiseFast, W, H, CX, CY, blobRadius);

    cells.push({
      id,
      poly,
      center,
      features,
      biome: "plains",
      fillColor: "#777",
      hasWater: false
    });
  }

  // adjacency
  const existing = new Set(cells.map(c => c.id));
  let adj = new Map();
  for(let i=0;i<pts.length;i++){
    const id = i + 1;
    if(!existing.has(id)) continue;
    const set = new Set();
    for(const n of delaunay.neighbors(i)){
      const nid = n + 1;
      if(existing.has(nid)) set.add(nid);
    }
    adj.set(id, set);
  }


  // themed arena: força ~75% das áreas (exceto a #1) para o bioma dominante
  let forcedDominantIds = null;
  if (themed && dominantBiome){
    const total = cells.length;
    const targetCount = Math.floor(total * 0.75);

    const scored = cells
      .filter(c => c.id !== 1)
      .map(c => {
        const sc = biomeScores(c.features);
        return { id: c.id, score: sc[dominantBiome] || 0 };
      })
      .sort((a,b)=> b.score - a.score);

    forcedDominantIds = new Set(scored.slice(0, targetCount).map(x => x.id));
  }

  // biomes with quotas
  const counts = {};
  for(const b of BIOMES) counts[b] = 0;
  // --- Arena theming (20% chance): ~75% of cells become one dominant biome ---
  const isThemedArena = rng.next() < 0.20;
  const dominantBiome = isThemedArena ? pick(BIOMES, rng) : null;

  if (isThemedArena && dominantBiome){
    const targetCount = Math.floor(cells.length * 0.75);
    const scored = cells
      .filter(c => c.id !== 1)
      .map(c => {
        const sc = biomeScores(c.features);
        return { cell: c, score: sc[dominantBiome] || 0 };
      })
      .sort((a,b)=> b.score - a.score);

    for (let i = 0; i < targetCount && i < scored.length; i++){
      scored[i].cell.biome = dominantBiome;
    }
  }



  // pass 1
  for(const cell of cells){
    // arena temática pode pré-fixar biomas; preserva e só contabiliza
    if (cell.id !== 1 && cell.biome && cell.biome !== "plains"){
      counts[cell.biome] = (counts[cell.biome] || 0) + 1;
      continue;
    }
    if (cell.id === 1){
      // área inicial especial
      cell.biome = "fairy";
      counts.fairy++;
      continue;
    }

    // arenas temáticas: ~75% das áreas são do bioma dominante
    if (themed && dominantBiome && forcedDominantIds?.has(cell.id)){
      cell.biome = dominantBiome;
      counts[dominantBiome] = (counts[dominantBiome] || 0) + 1;
      continue;
    }

    const scores = biomeScores(cell.features);

    // allowed biomes (respeita máximos; em arena temática, o restante exclui o dominante)
    const allowed = new Set();
    for(const b of BIOMES){
      if (themed && dominantBiome && b === dominantBiome) continue;
      if(counts[b] < QUOTAS[b].max) allowed.add(b);
    }

    let biome = pickBiomeByScore(scores, rng, allowed);
    if (!allowed.has(biome)) biome = "plains";
    cell.biome = biome;
    counts[biome]++;
  }

  // pass 2 ensure mins (simple)
  // Em arenas temáticas, não forçamos mínimos para não destruir a dominância (~75%).
  if (!themed){
    const needs = [];
    for(const b of BIOMES){
      const deficit = QUOTAS[b].min - counts[b];
      if(deficit > 0) needs.push([b, deficit]);
    }
    needs.sort((a,b)=> b[1]-a[1]);

    function findDonor(){
      let best=null, slack=0;
      for(const b of BIOMES){
        const s = counts[b] - QUOTAS[b].min;
        if(s > slack){ slack = s; best=b; }
      }
      return best;
    }

    for(const [target, deficit0] of needs){
      let deficit = deficit0;
      while(deficit > 0){
        const donor = findDonor();
        if(!donor) break;

        // troca a célula doadora que mais combina com target
        let bestCell = null;
        let bestGain = -Infinity;

        for(const cell of cells){
          if(cell.id === 1) continue;
          if(cell.biome !== donor) continue;
          if(counts[donor] <= QUOTAS[donor].min) continue;

          const sc = biomeScores(cell.features);
          const gain = (sc[target] || 0) - (sc[donor] || 0);
          if(gain > bestGain){
            bestGain = gain;
            bestCell = cell;
          }
        }

        if(!bestCell) break;
        counts[donor]--;
        bestCell.biome = target;
        counts[target]++;
        deficit--;
      }
    }
  }

  // colors + base water flags
  for(const cell of cells){
    if(cell.id === 1){
      cell.fillColor = "#6d3bd6";
    } else {
      cell.fillColor = colorForBiome(cell.biome, rng, paletteIndex);
    }
    cell.hasWater = (cell.biome === "lake" || cell.biome === "swamp");
  }

  // river (marks hasWater on crossed cells)
  const river = buildRiver({ rng, cells, adj, paletteIndex, width:W, height:H, blobRadius });
  // renumber by BFS AFTER river marking (id change needs remap)
  const ren = renumberCellsByBFS(cells, adj);
  cells = ren.cells;
  adj = ren.adj;

  // rebuild river cellIds after renumber (by geometry marking, ids are already updated in cells)
  // easiest: recompute riverCells from cells.hasWater && river path crossing already marked on cells
  const riverCellIds = new Set();
  for(const c of cells){
    if(c._riverTouched) riverCellIds.add(c.id);
  }

  // build serializable structures
  const areasById = {};
  const adjById = {};
  for(const c of cells){
    areasById[String(c.id)] = {
      id: c.id,
      biome: c.biome,
      color: c.fillColor,
      hasWater: !!c.hasWater
    };
    adjById[String(c.id)] = Array.from(adj.get(c.id) || []).sort((a,b)=>a-b);
  }

  // ui geometry (derived but kept in-memory; you can omit from save if quiser)
  const uiGeom = {
    width: W, height: H,
    blob,
    cells: cells.map(c => ({
      id: c.id,
      poly: c.poly,
      center: c.center
    })),
    river: { points: river.points, cellIds: Array.from(riverCellIds) }
  };

  const arenaTitle = themed
    ? (ARENA_TITLES[dominantBiome] || ARENA_TITLES.regular)
    : ARENA_TITLES.regular;

  return {
    areasById,
    adjById,
    uiGeom,
    arena: {
      themed,
      biome: dominantBiome,
      title: arenaTitle
    }
  };
}

function buildRiver({ rng, cells, adj, width, height, blobRadius }){
  // choose start
  let candidates = cells.filter(c => c.id !== 1 && c.biome === "mountain");
  if(!candidates.length) candidates = cells.filter(c => c.id !== 1);
  candidates.sort((a,b)=> (b.features?.alt ?? 0) - (a.features?.alt ?? 0));
  const start = candidates[0];
  if(!start) return { points: [], cellIds: new Set() };

  const pts = [];
  const riverCells = new Set();

  let current = start;
  const visited = new Set([current.id]);

  pts.push({ x: current.center.x, y: current.center.y });
  riverCells.add(current.id);
  current.hasWater = true;
  current._riverTouched = true;

  const riverMaxSteps = 45;

  for(let step=0; step<riverMaxSteps; step++){
    const neigh = adj.get(current.id);
    if(!neigh || !neigh.size) break;
    if((current.features?.radial ?? 0) > 0.96) break;

    const options = [];
    for(const nid of neigh){
      if(visited.has(nid)) continue;
      const ncell = cells.find(c => c.id === nid);
      if(!ncell) continue;

      const altNow = current.features?.alt ?? 0.5;
      const altN = ncell.features?.alt ?? 0.5;
      const downhill = (altNow - altN);
      const random = (rng.next() - 0.5) * 0.25;
      const outBias = ((ncell.features?.radial ?? 0) - (current.features?.radial ?? 0)) * 0.35;
      const w = downhill * 0.9 + outBias + random;
      options.push({ ncell, w });
    }

    if(!options.length) break;
    options.sort((a,b)=>b.w-a.w);
    const k = Math.min(3, options.length);
    const choice = options[Math.floor(rng.next() * k)].ncell;

    current = choice;
    visited.add(current.id);
    pts.push({ x: current.center.x, y: current.center.y });
    riverCells.add(current.id);
    current.hasWater = true;
    current._riverTouched = true;

    if((current.features?.radial ?? 0) > 0.975) break;
  }

  // extend outside
  if (pts.length >= 2){
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.max(1, Math.sqrt(dx*dx + dy*dy));
    const ux = dx / len, uy = dy / len;
    pts.push({ x: b.x + ux * 260, y: b.y + uy * 260 });
  }

  // mark crossed cells by sampling
  const riverWidth = 6;
  const markRadius = Math.max(1, riverWidth * 0.60);
  const offsets = [
    {ox: 0, oy: 0},
    {ox: markRadius, oy: 0},
    {ox: -markRadius, oy: 0},
    {ox: 0, oy: markRadius},
    {ox: 0, oy: -markRadius},
  ];

  for (let i = 0; i < pts.length - 1; i++){
    const p0 = pts[i], p1 = pts[i+1];
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const segLen = Math.max(1, Math.sqrt(dx*dx + dy*dy));
    const steps = Math.ceil(segLen / 10);

    for (let s = 0; s <= steps; s++){
      const t = s / steps;
      const x = p0.x + dx * t;
      const y = p0.y + dy * t;

      for (const off of offsets){
        const c = cellAtPoint(cells, x + off.ox, y + off.oy);
        if(c){
          c.hasWater = true;
          c._riverTouched = true;
          riverCells.add(c.id);
        }
      }
    }
  }

  return { points: pts, cellIds: riverCells };
}
