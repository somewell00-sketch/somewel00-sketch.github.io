import { MapSize, createInitialWorld } from "./state.js";
import { generateMapData } from "./mapgen.js";
import { MapUI } from "./mapui.js";
import { advanceDay, maxSteps } from "./sim.js";
import { generateNpcIntents } from "./ai.js";
import { saveToLocal, loadFromLocal, clearLocal, downloadJSON, uploadJSON } from "./storage.js";

const root = document.getElementById("root");

let world = null;

const uiState = {
  focusedAreaId: 1,
  plannedRoute: [], // array of area ids
};

const DISTRICT_INFO = {
  1: { name: "Luxury items", emoji: "💎", career: true },
  2: { name: "Masonry, defense, weaponry", emoji: "🛡️", career: true },
  3: { name: "Electronics, technology", emoji: "💻", career: false },
  4: { name: "Fishing", emoji: "🐟", career: true },
  5: { name: "Power, energy", emoji: "⚡", career: false },
  6: { name: "Transportation", emoji: "🚆", career: false },
  7: { name: "Lumber, wood", emoji: "🪵", career: false },
  8: { name: "Textiles, clothing", emoji: "🧵", career: false },
  9: { name: "Grain, agriculture", emoji: "🌾", career: false },
  10:{ name: "Livestock, meat", emoji: "🐄", career: false },
  11:{ name: "Agriculture, food production", emoji: "🥕", career: false },
  12:{ name: "Coal mining", emoji: "⛏️", career: false },
};

