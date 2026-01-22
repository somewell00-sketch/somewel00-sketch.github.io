import { MapSize, createInitialWorld } from "./state.js";
import { generateMapData } from "./mapgen.js";
import { MapUI } from "./mapui.js";
import { advanceDay } from "./sim.js";
import { saveToLocal, loadFromLocal, clearLocal, downloadJSON, uploadJSON } from "./storage.js";

const root = document.getElementById("root");

let world = null;
let paletteIndex = 0;

function renderStart(){
  root.innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="h1">Arena</div>
        <div class="muted">Choose your setup and enter the arena. O motor roda por dias e é determinístico por seed.</div>
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

          <button id="enter" class="btn">Enter arena</button>
          <button id="resume" class="btn">Continuar save</button>
        </div>
        <div class="muted small" style="margin-top:10px;">
          Dica: rode em servidor local (ex: <code>python -m http.server</code>).
        </div>
      </div>
    </div>
  `;

  document.getElementById("enter").onclick = () => {
    const mapSize = Number(document.getElementById("size").value);
    startNewGame(mapSize);
  };

  document.getElementById("resume").onclick = () => {
    const saved = loadFromLocal();
    if(!saved){
      alert("Nenhum save encontrado.");
      return;
    }
    world = saved;
    renderGame();
  };
}

function startNewGame(mapSize, totalPlayers, playerDistrict){
  const seed = (Math.random() * 1e9) | 0;
  const mapData = generateMapData({
    seed,
    regions: mapSize,
    width: 820,
    height: 820,
    paletteIndex
  });

  world = createInitialWorld({ seed, mapSize, mapData, totalPlayers, playerDistrict });
  saveToLocal(world);
  renderGame();
}

function renderGame(){
  root.innerHTML = `
    <div class="app">
      <aside class="panel">
        <div class="row" style="justify-content:space-between;">
          <div>
            <div class="h1" style="margin:0;">Area Inspector</div>
            <div class="muted small">Dia: <span id="day"></span> • Seed: <span id="seed"></span></div>
          </div>
        </div>

        <div class="row">
          <button id="nextDay" class="btn">Passar o dia</button>
          <button id="regen" class="btn">Novo mapa</button>
          <button id="resetProgress" class="btn">Reiniciar progresso</button>
        </div>

        <div class="row">
          <button id="saveLocal" class="btn">Salvar</button>
          <button id="export" class="btn">Export JSON</button>
          <label class="btn" style="display:inline-flex; align-items:center; gap:8px;">
            Import JSON <input id="import" type="file" accept="application/json" style="display:none" />
          </label>
          <button id="clearLocal" class="btn">Apagar save</button>
        </div>

        <div class="row">
          <span class="pill"><span class="swatch" id="swatch"></span><span id="title">—</span></span>
          <span class="pill" id="visitedCount">Visitadas: —</span>
        </div>

        
        <div class="muted">Occupants</div>
        <div id="occupants" class="list"></div>

<div class="kv">
          <div>Número</div><div id="infoNum">—</div>
          <div>Bioma</div><div id="infoBiome">—</div>
          <div>Cor</div><div id="infoColor">—</div>
          <div>Água</div><div id="infoWater">—</div>
          <div>Visitada</div><div id="infoVisited">—</div>
          <div>Visitável</div><div id="infoVisit">—</div>
        </div>

        <div class="muted">Notas</div>
        <textarea id="notes" placeholder="Depois você pode anexar infos por área."></textarea>

        <div class="muted small">Atalho: [1] muda paleta (placeholder)</div>
      </aside>

      <main class="canvasWrap">
        <canvas id="c" width="820" height="820"></canvas>
        <div class="hint">Mapa = UI • Simulação por dias • Água = lago/pântano/rios</div>
      </main>
    </div>
  `;

  const dayEl = document.getElementById("day");
  const seedEl = document.getElementById("seed");
  const swatch = document.getElementById("swatch");
  const title = document.getElementById("title");
  const visitedCount = document.getElementById("visitedCount");
  const infoNum = document.getElementById("infoNum");
  const infoBiome = document.getElementById("infoBiome");
  const infoColor = document.getElementById("infoColor");
  const infoWater = document.getElementById("infoWater");
  const infoVisited = document.getElementById("infoVisited");
  const infoVisit = document.getElementById("infoVisit");

  const canvas = document.getElementById("c");
  const mapUI = new MapUI({
    canvas,
    onAreaClick: (id) => {
      // clicar sempre mostra info; só move se for visitável
      const cur = world.entities.player.areaId;
      const adj = world.map.adjById[String(cur)] || [];
      const canMove = (id === cur) || adj.includes(id);

      setFocus(id);

      if (canMove){
        // registrar ação do jogador no dia atual (sem avançar o dia ainda)
        ensureReplaySlot(world);
        world.replay.playerActionsByDay[world.meta.day - 1].push({ type: "MOVE", payload: { toAreaId: id } });

        // aplicar movimento imediatamente como UX (a regra real está no motor também)
        // (isso mantém “mapa como UI” ainda ok porque é só uma projeção; o motor vai confirmar no advanceDay)
        world.entities.player.areaId = id;
        const v = new Set(world.flags.visitedAreas);
        v.add(id); v.add(1);
        world.flags.visitedAreas = Array.from(v).sort((a,b)=>a-b);

        saveToLocal(world);
        sync();
      }
    }
  });

  function ensureReplaySlot(w){
    while(w.replay.playerActionsByDay.length < w.meta.day){
      w.replay.playerActionsByDay.push([]);
    }
  }

  let focusedId = world.entities.player.areaId;

  function setFocus(id){
    focusedId = id;
    const info = mapUI.getAreaInfo(id);
    if(!info) return;

    title.textContent = (info.id === 1) ? `Área ${info.id} (🍞)` : `Área ${info.id}`;
    swatch.style.background = info.color;
    infoNum.textContent = String(info.id);
    infoBiome.textContent = info.biome;
    infoColor.textContent = info.color;
    infoWater.textContent = info.hasWater ? "Sim" : "Não";
    infoVisited.textContent = info.visited ? "Sim" : "Não";
    infoVisit.textContent = info.visitable ? "Sim (adjacente)" : "Não";
  }

  function sync(){
    dayEl.textContent = String(world.meta.day);
    seedEl.textContent = String(world.meta.seed);
    visitedCount.textContent = `Visitadas: ${world.flags.visitedAreas.length}`;
    mapUI.setData({ world, paletteIndex });
    setFocus(focusedId);
  }

  // Buttons
  document.getElementById("nextDay").onclick = () => {
    // motor aplica as ações do dia (e NPC intents)
    const actions = world.replay.playerActionsByDay[world.meta.day - 1] || [];
    const { nextWorld } = advanceDay(world, actions);

    world = nextWorld;
    saveToLocal(world);
    sync();
  };

  document.getElementById("regen").onclick = () => {
    // novo mapa (mantém meta/day? aqui vou resetar jogo)
    startNewGame(world.meta.mapSize, world.meta.totalPlayers || 12, world.entities.player.district || 12);
  };

  document.getElementById("resetProgress").onclick = () => {
    world.flags.visitedAreas = [1];
    world.entities.player.areaId = 1;
    focusedId = 1;
    saveToLocal(world);
    sync();
  };

  document.getElementById("saveLocal").onclick = () => {
    saveToLocal(world);
    alert("Salvo no navegador.");
  };

  document.getElementById("export").onclick = () => downloadJSON(world);

  document.getElementById("import").onchange = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    try{
      const loaded = await uploadJSON(file);
      world = loaded;
      saveToLocal(world);
      renderGame(); // re-render inteira
    } catch(err){
      alert(err.message || "Falha ao importar.");
    }
  };

  document.getElementById("clearLocal").onclick = () => {
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


function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
