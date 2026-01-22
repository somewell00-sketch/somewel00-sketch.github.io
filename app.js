import { MapSize, createInitialWorld, districtInfo } from "./state.js";
import { generateMapData } from "./mapgen.js";
import { MapUI } from "./mapui.js";
import { advanceDay } from "./sim.js";
import { saveToLocal, loadFromLocal, clearLocal, downloadJSON, uploadJSON } from "./storage.js";

const root = document.getElementById("root");

let world = null;
let paletteIndex = 0;

let tributePool = null;

const uiState = {
  focusedId: 1,
  plannedRoute: [], // [areaId, areaId, ...]
  modalOpen: false
};

async function loadTributePool(){
  try{
    const res = await fetch("./tributes.json", { cache: "no-store" });
    if(!res.ok) throw new Error("failed");
    const data = await res.json();
    if(Array.isArray(data.tributes)) return data.tributes;
  } catch(_e){}
  // fallback
  return Array.from({ length: 48 }, (_,i)=>({ name: `Tribute ${i+1}` }));
}

function ensureReplaySlot(w){
  while(w.replay.playerActionsByDay.length < w.meta.day){
    w.replay.playerActionsByDay.push([]);
  }
}

function getAllActors(w){
  return [w.entities.player, ...Object.values(w.entities.npcs)].filter(a => a.alive);
}

function actorsInArea(w, areaId){
  return getAllActors(w).filter(a => a.areaId === areaId);
}

function maxStepsForPlayer(){
  const p = world.entities.player;
  return (p.hp > 30 && p.stamina > 20) ? 3 : 1;
}

function resetPlan(){
  uiState.plannedRoute = [];
}