function renderStart(){
  root.innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="h1">Arena Simulator</div>
        <div class="muted">Choose your setup. Click areas to plan movement. Each day is confirmed via the Day screen.</div>
        <hr class="sep" />

        <div class="row">
          <label class="muted">Map size</label>
          <select id="size" class="select">
            <option value="${MapSize.SMALL}">Small (24 areas)</option>
            <option value="${MapSize.MEDIUM}" selected>Medium (48 areas)</option>
            <option value="${MapSize.LARGE}">Large (72 areas)</option>
          </select>

          <label class="muted">Players</label>
          <select id="players" class="select">
            <option value="12" selected>12</option>
            <option value="24">24</option>
            <option value="48">48</option>
          </select>

          <label class="muted">Your district</label>
          <select id="district" class="select">
            ${Array.from({length:12}, (_,i)=>`<option value="${i+1}">District ${i+1}</option>`).join("")}
          </select>
        </div>

        <div class="row" style="margin-top:10px;">
          <button id="enter" class="btn primary">Enter arena</button>
          <button id="resume" class="btn">Resume save</button>
          <button id="wipe" class="btn">Clear save</button>
        </div>

        <div class="muted small" style="margin-top:10px;">
          Tip: run on a local server to avoid CORS issues (ex: <code>python -m http.server</code>).
        </div>
      </div>
    </div>
  `;

  document.getElementById("enter").onclick = () => {
    const mapSize = Number(document.getElementById("size").value);
    const totalPlayers = Number(document.getElementById("players").value);
    const playerDistrict = Number(document.getElementById("district").value);
    startNewGame(mapSize, totalPlayers, playerDistrict);
  };

  document.getElementById("resume").onclick = () => {
    const saved = loadFromLocal();
    if(!saved){
      alert("No save found.");
      return;
    }
    world = saved;
    uiState.focusedAreaId = world.entities.player.areaId;
    uiState.plannedRoute = [];
    renderGame();
  };

  document.getElementById("wipe").onclick = () => {
    clearLocal();
    alert("Save cleared.");
  };
}

function startNewGame(mapSize, totalPlayers, playerDistrict){
  const seed = (Math.random() * 1e9) | 0;
  const mapData = generateMapData({
    seed,
    regions: mapSize,
    width: 820,
    height: 820,
    paletteIndex: 0
  });

  world = createInitialWorld({ seed, mapSize, mapData, totalPlayers, playerDistrict });
  uiState.focusedAreaId = 1;
  uiState.plannedRoute = [];
  saveToLocal(world);
  renderGame();
}

function renderGame(){
  root.innerHTML = `
    <div class="app">
      <aside class="panel">
        <div class="row space">
          <div>
            <div class="h1" style="margin:0;">Control Panel</div>
            <div class="muted small">Day: <span id="day"></span> • Seed: <span id="seed"></span></div>
          </div>
        </div>

        <div class="row" style="margin-top:10px;">
          <button id="openDay" class="btn primary">Day screen</button>
          <button id="regen" class="btn">New map</button>
          <button id="resetProgress" class="btn">Restart</button>
        </div>

        <div class="row">
          <button id="saveLocal" class="btn">Save</button>
          <button id="export" class="btn">Export JSON</button>
          <label class="btn" style="display:inline-flex; align-items:center; gap:8px;">
            Import JSON <input id="import" type="file" accept="application/json" style="display:none" />
          </label>
          <button id="clearLocal" class="btn">Clear save</button>
        </div>

        <div class="row">
          <span class="pill"><span class="swatch" id="swatch"></span><span id="title">—</span></span>
          <span class="pill" id="visitedCount">Visited: —</span>
        </div>

        <div class="row">
          <span class="pill"><strong>You</strong><span id="youDistrict">—</span></span>
          <span class="pill">HP <span id="youHP" style="font-family:var(--mono);">—</span></span>
          <span class="pill">FP <span id="youFP" style="font-family:var(--mono);">—</span></span>
        </div>

        <div class="muted">Occupants</div>
        <div id="occupants" class="list"></div>

        <div class="kv">
          <div>Area</div><div id="infoNum">—</div>
          <div>Biome</div><div id="infoBiome">—</div>
          <div>Water</div><div id="infoWater">—</div>
          <div>Visited</div><div id="infoVisited">—</div>
          <div>Visitable</div><div id="infoVisit">—</div>
          <div>Plan</div><div id="infoPlan">—</div>
        </div>

        <div class="muted">Notes</div>
        <textarea id="notes" placeholder="Optional notes per area..."></textarea>
      </aside>

      <main class="canvasWrap">
        <canvas id="c" width="820" height="820"></canvas>
        <div class="hint">Map = UI • Engine runs by days • Cornucopia = Area 1</div>
      </main>
    </div>
  `;

  const dayEl = document.getElementById("day");
  const seedEl = document.getElementById("seed");
  const swatch = document.getElementById("swatch");
  const title = document.getElementById("title");
  const visitedCount = document.getElementById("visitedCount");
  const youDistrict = document.getElementById("youDistrict");
  const youHP = document.getElementById("youHP");
  const youFP = document.getElementById("youFP");

  const infoNum = document.getElementById("infoNum");
  const infoBiome = document.getElementById("infoBiome");
  const infoWater = document.getElementById("infoWater");
  const infoVisited = document.getElementById("infoVisited");
  const infoVisit = document.getElementById("infoVisit");
  const infoPlan = document.getElementById("infoPlan");
  const occupantsEl = document.getElementById("occupants");

  const canvas = document.getElementById("c");
  const mapUI = new MapUI({
    canvas,
    onAreaClick: (id) => {
      setFocus(id);
      planMoveTo(id);
    }
  });

  function setFocus(id){
    uiState.focusedAreaId = id;
    sync();
  }

  function planMoveTo(id){
    const from = world.entities.player.areaId;
    const adj = world.map.adjById[String(from)] || [];
    const area = world.map.areasById[String(id)];

    // Only plan if visitable and active.
    if (!area || area.isActive === false) return;
    if (id !== from && !adj.includes(id)) return;

    // MVP route planning: 1 step by click (later we can allow 2-3 step routes)
    if (id === from){
      uiState.plannedRoute = [];
    } else {
      uiState.plannedRoute = [id];
    }
    sync();
  }

  function districtTag(d){
    const info = DISTRICT_INFO[d] || { emoji:"🏷️" };
    return `${info.emoji} Dist. ${d}`;
  }

  function sync(){
    dayEl.textContent = String(world.meta.day);
    seedEl.textContent = String(world.meta.seed);

    const p = world.entities.player;
    const dInfo = DISTRICT_INFO[p.district] || {};
    youDistrict.textContent = `${districtTag(p.district)} • ${dInfo.name || ""}`;
    youHP.textContent = String(p.hp ?? 100);
    youFP.textContent = String(p.fp ?? 70);

    visitedCount.textContent = `Visited: ${world.flags.visitedAreas.length}`;

    const focus = uiState.focusedAreaId;
    const info = mapUI.getAreaInfo(focus);
    if (info){
      title.textContent = (info.id === 1) ? `Area 1 (🏺 Cornucopia)` : `Area ${info.id}`;
      swatch.style.background = info.color || "#2a2f3a";
      infoNum.textContent = String(info.id);
      infoBiome.textContent = info.biome || "—";
      infoWater.textContent = (info.hasWater == null) ? "—" : (info.hasWater ? "Yes" : "No");
      infoVisited.textContent = info.visited ? "Yes" : "No";
      infoVisit.textContent = info.visitable ? "Yes" : "No";
      infoPlan.textContent = uiState.plannedRoute.length ? uiState.plannedRoute.join(" → ") : "—";
    }

    // Occupants list (only in visited areas, and always in your current area)
    const occ = [];
    const areaId = focus;

    // If fog-of-war and not visited, we won't reveal occupants unless it's your area.
    const isVisited = world.flags.visitedAreas.includes(areaId);
    const reveal = isVisited || (areaId === world.entities.player.areaId);

    if (reveal){
      if (p.areaId === areaId) occ.push({ name: "You", district: p.district });
      for (const npc of Object.values(world.entities.npcs)){
        if (npc.areaId === areaId) occ.push({ name: npc.name, district: npc.district });
      }
    }

    occupantsEl.innerHTML = occ.length
      ? occ.map(o => `<div class="pill"><strong>${escapeHtml(o.name)}</strong><span>${escapeHtml(districtTag(o.district))}</span></div>`).join("")
      : `<div class="muted small">${reveal ? "No one here" : "Unknown"}</div>`;

    mapUI.setWorld(world);
    mapUI.render();
  }

  document.getElementById("openDay").onclick = () => openDayModal();

  document.getElementById("regen").onclick = () => {
    const mapSize = world.meta.mapSize;
    startNewGame(mapSize, world.meta.totalPlayers || 12, world.entities.player.district || 12);
  };

  document.getElementById("resetProgress").onclick = () => {
    clearLocal();
    world = null;
    renderStart();
  };

  document.getElementById("saveLocal").onclick = () => {
    saveToLocal(world);
    alert("Saved.");
  };

  document.getElementById("export").onclick = () => downloadJSON(world);

  document.getElementById("import").onchange = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    const next = await uploadJSON(file);
    world = next;
    uiState.focusedAreaId = world.entities.player.areaId;
    uiState.plannedRoute = [];
    saveToLocal(world);
    sync();
  };

  document.getElementById("clearLocal").onclick = () => {
    clearLocal();
    alert("Save cleared. Refresh and start a new game.");
  };

  // Initial paint
  mapUI.setWorld(world);
  sync();

  function openDayModal(){
    // Determine if Attack is available: any NPC in same area
    const p = world.entities.player;
    const sameAreaNpcs = Object.values(world.entities.npcs).filter(n => n.areaId === p.areaId);
    const canAttack = sameAreaNpcs.length > 0;

    const overlay = document.createElement("div");
    overlay.className = "modalOverlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="h1" style="margin:0;">Day ${world.meta.day}</div>
        <div class="muted small" style="margin-top:6px;">You must lock in 2 actions.</div>

        <div class="section">
          <h3>Action 1 (mandatory)</h3>
          <div class="row">
            <button id="a1Attack" class="btn" ${canAttack ? "" : "disabled"}>Attack</button>
            <button id="a1Defend" class="btn">Defend</button>
            <button id="a1Nothing" class="btn">Do nothing</button>
          </div>
          <div class="muted small" id="a1Hint" style="margin-top:6px;">
            ${canAttack ? "Attack is available (someone is in your area)." : "No valid targets: Attack is disabled."}
          </div>
        </div>

        <div class="section">
          <h3>Action 2 (mandatory)</h3>
          <div class="row">
            <button id="a2Move" class="btn">Move</button>
            <button id="a2Stay" class="btn">Stay</button>
          </div>
          <div class="muted small" style="margin-top:6px;">
            Planned route: <span style="font-family:var(--mono);">${uiState.plannedRoute.length ? uiState.plannedRoute.join(" → ") : "—"}</span>
            • Max steps today: <span style="font-family:var(--mono);">${maxSteps(p)}</span>
          </div>
        </div>

        <div class="row" style="margin-top:14px; justify-content:flex-end;">
          <button id="close" class="btn">Close</button>
          <button id="confirm" class="btn primary">Confirm & Advance</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let action1 = canAttack ? "ATTACK" : "DEFEND";
    let action2 = "STAY";

    const setBtnState = () => {
      // simple highlight by border
      overlay.querySelectorAll("button").forEach(b => b.style.outline = "");
      const b1 = overlay.querySelector(action1==="ATTACK" ? "#a1Attack" : action1==="DEFEND" ? "#a1Defend" : "#a1Nothing");
      if (b1) b1.style.outline = "2px solid var(--accent)";
      const b2 = overlay.querySelector(action2==="MOVE" ? "#a2Move" : "#a2Stay");
      if (b2) b2.style.outline = "2px solid var(--accent)";
    };

    const close = () => overlay.remove();

    overlay.querySelector("#close").onclick = close;

    overlay.querySelector("#a1Attack").onclick = () => { if(canAttack){ action1="ATTACK"; setBtnState(); } };
    overlay.querySelector("#a1Defend").onclick = () => { action1="DEFEND"; setBtnState(); };
    overlay.querySelector("#a1Nothing").onclick = () => { action1="DO_NOTHING"; setBtnState(); };

    overlay.querySelector("#a2Move").onclick = () => { action2="MOVE"; setBtnState(); };
    overlay.querySelector("#a2Stay").onclick = () => { action2="STAY"; setBtnState(); };

    setBtnState();

    overlay.querySelector("#confirm").onclick = () => {
      // Build player actions
      const actions = [];
      actions.push({ source: "player", type: action1, payload: {} });

      if (action2 === "MOVE"){
        const route = uiState.plannedRoute.slice();
        if (route.length === 0){
          // no plan => treat as stay
          actions.push({ source: "player", type: "STAY", payload: {} });
        } else {
          actions.push({ source: "player", type: "MOVE", payload: { route } });
        }
      } else {
        actions.push({ source: "player", type: "STAY", payload: {} });
      }

      // AI intents
      const intents = generateNpcIntents(world);

      // Advance day through engine
      world = advanceDay(world, [...actions, ...intents]);

      // Clear plan after day commits
      uiState.plannedRoute = [];
      uiState.focusedAreaId = world.entities.player.areaId;

      saveToLocal(world);
      close();
      sync();
    };
  }
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

renderStart();
