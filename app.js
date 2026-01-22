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
  const bannerEl = document.getElementById("banner");
  const commitBtn = document.getElementById("commitAction");
  const endBtn = document.getElementById("endDay");
  const movesLeftEl = document.getElementById("movesLeft");
  const entityLocsEl = document.getElementById("entityLocs");
  const occupantsEl = document.getElementById("occupants");
  const debugTributes = document.getElementById("debugTributes");

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
  } else {
        commitBtn.textContent = "Commit Action 1";
      }
    }

    // Occupants: reveal if visited OR your current area
    const reveal = visited || (focus === p.areaId);
    const occ = [];
    if(reveal){
      if(p.areaId === focus) occ.push({ name: "You", district: p.district, id: "player" });
      for(const npc of Object.values(world.entities.npcs)){
        if(npc.areaId === focus) occ.push({ name: npc.name, district: npc.district, id: npc.id });
      }
    }

    occupantsEl.innerHTML = occ.length
      ? occ.map(o => `<div class="pill"><strong>${escapeHtml(o.name)}</strong><span>${escapeHtml(districtTag(o.district))}</span></div>`).join("")
      : `<div class="muted small">${reveal ? "No one here" : "Unknown"}</div>`;

    // Debug: list all tributes with HP/FP/Area
    const all = [];
    all.push({ id: "player", name: "You", district: p.district, hp: p.hp, fp: p.fp, areaId: p.areaId });
    for(const npc of Object.values(world.entities.npcs)){
      all.push({ id: npc.id, name: npc.name, district: npc.district, hp: npc.hp, fp: npc.fp, areaId: npc.areaId });
    }
    debugTributes.innerHTML = all.map(t => `
      <div class="pill" style="justify-content:space-between; gap:10px;">
        <span><strong>${escapeHtml(t.name)}</strong> <span class="muted small">${escapeHtml(districtTag(t.district))}</span></span>
        <span class="muted small" style="font-family:var(--mono);">HP ${t.hp} • FP ${t.fp} • A${t.areaId}</span>
      </div>
    `).join("");

    mapUI.setData({ world, paletteIndex: 0 });
    mapUI.render();
  }



  document.getElementById("commit").onclick = () => openCommitModal();
  document.getElementById("debugAdvance").onclick = () => {
    // allow advancing even without committing (defaults do nothing + stay)
    if(!uiState.pendingAction1){
      uiState.pendingAction1 = { type: "DO_NOTHING" };
      uiState.pendingTargetId = null;
    }
    finalizeDay();
  };

  document.getElementById("regen").onclick = () => {
    startNewGame(world.meta.mapSize, world.meta.totalPlayers || 12, world.entities.player.district || 12);
  };
  document.getElementById("restart").onclick = () => {
    clearLocal();
    world = null;
    renderStart();
  };
  document.getElementById("saveLocal").onclick = () => { saveToLocal(world); alert("Saved."); };
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

  mapUI.setData({ world, paletteIndex: 0 });
  sync();

  function openCommitModal(){

    const sameAreaNpcs = Object.values(world.entities.npcs).filter(n => n.areaId === p.areaId && (n.hp ?? 0) > 0);
    const canAttack = sameAreaNpcs.length > 0;

    const overlay = document.createElement("div");
    overlay.className = "modalOverlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="h1" style="margin:0;">Commit actions (Day ${world.meta.day})</div>
        <div class="muted small" style="margin-top:6px;">Choose Action 1 now. Then move on the map (up to your max steps). The day advances automatically.</div>

        <div class="section">
          <h3>Action 1</h3>
          <div class="row">
            <button id="a1Attack" class="btn" ${canAttack ? "" : "disabled"}>Attack</button>
            <button id="a1Defend" class="btn">Defend</button>
            <button id="a1Nothing" class="btn">Do nothing</button>
          </div>

          <div class="row" style="margin-top:8px; align-items:center;">
            <label class="muted small">Target</label>
            <select id="target" class="select" ${canAttack ? "" : "disabled"}>
              ${sameAreaNpcs.map(n => `<option value="${n.id}">${escapeHtml(n.name)} (${districtTag(n.district)})</option>`).join("")}
            </select>
          </div>

          <div class="muted small" style="margin-top:6px;">
            ${canAttack ? "Attack available: choose a target in your area." : "No valid targets here."}
          </div>
        </div>

        <div class="row" style="margin-top:14px; justify-content:flex-end;">
          <button id="close" class="btn">Close</button>
          <button id="confirm" class="btn primary">Confirm Action 1</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let action1 = "DO_NOTHING";

    const setBtnState = () => {
      overlay.querySelectorAll("button").forEach(b => b.style.outline = "");
      const b1 = overlay.querySelector(action1==="ATTACK" ? "#a1Attack" : action1==="DEFEND" ? "#a1Defend" : "#a1Nothing");
      if (b1) b1.style.outline = "2px solid var(--accent)";
    };

    overlay.querySelector("#close").onclick = () => overlay.remove();

    overlay.querySelector("#a1Attack").onclick = () => { if(canAttack){ action1="ATTACK"; setBtnState(); } };
    overlay.querySelector("#a1Defend").onclick = () => { action1="DEFEND"; setBtnState(); };
    overlay.querySelector("#a1Nothing").onclick = () => { action1="DO_NOTHING"; setBtnState(); };

    setBtnState();

    overlay.querySelector("#confirm").onclick = () => {
      // store Action 1, close modal, then player moves on the map
      if(action1 === "ATTACK"){
        uiState.pendingAction1 = { type: "ATTACK" };
        uiState.pendingTargetId = overlay.querySelector("#target")?.value || null;
      } else if (action1 === "DEFEND"){
        uiState.pendingAction1 = { type: "DEFEND" };
        uiState.pendingTargetId = null;
      } else {
        uiState.pendingAction1 = { type: "DO_NOTHING" };
        uiState.pendingTargetId = null;
      }

      uiState.plannedRoute = [];
      overlay.remove();
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
  function showModal({ title, bodyHtml, buttons }){
    overlay.className = "modalOverlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="h1">${title}</div>
        <div class="muted small" style="margin-bottom:10px;">${bodyHtml || ""}</div>
        <div class="row">
          ${(buttons || []).map((b,i)=> `<button data-i="${i}" class="btn ${b.className || ""}">${b.label}</button>`).join("")}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const btns = overlay.querySelectorAll("button[data-i]");
    btns.forEach(btn => {
      btn.onclick = () => {
        const i = Number(btn.getAttribute("data-i"));
        const cfg = buttons[i];
        if(cfg?.onClick) cfg.onClick();
        overlay.remove();
      };
    });
  }

  function showDialog({ title, lines, autoCloseMs=5000 }){
    overlay.className = "modalOverlay";
    const htmlLines = (lines || []).map(l => `<div style="margin:6px 0;">${escapeHtml(l)}</div>`).join("");
    overlay.innerHTML = `
      <div class="modal dialog">
        <div class="h1">${title}</div>
        <div class="muted small">${htmlLines}</div>
        <div class="row" style="margin-top:12px;">
          <button id="ok" class="btn">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("#ok").onclick = () => overlay.remove();
    if(autoCloseMs){
      setTimeout(() => { if(document.body.contains(overlay)) overlay.remove(); }, autoCloseMs);
    }
  }

  function escapeHtml(str){
    return String(str)
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function resetTurnDraftForNewDay(){
    world.turnDraft = {
      phase: "ACTION", // ACTION -> MOVE
      actionType: null,
      route: []
    };
  }

  function updateUiState(){
    dayEl.textContent = String(world.meta.day);
    seedEl.textContent = String(world.meta.seed);
    visitedCount.textContent = `Visitadas: ${world.flags.visitedAreas.length}`;

    const used = world.turnDraft?.route?.length || 0;
    const rem = Math.max(0, 3 - used);
    movesLeftEl.textContent = `Você pode se mover até 3 áreas hoje. Restantes: ${rem}`;

    if(world.turnDraft?.phase === "ACTION"){
      bannerEl.textContent = "Você deve fazer uma ação nesta área antes de se mover para a próxima.";
      commitBtn.style.display = "";
      endBtn.style.display = "none";
    } else {
      bannerEl.textContent = "Você sobreviveu mais um dia. Escolha uma nova área para ir.";
      commitBtn.style.display = "none";
      endBtn.style.display = "";
    }

    const lines = [];
    lines.push(`Player: área ${world.entities.player.areaId}`);
    for(const npc of Object.values(world.entities.npcs)){
      lines.push(`${npc.name}: área ${npc.areaId}`);
    }
    entityLocsEl.value = lines.join("\n");
  }

  commitBtn.onclick = () => {
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

  endBtn.onclick = () => {
    // end day in current position
    world = nextWorld;
    resetTurnDraftForNewDay();
    saveToLocal(world);
    renderGame();
  };

  document.getElementById("regen").onclick = () => startNewGame(world.meta.mapSize);
  document.getElementById("resetProgress").onclick = () => {
    world.flags.visitedAreas = [1];
    world.entities.player.areaId = 1;
    focusedId = 1;
    resetTurnDraftForNewDay();
    saveToLocal(world);
    sync();
  };
  document.getElementById("saveLocal").onclick = () => { saveToLocal(world); alert("Salvo no navegador."); };
  document.getElementById("export").onclick = () => downloadJSON(world);
  document.getElementById("import").onchange = async (e) => {
    if(!file) return;
    try{
      const loaded = await uploadJSON(file);
      world = loaded;
      if(!world.turnDraft) resetTurnDraftForNewDay();
      saveToLocal(world);
      renderGame();
    } catch(err){ alert(err.message || "Falha ao importar."); }
  };
  document.getElementById("clearLocal").onclick = () => { clearLocal(); alert("Save apagado."); };