function renderStart(){
  root.innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="h1">Battle Royale Arena</div>
        <div class="muted">Plan your day, lock in actions, then the engine advances deterministically by seed.</div>

        <hr class="sep" />

        <div class="row">
          <div style="display:flex; flex-direction:column; gap:6px; min-width:220px;">
            <div class="muted small">Map size</div>
            <select id="size" class="select">
              <option value="${MapSize.SMALL}">Small (24 areas)</option>
              <option value="${MapSize.MEDIUM}" selected>Medium (48 areas)</option>
              <option value="${MapSize.LARGE}">Large (72 areas)</option>
            </select>
          </div>

          <div style="display:flex; flex-direction:column; gap:6px; min-width:220px;">
            <div class="muted small">Total players</div>
            <select id="players" class="select">
              <option value="12">12</option>
              <option value="24" selected>24</option>
              <option value="48">48</option>
            </select>
          </div>

          <div style="display:flex; flex-direction:column; gap:6px; min-width:220px;">
            <div class="muted small">Your district</div>
            <select id="district" class="select">
              ${Array.from({length:12},(_,i)=>i+1).map(n=>`<option value="${n}" ${n===12?"selected":""}>District ${n}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="row" style="margin-top:10px;">
          <button id="enter" class="btn primary">Enter arena</button>
          <button id="resume" class="btn">Resume save</button>
          <button id="clear" class="btn danger">Clear save</button>
        </div>

        <div class="muted small" style="margin-top:10px;">
          Tip: run on a local server (e.g. <code>python -m http.server</code>) so <code>tributes.json</code> can be loaded.
        </div>
      </div>
    </div>
  `;

  document.getElementById("enter").onclick = () => {
    const mapSize = Number(document.getElementById("size").value);
    const totalPlayers = Number(document.getElementById("players").value);
    const playerDistrict = Number(document.getElementById("district").value);
    startNewGame({ mapSize, totalPlayers, playerDistrict });
  };

  document.getElementById("resume").onclick = () => {
    const saved = loadFromLocal();
    if(!saved){
      alert("No save found.");
      return;
    }
    world = saved;
    uiState.focusedId = world.entities.player.areaId;
    resetPlan();
    renderGame();
  };

  document.getElementById("clear").onclick = () => {
    clearLocal();
    alert("Save cleared.");
  };
}

function startNewGame({ mapSize, totalPlayers, playerDistrict }){
  const seed = (Math.random() * 1e9) | 0;

  const mapData = generateMapData({
    seed,
    regions: mapSize,
    width: 820,
    height: 820,
    paletteIndex
  });

  world = createInitialWorld({
    seed,
    mapSize,
    mapData,
    totalPlayers,
    playerDistrict,
    tributePool
  });

  uiState.focusedId = 1;
  resetPlan();
  saveToLocal(world);
  renderGame();
}

function renderGame(){
  root.innerHTML = `
    <div class="app">
      <aside class="panel">
        <div class="row" style="justify-content:space-between; align-items:flex-start;">
          <div>
            <div class="h1" style="margin:0;">Area Inspector</div>
            <div class="muted small">Day <span id="day"></span> • Seed <span id="seed"></span></div>
          </div>
          <div class="pill"><strong id="alive"></strong><span>alive</span></div>
        </div>

        <div class="row">
          <button id="openDay" class="btn primary">Lock in day actions</button>
          <button id="resetPlan" class="btn ghost">Clear plan</button>
        </div>

        <div class="row">
          <button id="regen" class="btn">New map</button>
          <button id="resetProgress" class="btn">Reset to Cornucopia</button>
        </div>

        <div class="row">
          <button id="saveLocal" class="btn">Save</button>
          <button id="export" class="btn">Export JSON</button>
          <label class="btn" style="display:inline-flex; align-items:center; gap:8px;">
            Import JSON <input id="import" type="file" accept="application/json" style="display:none" />
          </label>
        </div>

        <div class="row">
          <span class="pill"><span class="swatch" id="swatch"></span><span id="title">—</span></span>
          <span class="pill" id="visitedCount">Visited: —</span>
        </div>

        <div class="row">
          <span class="pill"><strong>Plan</strong> <span id="planText">—</span></span>
          <span class="pill"><strong>Steps</strong> <span id="stepInfo">—</span></span>
        </div>

        <div class="kv">
          <div>ID</div><div id="infoNum">—</div>
          <div>Biome</div><div id="infoBiome">—</div>
          <div>Water</div><div id="infoWater">—</div>
          <div>Active</div><div id="infoActive">—</div>
          <div>Food</div><div id="infoFood">—</div>
          <div>Reachable</div><div id="infoReach">—</div>
        </div>

        <div>
          <div class="row" style="justify-content:space-between;">
            <div class="h2">Tributes here</div>
            <div class="muted small" id="hereCount">—</div>
          </div>
          <div class="list" id="hereList"></div>
        </div>

        <div class="muted small">Click areas to build a planned route (up to your step limit). Everyone starts at the Cornucopia (Area 1).</div>
      </aside>

      <main class="canvasWrap">
        <canvas id="c" width="820" height="820"></canvas>
        <div class="hint">Map = UI • Engine advances by day • Cornucopia = Area 1</div>
      </main>
    </div>

    <div id="modalRoot"></div>
  `;

  const dayEl = document.getElementById("day");
  const seedEl = document.getElementById("seed");
  const aliveEl = document.getElementById("alive");
  const swatch = document.getElementById("swatch");
  const title = document.getElementById("title");
  const visitedCount = document.getElementById("visitedCount");
  const planText = document.getElementById("planText");
  const stepInfo = document.getElementById("stepInfo");

  const infoNum = document.getElementById("infoNum");
  const infoBiome = document.getElementById("infoBiome");
  const infoWater = document.getElementById("infoWater");
  const infoActive = document.getElementById("infoActive");
  const infoFood = document.getElementById("infoFood");
  const infoReach = document.getElementById("infoReach");

  const hereCount = document.getElementById("hereCount");
  const hereList = document.getElementById("hereList");

  const canvas = document.getElementById("c");
  const mapUI = new MapUI({
    canvas,
    onAreaClick: (id) => {
      // Always focus
      setFocus(id);

      // Planning: build a route step-by-step
      const playerArea = world.entities.player.areaId;
      const stepsMax = maxStepsForPlayer();
      const last = (uiState.plannedRoute.length ? uiState.plannedRoute[uiState.plannedRoute.length - 1] : playerArea);

      if (id === playerArea){
        resetPlan();
        sync();
        return;
      }

      // route length cap
      if (uiState.plannedRoute.length >= stepsMax){
        return;
      }

      // must be adjacent to last planned node
      const adj = world.map.adjById[String(last)] || [];
      const isAdj = adj.includes(id);
      const isActive = world.map.areasById[String(id)]?.isActive !== false;

      if (isAdj && isActive){
        uiState.plannedRoute.push(id);
        sync();
      }
    }
  });

  function setFocus(id){
    uiState.focusedId = id;
    const info = mapUI.getAreaInfo(id);
    if(!info) return;

    const label = (info.id === 1) ? `Area ${info.id} (Cornucopia)` : `Area ${info.id}`;
    title.textContent = label;
    swatch.style.background = info.color;
    infoNum.textContent = String(info.id);
    infoBiome.textContent = info.biome;
    infoWater.textContent = info.hasWater ? "Yes" : "No";
    infoActive.textContent = info.isActive ? "Yes" : "No";
    infoFood.textContent = (world.map.areasById[String(id)]?.hasFood) ? "Yes" : "No";
    infoReach.textContent = info.visitable ? "Yes" : "No";

    // Tributes in focused area
    const list = actorsInArea(world, id);
    hereCount.textContent = `${list.length}`;
    hereList.innerHTML = list.map(a => {
      const d = districtInfo(a.district);
      return `
        <div class="listItem">
          <div style="display:flex; flex-direction:column; gap:2px;">
            <div style="font-weight:800;">${escapeHtml(a.name)}${a.id === "player" ? " (you)" : ""}</div>
            <div class="muted small">HP ${a.hp} • FP ${a.stamina}</div>
          </div>
          <div class="tag">${d.emoji} Dist. ${d.id}</div>
        </div>
      `;
    }).join("") || `<div class="muted small">No one here.</div>`;
  }

  function sync(){
    dayEl.textContent = String(world.meta.day);
    seedEl.textContent = String(world.meta.seed);
    aliveEl.textContent = String(getAllActors(world).length);

    visitedCount.textContent = `Visited: ${world.flags.visitedAreas.length}`;

    const planned = uiState.plannedRoute.length ? uiState.plannedRoute.join(" → ") : "—";
    planText.textContent = planned;

    const stepsMax = maxStepsForPlayer();
    stepInfo.textContent = `${uiState.plannedRoute.length}/${stepsMax}`;

    mapUI.setData({ world, paletteIndex, uiState });

    setFocus(uiState.focusedId);
  }

  function openDayModal(){
    const modalRoot = document.getElementById("modalRoot");
    const player = world.entities.player;

    // Targets are based on who is currently in the same area (post previous day)
    const here = actorsInArea(world, player.areaId).filter(a => a.id !== "player");
    const canAttack = here.length > 0;

    modalRoot.innerHTML = `
      <div class="modalOverlay">
      <div class="modal">
        <h2>Lock in day actions</h2>

        <div class="section">
          <h3>Action 1</h3>
          <button data-action="ATTACK" id="a1Attack">Attack</button>
          <button data-action="DEFEND" id="a1Defend">Defend</button>
        </div>

        <div class="section">
          <h3>Action 2</h3>
          <button data-move="MOVE" id="a2Move">Move</button>
          <button data-move="STAY" id="a2Stay">Stay</button>
        </div>

        <button id="confirmDay" class="btn primary">Confirm & Advance</button>
        <button id="closeModal" class="btn">Close</button>
      </div>
    </div>
    `;

    document.getElementById("closeModal").onclick = () => { modalRoot.innerHTML = ""; };

    document.getElementById("confirmDay").onclick = () => {
      const a1 = document.querySelector('input[name="a1"]:checked')?.value || "DEFEND";
      const a2 = document.querySelector('input[name="a2"]:checked')?.value || "STAY";

      const actions = [];

      if (a1 === "ATTACK"){
        const targetId = document.getElementById("target").value;
        actions.push({ type: "ATTACK", payload: { targetId } });
      } else {
        actions.push({ type: "DEFEND", payload: {} });
      }

      if (a2 === "MOVE"){
        if (!uiState.plannedRoute.length){
          alert("Plan a route on the map first, or choose Stay.");
          return;
        }
        actions.push({ type: "MOVE", payload: { route: uiState.plannedRoute.slice(0) } });
      } else {
        actions.push({ type: "STAY", payload: {} });
      }

      ensureReplaySlot(world);
      world.replay.playerActionsByDay[world.meta.day - 1] = actions;

      const { nextWorld } = advanceDay(world, actions);
      world = nextWorld;

      saveToLocal(world);

      // clear plan and close
      resetPlan();
      modalRoot.innerHTML = "";

      // keep focus on player area
      uiState.focusedId = world.entities.player.areaId;
      sync();
    };
  }

  document.getElementById("openDay").onclick = openDayModal;
  document.getElementById("resetPlan").onclick = () => { resetPlan(); sync(); };

  document.getElementById("regen").onclick = () => startNewGame({ mapSize: world.meta.mapSize, totalPlayers: world.meta.totalPlayers, playerDistrict: world.entities.player.district });

  document.getElementById("resetProgress").onclick = () => {
    world.entities.player.areaId = 1;
    uiState.focusedId = 1;
    resetPlan();
    saveToLocal(world);
    sync();
  };

  document.getElementById("saveLocal").onclick = () => {
    saveToLocal(world);
    alert("Saved in browser.");
  };

  document.getElementById("export").onclick = () => downloadJSON(world);

  document.getElementById("import").onchange = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    try{
      const loaded = await uploadJSON(file);
      world = loaded;
      uiState.focusedId = world.entities.player.areaId;
      resetPlan();
      saveToLocal(world);
      renderGame();
    } catch(err){
      alert(err.message || "Import failed.");
    }
  };

  // Palette shortcut placeholder
  window.onkeydown = (e) => {
    if (e.key === "1"){
      paletteIndex = 0;
      sync();
    }
  };

  sync();
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll(""","&quot;")
    .replaceAll("'","&#039;");
}

(async function init(){
  tributePool = await loadTributePool();
  renderStart();
})();
