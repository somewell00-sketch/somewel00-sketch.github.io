import { MapSize, createInitialWorld } from "./state.js";
import { generateMapData } from "./mapgen.js";
import { MapUI } from "./mapui.js";
import { advanceDay, maxSteps } from "./sim.js";
import { generateNpcIntents } from "./ai.js";
import { saveToLocal, loadFromLocal, clearLocal, downloadJSON, uploadJSON } from "./storage.js";

let paletteIndex = 0;

const root = document.getElementById("root");

let world = null;

const uiState = {
  focusedAreaId: 1,
  plannedRoute: [],
  pendingAction1: null,
  pendingTargetId: null,
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

function districtTag(d){
  const info = DISTRICT_INFO[d] || { emoji:"🏷️", name:"" };
  return `${info.emoji} Dist. ${d}`;
}

function renderStart(){
  root.innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="h1">Arena Simulator</div>
        <div class="muted">Start in the Cornucopia (Area 1). Plan your move on the map, then commit actions.</div>
        <hr class="sep" />

        <div class="row">
          <label class="muted">Map size</label>
          <select id="size" class="select">
            <option value="${MapSize.SMALL}">Small (24)</option>
            <option value="${MapSize.MEDIUM}" selected>Medium (48)</option>
            <option value="${MapSize.LARGE}">Large (72)</option>
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
          <button id="enter" class="btn primary" style="flex:1;">Enter arena</button>
          <button id="resume" class="btn">Resume</button>
          <button id="wipe" class="btn">Clear save</button>
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
    if(!saved){ alert("No save found."); return; }
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
  const $id = (id) => document.getElementById(id);
  world.turnDraft = {
    stance: null,
    route: [],
    maxSteps: 3,
    committed: false
  };
  root.innerHTML = `
    <div class="app">
      <aside class="panel">
        <div class="h1" style="margin:0;">Arena</div>
        <div class="muted small">Day <span id="day"></span> • Seed <span id="seed"></span></div>

        <div class="section">
          <button id="commit" class="btn primary" style="width:100%; padding:12px 14px;">Commit Actions</button>
          <div class="muted small" style="margin-top:6px;">Plan movement on the map, then commit 2 actions.</div>
        </div>

        <div class="section">
          <div class="muted">Focused area</div>
          <div class="row" style="margin-top:6px;">
            <span class="pill"><span class="swatch" id="swatch"></span><span id="title">—</span></span>
            <span class="pill" id="visitedCount">Visited: —</span>
          </div>

          <div class="muted" style="margin-top:10px;">Occupants</div>
          <div id="occupants" class="list"></div>

          <div class="kv">
            <div>Area</div><div id="infoNum">—</div>
            <div>Biome</div><div id="infoBiome">—</div>
            <div>Water</div><div id="infoWater">—</div>
            <div>Visited</div><div id="infoVisited">—</div>
            <div>Plan</div><div id="infoPlan">—</div>
          </div>
        </div>

        
<div class="section">
  <div class="muted">Debug (temporary)</div>
  <div class="row" style="margin-top:8px;">
    <button id="debugAdvance" class="btn">Advance day</button>
  </div>
  <div class="muted small" style="margin-top:8px;">All tributes (HP/FP/Area)</div>
  <div id="debugTributes" class="list" style="max-height:220px; overflow:auto;"></div>
</div>

<div class="section">
          <div class="muted">Tools</div>
          <div class="row" style="margin-top:8px;">
            <button id="regen" class="btn">New map</button>
            <button id="restart" class="btn">Restart</button>
          </div>
          <div class="row" style="margin-top:8px;">
            <button id="saveLocal" class="btn">Save</button>
            <button id="export" class="btn">Export JSON</button>
            <label class="btn" style="display:inline-flex; align-items:center; gap:8px;">
              Import <input id="import" type="file" accept="application/json" style="display:none" />
            </label>
            <button id="clearLocal" class="btn">Clear save</button>
          </div>
        </div>
      </aside>

      <main class="canvasWrap">
        <canvas id="c" width="820" height="820"></canvas>
        <div class="hint">Cornucopia is Area 1 • Red border = closes next day</div>
      </main>

      <aside class="panel">
        <div class="h1" style="margin:0;">You</div>
        <div class="muted small"><span id="youDistrict">—</span></div>

        <div class="row" style="margin-top:10px;">
          <span class="pill">HP <span id="youHP" style="font-family:var(--mono);">—</span></span>
          <span class="pill">FP <span id="youFP" style="font-family:var(--mono);">—</span></span>
          <span class="pill">Kills <span id="youKills" style="font-family:var(--mono);">—</span></span>
        </div>

        <div class="kv" style="margin-top:10px;">
          <div>Visited areas</div><div id="youVisited">—</div>
          <div>Max steps</div><div id="youSteps">—</div>
          <div>Inventory</div><div class="muted">Soon</div>
        </div>
      </aside>
    </div>
  `;

  const dayEl = document.getElementById("day");
  const seedEl = document.getElementById("seed");

  const swatch = document.getElementById("swatch");
  const title = document.getElementById("title");
  const visitedCount = document.getElementById("visitedCount");
  const bannerEl = $id("banner");
  const commitBtn = $id("commit");
  const endBtn = $id("endDay");
  const movesLeftEl = $id("movesLeft");
  const entityLocsEl = $id("entityLocs");
  const occupantsEl = $id("occupants");
  const debugTributes = $id("debugTributes");

  const infoNum = document.getElementById("infoNum");
  const infoBiome = document.getElementById("infoBiome");
  const infoWater = document.getElementById("infoWater");
  const infoVisited = document.getElementById("infoVisited");
  const infoPlan = document.getElementById("infoPlan");

  const youDistrict = document.getElementById("youDistrict");
  const youHP = document.getElementById("youHP");
  const youFP = document.getElementById("youFP");
  const youKills = document.getElementById("youKills");
  const youVisited = document.getElementById("youVisited");
  const youSteps = document.getElementById("youSteps");

  const canvas = document.getElementById("c");
  const mapUI = new MapUI({
    canvas,
    isMovementEnabled: () => (world.turnDraft?.phase === "MOVE"),
    getCurrentAreaId: () => {
      const r = world.turnDraft?.route || [];
      return r.length ? r[r.length-1] : world.entities.player.areaId;
    },
    onAreaClick: (id) => {
      // sempre inspeciona
      setFocus(id);

      // só permite mover após Commit Action
      if (world.turnDraft?.phase !== "MOVE") return;

      const draft = world.turnDraft;
      const maxSteps = 3;
      const route = draft.route || (draft.route = []);

      // área de origem para validar adjacência é a última da rota ou a atual do player
      const from = route.length ? route[route.length - 1] : world.entities.player.areaId;
      const adj = world.map.adjById[String(from)] || [];
      const canStep = (id !== from) && adj.includes(id) && route.length < maxSteps;

      if(!canStep) return;

      // aplica movimentação imediatamente para refletir no inspector
      world.entities.player.areaId = id;
      route.push(id);

      // revela ao explorar
      const v = new Set(world.flags.visitedAreas || []);
      v.add(1);
      v.add(id);
      world.flags.visitedAreas = Array.from(v).sort((a,b)=>a-b);

      saveToLocal(world);
      sync();
    }
  });
  // initial data to avoid hover errors
  mapUI.setData({ world, paletteIndex });

  function planMoveTo(id){
  if(!world) return;
  const p = world.entities.player;

  // You must commit Action 1 first to start moving.
  if(!uiState.pendingAction1){
    uiState.plannedRoute = [];
    return;
  }

  const stepsAllowed = maxSteps(p);

  const area = world.map.areasById[String(id)];
  if(!area || area.isActive === false) return;

  const currentPos = (uiState.plannedRoute.length ? uiState.plannedRoute[uiState.plannedRoute.length-1] : p.areaId);

  // Clicking your current node ends movement early (advance day)
  if(id === currentPos){
    finalizeDay();
    return;
  }

  // Can't exceed max steps
  if(uiState.plannedRoute.length >= stepsAllowed) return;

  // Must be adjacent
  if(!adj.includes(id)) return;

  // Water rule: cannot enter water without bridge
  if(area.hasWater && !area.hasBridge) return;

  uiState.plannedRoute.push(id);

  if(uiState.plannedRoute.length >= stepsAllowed){
    finalizeDay();
  }
}

function finalizeDay(){
  if(!world) return;

  const actions = [];

  // Action 1 (mandatory)
  const a1 = uiState.pendingAction1?.type || "DO_NOTHING";
  if(a1 === "ATTACK"){
    const targetId = uiState.pendingTargetId || null;
    if(targetId){
      actions.push({ source: "player", type: "ATTACK", payload: { targetId } });
    } else {
      actions.push({ source: "player", type: "DO_NOTHING", payload: {} });
    }
  } else if (a1 === "DEFEND"){
    actions.push({ source: "player", type: "DEFEND", payload: {} });
  } else {
    actions.push({ source: "player", type: "DO_NOTHING", payload: {} });
  }

  // Action 2 (move or stay)
  if(uiState.plannedRoute.length){
    actions.push({ source: "player", type: "MOVE", payload: { route: uiState.plannedRoute.slice() } });
  } else {
    actions.push({ source: "player", type: "STAY", payload: {} });
  }

  const intents = generateNpcIntents(world);
  world = advanceDay(world, [...actions, ...intents]);

  uiState.pendingAction1 = null;
  uiState.pendingTargetId = null;
  uiState.plannedRoute = [];
  uiState.focusedAreaId = world.entities.player.areaId;

  saveToLocal(world);
  sync();
}

  function sync(){
    mapUI.setData({ world, paletteIndex });
    setFocus(focusedId);
    updateUiState();
  }

function updateUiState(){
    dayEl.textContent = String(world.meta.day);
    seedEl.textContent = String(world.meta.seed);
    visitedCount.textContent = `Visitadas: ${world.flags.visitedAreas.length}`;

    const used = world.turnDraft?.route?.length || 0;
    const rem = Math.max(0, 3 - used);
    if(movesLeftEl) movesLeftEl.textContent = `Você pode se mover até 3 áreas hoje. Restantes: ${rem}`;

    if(world.turnDraft?.phase === "ACTION"){
      if(bannerEl) bannerEl.textContent = "Você deve fazer uma ação nesta área antes de se mover para a próxima.";
      if(commitBtn) commitBtn.style.display = "";
      if(endBtn) endBtn.style.display = "none";
    } else {
      if(bannerEl) bannerEl.textContent = "Você sobreviveu mais um dia. Escolha uma nova área para ir.";
      if(commitBtn) commitBtn.style.display = "none";
      if(endBtn) endBtn.style.display = "";
    }

    const lines = [];
    lines.push(`Player: área ${world.entities.player.areaId}`);
    for(const npc of Object.values(world.entities.npcs)){
      lines.push(`${npc.name}: área ${npc.areaId}`);
    }
    if(entityLocsEl) entityLocsEl.value = lines.join("\n");
  }

  if(commitBtn) commitBtn.onclick = () => {
    showModal({
      title: "Commit Action",
      bodyHtml: "Escolha uma ação para esta área.",
      buttons: [
        { label: "Atacar", className: "btn-action", onClick: () => commitActionType("ATTACK") },
        { label: "Defender", onClick: () => commitActionType("DEFEND") },
        { label: "Nothing", onClick: () => commitActionType("DO_NOTHING") },
      ]
    });
  };

  function commitActionType(type){
    const { nextWorld, actionEvents } = commitPlayerAction(world, type);
    world = nextWorld;

    world.turnDraft.actionType = type;
    world.turnDraft.phase = "MOVE";

    // feedback dialog
    const you = "player";
    const hits = (actionEvents || []).filter(e => e.type === "HIT" && (e.attacker === you || e.target === you));
    const deaths = (actionEvents || []).filter(e => e.type === "DEATH");
    const action = (actionEvents || []).find(e => e.type === "ACTION");

    if(action?.action === "ATTACK"){
      if(action.result === "no_target") lines.push("You attacked, but there was no one here.");
      else lines.push("You attacked.");
    } else if(action?.action === "DEFEND"){
      lines.push("You defended.");
    } else {
      lines.push("You did nothing.");
    }

    if(hits.length === 0){
      lines.push("Nothing happened.");
    } else {
      for(const h of hits){
        if(h.attacker === you){
          lines.push(`You dealt ${h.dmg} damage.`);
        } else if(h.target === you){
          lines.push(`You received ${h.dmg} damage.`);
        }
      }
    }

    const youDied = deaths.some(d => d.who === you);
    if(youDied) lines.push("You died.");

    showDialog({ title: "Action result", lines, autoCloseMs: 5000 });

    saveToLocal(world);
    sync();
  }

  if(endBtn) endBtn.onclick = () => {
    // end day in current position
    const { nextWorld } = simEndDay(world);
    world = nextWorld;
    resetTurnDraftForNewDay();
    saveToLocal(world);
    renderGame();
  };

  const __el_regen = $id("regen");
  if(__el_regen) __el_regen.onclick = () => startNewGame(world.meta.mapSize);

  const __el_resetProgress = $id("resetProgress");
  if(__el_resetProgress) __el_resetProgress.onclick = () => {
    world.flags.visitedAreas = [1];
    world.entities.player.areaId = 1;
    focusedId = 1;
    resetTurnDraftForNewDay();
    saveToLocal(world);
    sync();
  };

  const __el_saveLocal = $id("saveLocal");
  if(__el_saveLocal) __el_saveLocal.onclick = () => {
    saveToLocal(world);
    alert("Salvo no navegador.");
  };

  const __el_export = $id("export");
  if(__el_export) __el_export.onclick = () => downloadJSON(world);

  const __el_import = $id("import");
  if(__el_import) __el_import.onchange = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    try{
      const loaded = await uploadJSON(file);
      world = loaded;
      if(!world.turnDraft) resetTurnDraftForNewDay();
      saveToLocal(world);
      renderGame();
    } catch(err){
      alert(err.message || "Falha ao importar.");
    }
  };

  const __el_clearLocal = $id("clearLocal");
  if(__el_clearLocal) __el_clearLocal.onclick = () => {
    clearLocal();
    alert("Save apagado.");
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

renderStart();