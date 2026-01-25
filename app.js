import { MapSize, createInitialWorld } from "./state.js";
import { generateMapData } from "./mapgen.js";
import { MapUI } from "./mapui.js";
import { commitPlayerAction, useInventoryItem, moveActorOneStep, endDay } from "./sim.js";
import { getItemDef, getItemIcon, ItemTypes, displayDamageLabel, inventoryCount, INVENTORY_LIMIT, itemsReady } from "./items.js";
import { generateNpcIntents } from "./ai.js";
import { saveToLocal, loadFromLocal, clearLocal, downloadJSON, uploadJSON } from "./storage.js";

const root = document.getElementById("root");

// --- Global tooltip system (works on start screen and in-game) ---
const getUiTooltipEl = () => document.getElementById("uiTooltip");
let __tooltipsInit = false;
let tooltipActive = false;
let tooltipText = "";
function showTooltip(text){
  const uiTooltipEl = getUiTooltipEl();
  if(!uiTooltipEl) return;
  tooltipActive = true;
  tooltipText = String(text || "");
  uiTooltipEl.textContent = tooltipText;
  uiTooltipEl.classList.remove("hidden");
}
function hideTooltip(){
  tooltipActive = false;
  const uiTooltipEl = getUiTooltipEl();
  if(!uiTooltipEl) return;
  uiTooltipEl.classList.add("hidden");
}
function moveTooltip(e){
  const uiTooltipEl = getUiTooltipEl();
  if(!tooltipActive || !uiTooltipEl) return;
  const pad = 14;
  const w = uiTooltipEl.offsetWidth || 240;
  const h = uiTooltipEl.offsetHeight || 80;
  const x = clamp((e.clientX + 14), pad, window.innerWidth - w - pad);
  const y = clamp((e.clientY + 16), pad, window.innerHeight - h - pad);
  uiTooltipEl.style.left = `${x}px`;
  uiTooltipEl.style.top = `${y}px`;
}
function ensureTooltips(){
  if(__tooltipsInit) return;
  __tooltipsInit = true;
  document.addEventListener("mousemove", moveTooltip, { passive:true });
  document.addEventListener("mouseover", (e) => {
    const t = e.target?.closest?.("[data-tooltip]");
    if(!t) return;
    const txt = t.getAttribute("data-tooltip");
    if(txt) showTooltip(txt);
  });
  document.addEventListener("mouseout", (e) => {
    const t = e.target?.closest?.("[data-tooltip]");
    if(!t) return;
    hideTooltip();
  });
}

// Ensure item definitions are loaded before any UI/simulation tries to reference them.
try {
  await itemsReady;
} catch (e) {
  console.error(e);
  root.innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="h1">Arena Simulator</div>
        <div class="alert">Failed to load item definitions (data/items.json). Please reload.</div>
      </div>
    </div>
  `;
  throw e;
}

let world = null;

const uiState = {
  focusedAreaId: 1,
  phase: "needs_action", // needs_action | explore
  movesUsed: 0,
  dayEvents: [],
  selectedTarget: null,
  selectedGroundIndex: null,
  selectionMode: null, // "target" | "item" | null
  leftAlert: null,
  victoryDialogShown: false,
};

const MAX_MOVES_PER_DAY = 3;

// --- Tooltip helpers (single tooltip for the whole UI) ---
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function hash32(str){
  // Deterministic small hash (FNV-1a-ish)
  let h = 2166136261;
  for(let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // force unsigned 32-bit
  return h >>> 0;
}

function pickDeterministic(list, key){
  if(!list || list.length === 0) return "";
  const idx = hash32(key) % list.length;
  return list[idx];
}

function hpSignal(hp, key){
  if(hp <= 0) return pickDeterministic([
    "Falls lifeless.",
    "Drops to the ground, dead."
  ], key + ":hp:dead");
  if(hp <= 14) return pickDeterministic([
    "Barely standing, bleeding heavily.",
    "On the verge of physical collapse.",
    "Struggling to stay upright, bleeding heavily."
  ], key + ":hp:crit");
  if(hp <= 39) return pickDeterministic([
    "Bleeding heavily.",
    "Severely injured.",
    "Struggling to stay upright."
  ], key + ":hp:low");
  if(hp <= 69) return pickDeterministic([
    "Visible wounds.",
    "Clearly injured, but still standing.",
    "Blood is visible."
  ], key + ":hp:mid");
  return pickDeterministic([
    "No visible wounds.",
    "Minor cuts and scratches.",
    "Superficial injuries."
  ], key + ":hp:high");
}

function fpSignal(fp, key){
  if(fp <= 0) return "Collapses from exhaustion.";
  if(fp <= 9) return pickDeterministic([
    "Breathing is labored.",
    "Slow reactions.",
    "Movements are slowing."
  ], key + ":fp:crit");
  if(fp <= 19) return pickDeterministic([
    "Barely keeping pace.",
    "Hands tremble with fatigue.",
    "Struggling to stay focused."
  ], key + ":fp:low");
  if(fp <= 49) return pickDeterministic([
    "Breathing is faster.",
    "Showing signs of fatigue.",
    "Movement is less consistent."
  ], key + ":fp:mid");
  return pickDeterministic([
    "Steady and confident movements.",
    "Breathing is calm and controlled.",
    "Maintains a strong posture."
  ], key + ":fp:high");
}

function tierHP(hp){
  if(hp <= 0) return 4;
  if(hp <= 14) return 3;
  if(hp <= 39) return 2;
  if(hp <= 69) return 1;
  return 0;
}
function tierFP(fp){
  if(fp <= 0) return 3;
  if(fp <= 9) return 2;
  if(fp <= 19) return 1;
  return 0;
}

function statusTooltipFor(entity, worldMeta){
  const hp = Number(entity?.hp ?? 0);
  const fp = Number(entity?.fp ?? 0);
  const keyBase = `${worldMeta?.seed ?? 0}:${worldMeta?.day ?? 0}:${entity?.id ?? "?"}`;

  // Death is always just the HP signal.
  if(hp <= 0) return hpSignal(hp, keyBase);

  const hpT = tierHP(hp);
  const fpT = tierFP(fp);
  const hpS = hpSignal(hp, keyBase);
  const fpS = fpSignal(fp, keyBase);

  // Mold B: critical state -> two short sentences.
  if(hpT >= 3 || fpT >= 2){
    // Prioritize the worse axis first.
    if(hpT > fpT) return `${hpS} ${fpS}`;
    if(fpT > hpT) return `${fpS} ${hpS}`;
    return `${hpS} ${fpS}`;
  }

  // Mold A: one dominant axis
  const diff = Math.abs(hpT - fpT);
  if(diff >= 1){
    const connector = pickDeterministic(["but", "while", "despite", "even though"], keyBase + ":conn");
    if(hpT > fpT){
      return `${stripPeriod(hpS)}, ${connector} ${lowerFirst(stripPeriod(fpS))}.`;
    }
    if(fpT > hpT){
      return `${stripPeriod(fpS)}, ${connector} ${lowerFirst(stripPeriod(hpS))}.`;
    }
  }

  // Mold C: balanced
  return `${stripPeriod(hpS)} and ${lowerFirst(stripPeriod(fpS))}.`;
}

function stripPeriod(s){
  return String(s || "").replace(/\.$/, "").trim();
}
function lowerFirst(s){
  const t = String(s || "").trim();
  return t ? (t[0].toLowerCase() + t.slice(1)) : t;
}

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
  // Enable hover tooltips on the start screen as well.
  ensureTooltips();
  root.innerHTML = `
    <div class="screen">
      <div class="card">
        <div class="h1">Arena Simulator</div>
        <div class="muted">You start at the Cornucopia (Area 1). Each day: first commit an action, then you can move (up to 3 adjacent areas) and finish with End Day.</div>
        <hr class="sep" />

        <div class="h2" style="margin:0 0 6px 0;">Your attributes (20 points)</div>
        <div class="muted small" style="margin-bottom:10px;">Allocate 20 points across Strength (S), Dexterity (D), and Perception (P). Each attribute ranges from 0 to 10.</div>

        <div class="attrStack">
          <div class="attrRow">
            <div class="attrRowLabel"><span class="attrName">Strength</span> <span class="muted">(S)</span> <span class="helpIcon" data-tooltip="Determines who strikes first when attacks are mutual.">?</span></div>
            <div class="attrRowMin">0</div>
            <input id="attrF" class="hSlider" type="range" min="0" max="10" step="1" value="7" aria-label="Strength" />
            <div class="attrRowMax">10</div>
            <div class="attrRowVal" id="attrFVal">7</div>
          </div>

          <div class="attrRow">
            <div class="attrRowLabel"><span class="attrName">Dexterity</span> <span class="muted">(D)</span> <span class="helpIcon" data-tooltip="Prioritizes item pickups. Some weapons require Dexterity.">?</span></div>
            <div class="attrRowMin">0</div>
            <input id="attrD" class="hSlider" type="range" min="0" max="10" step="1" value="7" aria-label="Dexterity" />
            <div class="attrRowMax">10</div>
            <div class="attrRowVal" id="attrDVal">7</div>
          </div>

          <div class="attrRow">
            <div class="attrRowLabel"><span class="attrName">Perception</span> <span class="muted">(P)</span> <span class="helpIcon" data-tooltip="Helps avoid traps and threats. Low Perception is targeted more often.">?</span></div>
            <div class="attrRowMin">0</div>
            <input id="attrP" class="hSlider" type="range" min="0" max="10" step="1" value="6" aria-label="Perception" />
            <div class="attrRowMax">10</div>
            <div class="attrRowVal" id="attrPVal">6</div>
          </div>

          <div class="attrTotalRow">
            <div class="attrTotalLabel">Total</div>
            <div id="attrTotal" class="attrTotalValue">20 / 20</div>
            <div id="attrHint" class="attrTotalHint">OK</div>
          </div>

          <div class="muted small" style="margin-top:10px;">Tip: when the total is 20, you can only increase one attribute after reducing another.</div>
        </div>

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
            <option value="12">12</option>
            <option value="24" selected>24</option>
            <option value="36">36</option>
            <option value="48">48</option>
          </select>

          <label class="muted">Your district</label>
          <select id="district" class="select">
            ${Array.from({length:12}, (_,i)=>`<option value="${i+1}">District ${i+1}</option>`).join("")}
          </select>
        </div>

        <div class="row" style="margin-top:10px;">
          <button id="enter" class="btn primary" style="flex:1;" disabled>Enter arena</button>
          <button id="resume" class="btn">Resume</button>
          <button id="wipe" class="btn">Clear save</button>
        </div>
      </div>
    </div>
  `;

  const elF = document.getElementById("attrF");
  const elD = document.getElementById("attrD");
  const elP = document.getElementById("attrP");
  const elFVal = document.getElementById("attrFVal");
  const elDVal = document.getElementById("attrDVal");
  const elPVal = document.getElementById("attrPVal");
  const totalEl = document.getElementById("attrTotal");
  const hintEl = document.getElementById("attrHint");
  const enterBtn = document.getElementById("enter");

  const ATTR_MAX = 10;
  const ATTR_TOTAL = 20;

  // Sliders can never exceed a total of 7.
  // If the user tries to increase a slider beyond the available remaining points,
  // we automatically clamp the changed slider back down.
  const lastValid = {
    F: Number(elF.value) || 0,
    D: Number(elD.value) || 0,
    P: Number(elP.value) || 0,
  };

  function readVals(){
    return {
      F: Number(elF.value) || 0,
      D: Number(elD.value) || 0,
      P: Number(elP.value) || 0,
    };
  }

  function renderInvPills(inv){
    const items = Array.isArray(inv?.items) ? inv.items : [];
    if(!items.length) return `<span class="muted tiny">(empty)</span>`;
    return items.slice(0, 7).map(it => {
      const defId = it.defId;
      const def = getItemDef(defId);
      const icon = getItemIcon(defId);
      const qty = Number(it.qty || 1);
      const stack = qty > 1 ? ` x${escapeHtml(String(qty))}` : "";
      const title = escapeHtml(def?.description || "");
      return `<span class="debugItemPill" title="${title}"><span class="pillIcon" aria-hidden="true">${escapeHtml(icon)}</span>${escapeHtml(def?.name || defId)}${stack}</span>`;
    }).join("");
  }

  function writeVals(v){
    elF.value = String(v.F);
    elD.value = String(v.D);
    elP.value = String(v.P);
  }

  function updateLabels(v){
    elFVal.textContent = String(v.F);
    elDVal.textContent = String(v.D);
    elPVal.textContent = String(v.P);
  }

  function updateAttrsUI(){
    const v = readVals();
    let sum = v.F + v.D + v.P;
    totalEl.textContent = `${sum} / ${ATTR_TOTAL}`;

    if(sum === ATTR_TOTAL){
      hintEl.textContent = "OK";
      enterBtn.disabled = false;
    } else {
      const diff = ATTR_TOTAL - sum;
      hintEl.textContent = diff > 0 ? `Missing ${diff}` : `Reduce ${Math.abs(diff)}`;
      enterBtn.disabled = true;
    }
    updateLabels(v);
  }

  function onSliderInput(which){
    // Keep everything as ints 0..10
    const v = {
      F: Math.max(0, Math.min(ATTR_MAX, Math.round(Number(elF.value) || 0))),
      D: Math.max(0, Math.min(ATTR_MAX, Math.round(Number(elD.value) || 0))),
      P: Math.max(0, Math.min(ATTR_MAX, Math.round(Number(elP.value) || 0))),
    };

    let sum = v.F + v.D + v.P;
    if(sum > ATTR_TOTAL){
      const overflow = sum - ATTR_TOTAL;
      // Reduce ONLY the slider the user is currently changing.
      v[which] = Math.max(0, v[which] - overflow);
      writeVals(v);
      sum = v.F + v.D + v.P;
    }

    // Store last valid state (sum <= ATTR_TOTAL always holds here).
    lastValid.F = v.F; lastValid.D = v.D; lastValid.P = v.P;
    updateAttrsUI();
  }

  elF.addEventListener("input", () => onSliderInput("F"));
  elD.addEventListener("input", () => onSliderInput("D"));
  elP.addEventListener("input", () => onSliderInput("P"));
  // On change, ensure it snaps to an integer and stays consistent.
  [elF, elD, elP].forEach(el => el.addEventListener("change", () => updateAttrsUI()));
  updateAttrsUI();

  enterBtn.onclick = () => {
    const mapSize = Number(document.getElementById("size").value);
    const totalPlayers = Number(document.getElementById("players").value);
    const playerDistrict = Number(document.getElementById("district").value);
    const playerAttrs = {
      F: Number(elF.value) || 0,
      D: Number(elD.value) || 0,
      P: Number(elP.value) || 0,
    };
    startNewGame(mapSize, totalPlayers, playerDistrict, playerAttrs);
  };

  document.getElementById("resume").onclick = () => {
    const saved = loadFromLocal();
    if(!saved){ alert("No save found."); return; }
    world = saved;
    uiState.focusedAreaId = world.entities.player.areaId;
    uiState.phase = "needs_action";
    uiState.movesUsed = 0;
    uiState.dayEvents = [];
    uiState.deathDialogShown = false;
    uiState.victoryDialogShown = false;
    renderGame();
  };

  document.getElementById("wipe").onclick = () => {
    clearLocal();
    alert("Save cleared.");
  };
}

function startNewGame(mapSize, totalPlayers, playerDistrict, playerAttrs){
  const seed = (Math.random() * 1e9) | 0;
  const mapData = generateMapData({
    seed,
    regions: mapSize,
    width: 820,
    height: 820,
    paletteIndex: 0
  });

  world = createInitialWorld({ seed, mapSize, mapData, totalPlayers, playerDistrict, playerAttrs });

  uiState.focusedAreaId = 1;
  uiState.phase = "needs_action";
  uiState.movesUsed = 0;
  uiState.dayEvents = [];
  // Allow the death dialog to appear again after restarting.
  uiState.deathDialogShown = false;
  uiState.victoryDialogShown = false;

  saveToLocal(world);
  renderGame();
}

function renderGame(){
  root.innerHTML = `
    <div class="app">

      <!-- LEFT: player inventory + debug -->
      <aside class="panel" id="rightPanel">
        <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:6px;">
          <div class="h1" style="margin:0; display:flex; align-items:center; gap:8px;">YOU <span id="youPoison" class="poisonIcon hidden" title="Poisoned">☠</span></div>
          <div id="youMeta" class="muted small" style="text-align:right;"></div>
        </div>

        <div class="statBlock">
          <div class="statLine">
            <div class="muted small">HP <span id="youHpText"></span></div>
          </div>
          <div class="statBar"><div id="youHpBar" class="statFill"></div></div>
          <div class="statLine" style="margin-top:10px;">
            <div class="muted small">FP <span id="youFpText"></span></div>
          </div>
          <div class="statBar"><div id="youFpBar" class="statFill"></div></div>
        </div>

        <div class="section" style="margin-top:12px;">
          <div class="muted">Attack item</div>
          <div id="attackSlot" class="slotRow" style="margin-top:8px;"></div>
          <div class="muted" style="margin-top:10px;">Defense item</div>
          <div id="defenseSlot" class="slotRow" style="margin-top:8px;"></div>
          <div class="muted small" style="margin-top:10px;">Click a weapon to equip it for attacks. Click a Shield to equip it for defense.</div>
        </div>

        <div class="section" style="margin-top:12px;">
          <div class="muted">Inventory</div>
          <div class="muted small" style="margin-top:6px;">Limit: <span id="invCount"></span> / ${INVENTORY_LIMIT}</div>
          <div id="invPills" class="pillWrap" style="margin-top:10px;"></div>
          <div class="muted small" style="margin-top:10px;">Click a weapon to equip it. Click a Shield to set it as defense. Click a consumable to use it.</div>
        </div>

        <details id="debugDetails" class="section" style="margin-top:12px;">
          <summary class="muted" style="cursor:pointer;">Debug</summary>
          <div class="muted small" style="margin-top:6px;">Seed <span id="seed"></span></div>
          <div class="row" style="margin-top:8px;">
            <button id="debugAdvance" class="btn">Advance day</button>
          </div>
          <div class="muted small" style="margin-top:8px;">Entities (HP • area • S/D/P • K)</div>
          <div id="debugList" class="list" style="max-height:320px; overflow:auto;"></div>

          <div class="row" style="margin-top:10px; align-items:center; gap:8px;">
            <label class="muted small" style="display:inline-flex; align-items:center; gap:8px;">
              <input id="debugAiToggle" type="checkbox" /> AI metrics
            </label>
          </div>
          <div id="debugAiMetrics" class="muted small" style="margin-top:6px;"></div>

          <div class="muted" style="margin-top:12px;">Tools</div>
          <div class="row" style="margin-top:8px; flex-wrap:wrap; gap:8px;">
            <button id="regen" class="btn">New map</button>
            <button id="restart" class="btn">Restart</button>
            <button id="saveLocal" class="btn">Save</button>
            <button id="export" class="btn">Export JSON</button>
            <label class="btn" style="display:inline-flex; align-items:center; gap:8px;">
              Import <input id="import" type="file" accept="application/json" style="display:none" />
            </label>
            <button id="clearLocal" class="btn">Clear save</button>
          </div>
        </details>
      </aside>
    <main class="canvasWrap">
        <canvas id="c" width="820" height="820"></canvas>
        <div id="areaInfo" class="areaInfo">—</div>
        <div id="toastHost" class="toastHost" aria-live="polite" aria-relevant="additions"></div>
        <div class="hint">Cornucopia is Area 1 • Select an area to inspect • Move only after committing an action</div>
      </main>
      <!-- RIGHT: gameplay (actions + entities in your current area) -->
      <aside class="panel" id="leftPanel">
        <div class="panelHeader">
          <div class="h1" style="margin:0;">${(world && world.map && world.map.arenaName) ? world.map.arenaName : "Survival Arena"}</div>
          <div class="muted small">Day <span id="day"></span> • Area <span id="curArea"></span></div>
        </div>

        <div id="leftAlert" class="alert hidden">—</div>

        <div id="needsAction" class="section">
          <div class="banner">
            You must perform an action in this area before moving to the next one.
          </div>

          <div class="muted" style="margin-top:12px;">Players in the area</div>
          <div id="areaPills" class="pillWrap" style="margin-top:8px;"></div>

          <div id="groundItemWrap" class="hidden" style="margin-top:12px;">
            <div class="muted">Items on the ground</div>
            <div id="groundItemPills" class="pillWrap" style="margin-top:8px;"></div>
          </div>

          <div class="actionBar" id="needsActionBar">
          <div style="padding 8px" ;="">Possible Actions:</div>
            <div class="row" style="gap:8px; flex-wrap:wrap;">
            <button id="btnDefend" class="btn blue" style="flex:1; min-width:120px;">Defend</button>
            <button id="btnNothing" class="btn ghost" style="flex:1; min-width:120px;">Nothing</button>
            <button id="btnDrink" class="btn teal hidden" style="flex:1; min-width:120px;" data-tooltip="Restore 5 FP by drinking water">Drink water</button>
            <button id="btnSetNet" class="btn purple hidden" style="flex:1; min-width:120px;" data-tooltip="Set a Net trap here (activates tomorrow)">Set Net</button>
            <button id="btnSetMine" class="btn orange hidden" style="flex:1; min-width:120px;" data-tooltip="Set a Mine trap here (activates tomorrow)">Set Mine</button>
            <button id="btnAttack" class="btn red hidden" style="flex:1; min-width:120px;">Attack</button>
            <button id="btnCollect" class="btn hidden" style="flex:1; min-width:120px;" data-tooltip="Pick up the selected item">Collect item</button>
            </div>
            <div class="muted small" style="margin-top:8px;">Moves left today: <span id="movesLeft"></span></div>
          </div>
        </div>

        <div id="exploreState" class="section hidden">
          <div class="banner">
            You survived another day. You may move and then end the day.
          </div>
          <div class="actionBar" id="exploreActionBar">
          <div class="row">
            <button id="btnEndDay" class="btn green" style="width:100%; padding:12px 14px;">End Day</button>
          </div>
          <div class="muted small" style="margin-top:8px;">Moves left today: <span id="movesLeft2"></span></div>
          </div>
        </div>

        <div id="trappedState" class="section hidden">
          <div class="banner danger">
            You are trapped in a Net. You cannot act or move for <span id="trapDays"></span> day(s).
          </div>
          <div class="muted" style="margin-top:10px;">You can only escape by cutting the net with a Dagger.</div>
          <div class="actionBar" id="trappedActionBar">
          <div class="row" style="gap:8px; flex-wrap:wrap;">
            <button id="btnCutNet" class="btn red hidden" style="flex:1; min-width:160px;" data-tooltip="Consume 1 Dagger to escape">Cut net (Dagger)</button>
            <button id="btnEndDayTrapped" class="btn green" style="flex:1; min-width:160px;">End Day</button>
          </div>
        </div>
        </div>
      </aside>

      </div>

  `;

  const dayEl = document.getElementById("day");
  const seedEl = document.getElementById("seed");

  const curAreaEl = document.getElementById("curArea");

  const leftAlertEl = document.getElementById("leftAlert");
  const needsActionEl = document.getElementById("needsAction");
  const exploreStateEl = document.getElementById("exploreState");
  const trappedStateEl = document.getElementById("trappedState");
  const trapDaysEl = document.getElementById("trapDays");
  const movesLeftEl = document.getElementById("movesLeft");
  const movesLeftEl2 = document.getElementById("movesLeft2");
  const areaPillsEl = document.getElementById("areaPills");
  const groundItemWrap = document.getElementById("groundItemWrap");
  const groundItemPills = document.getElementById("groundItemPills");
  const btnDefend = document.getElementById("btnDefend");
  const btnNothing = document.getElementById("btnNothing");
  const btnDrink = document.getElementById("btnDrink");
  const btnSetNet = document.getElementById("btnSetNet");
  const btnSetMine = document.getElementById("btnSetMine");
  const btnAttack = document.getElementById("btnAttack");
  const btnCollect = document.getElementById("btnCollect");
  const btnEndDay = document.getElementById("btnEndDay");

  const btnCutNet = document.getElementById("btnCutNet");
  const btnEndDayTrapped = document.getElementById("btnEndDayTrapped");

  const debugList = document.getElementById("debugList");
  const debugAiToggle = document.getElementById("debugAiToggle");
  const debugAiMetrics = document.getElementById("debugAiMetrics");

  const youMetaEl = document.getElementById("youMeta");
  const youPoisonEl = document.getElementById("youPoison");
  const youHpTextEl = document.getElementById("youHpText");
  const youFpTextEl = document.getElementById("youFpText");
  const youHpBarEl = document.getElementById("youHpBar");
  const youFpBarEl = document.getElementById("youFpBar");
  const attackSlotEl = document.getElementById("attackSlot");
  const defenseSlotEl = document.getElementById("defenseSlot");
  const invCountEl = document.getElementById("invCount");
  const invPillsEl = document.getElementById("invPills");

  const areaInfoEl = document.getElementById("areaInfo");

  const toastHost = document.getElementById("toastHost");

  function pushToast(content, { kind="info", ttl=5000 } = {}){
    if(!toastHost) return;
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    if(Array.isArray(content)){
      el.innerHTML = content.map(line => `<div class="toastLine">${escapeHtml(String(line))}</div>`).join("");
    } else {
      el.textContent = String(content ?? "");
    }
    toastHost.appendChild(el);

    const remove = () => {
      if(!el.parentNode) return;
      el.classList.add("out");
      setTimeout(() => { el.remove(); }, 200);
    };

    el.addEventListener("click", remove);
    setTimeout(remove, Math.max(500, Number(ttl) || 5000));
  }

  function toastEvents(events, { limit=6 } = {}){
    const lines = formatEvents(events).filter(Boolean);
    if(!lines.length) return;
    const chunks = [];
    for(let i=0;i<lines.length;i+=limit) chunks.push(lines.slice(i, i+limit));
    for(const c of chunks) pushToast(c, { kind:"event" });
  }

  const canvas = document.getElementById("c");
  const mapUI = new MapUI({
    canvas,
    getCurrentAreaId: () => world?.entities?.player?.areaId ?? 1,
    canMove: () => uiState.phase === "explore",
    onAreaClick: (id) => {
      uiState.focusedAreaId = id;
      handleAreaClick(id);
      sync();
    }
  });

  function handleAreaClick(id){
    if(!world) return;

    // Always allow inspecting focus. Movement only in explore.
    if(uiState.phase !== "explore"){
      showLeftAlert("You must commit an action before moving.");
      return;
    }

    const cur = world.entities.player.areaId;
    if(id === cur) return;

    if(uiState.movesUsed >= MAX_MOVES_PER_DAY){
      showLeftAlert("You already moved 3 times today.");
      return;
    }

    const res = moveActorOneStep(world, "player", id);
    if(!res.ok){
      showLeftAlert("You can't move there.");
      return;
    }

    uiState.movesUsed += 1;
    uiState.dayEvents.push(...res.events);

    // If something immediate happened on entering (e.g., creature attack), show it now.
    const immediate = (res.events || []).some(e => (e.who === "player") && (e.type === "CREATURE_ATTACK" || e.type === "POISON_APPLIED" || e.type === "DEATH"));
    if(immediate){
      openResultDialog(res.events || []);
    }

    // Auto end the day once the 3rd move is taken.
    // This feels more natural than requiring an extra click.
    if(uiState.movesUsed >= MAX_MOVES_PER_DAY){
      // If the move killed the player (e.g., creature on enter), do not auto-end.
      if((world.entities.player.hp ?? 0) > 0){
        performEndDay();
        return;
      }
    }

    // reveal the destination immediately (spec: unlocking/revealing on click)
    saveToLocal(world);
    sync();
  }

  function resetDayState(){
    uiState.phase = "needs_action";
    uiState.movesUsed = 0;
    uiState.dayEvents = [];
    uiState.selectedTarget = null;
    uiState.selectedGroundIndex = null;
    uiState.selectionMode = null;
  }

  function showLeftAlert(msg){
    uiState.leftAlert = msg;
    if(leftAlertEl){
      leftAlertEl.textContent = msg;
      leftAlertEl.classList.remove("hidden");
    }
    setTimeout(() => {
      // Only hide if it's still the same message
      if(uiState.leftAlert === msg && leftAlertEl){
        leftAlertEl.classList.add("hidden");
      }
    }, 2800);
  }

  function renderAreaPills(){
    if(!areaPillsEl) return;

    const p = world.entities.player;

    // If trapped by a Net, force trapped UI state.
    if((p.trappedDays ?? 0) > 0 && (p.hp ?? 0) > 0){
      uiState.phase = "trapped";
    }
    const here = p.areaId;
    const npcsHere = Object.values(world.entities.npcs || {}).filter(n => (n.hp ?? 0) > 0 && n.areaId === here);
    const items = [
      { id:"player", name:"You", district:p.district, selectable:false, entity:p },
      ...npcsHere.map(n => ({ id:n.id, name:n.name, district:n.district, selectable:true, entity:n }))
    ];

    areaPillsEl.innerHTML = items.length ? items.map(t => {
      const selected = uiState.selectedTarget === t.id;
      const cls = `playerPill ${t.selectable ? "selectable" : ""} ${selected ? "selected" : ""}`;
      const tip = t.entity ? statusTooltipFor(t.entity, world?.meta) : "";
      const tipAttr = tip ? ` data-tooltip="${escapeHtml(tip)}"` : "";
      return `<button class="${cls}" data-id="${escapeHtml(t.id)}" ${t.selectable ? "" : "disabled"}${tipAttr}>
        <span class="pillName">${escapeHtml(t.name)}</span>
        <span class="pillSub">${escapeHtml(districtTag(t.district))}</span>
      </button>`;
    }).join("") : `<div class="muted small">No one here</div>`;

    // wire
    areaPillsEl.querySelectorAll(".playerPill.selectable").forEach(btn => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-id");
        uiState.selectedTarget = id;
        uiState.selectionMode = "target";
        uiState.selectedGroundIndex = null;
        btnAttack.classList.remove("hidden");
        // refresh selected style
        renderAreaPills();
        renderGroundItem();
      };
    });

    // show/hide attack
    if(uiState.selectedTarget && uiState.selectedTarget !== "player"){
      btnAttack.classList.remove("hidden");
    } else {
      btnAttack.classList.add("hidden");
    }

    // If we're not selecting a target, hide the attack option.
    if(uiState.selectionMode !== "target"){
      btnAttack.classList.add("hidden");
    }
  }

  function renderGroundItem(){
    const p = world.entities.player;
    const a = world.map.areasById[String(p.areaId)];
    const ground = Array.isArray(a?.groundItems) ? a.groundItems : [];
    if(!groundItemWrap || !groundItemPills) return;

    if(ground.length === 0){
      groundItemWrap.classList.add("hidden");
      btnCollect.classList.add("hidden");
      uiState.selectedGroundIndex = null;
      if(uiState.selectionMode === "item") uiState.selectionMode = null;
      return;
    }

    groundItemWrap.classList.remove("hidden");

    // If selection is out of range, clear it (do NOT auto-select).
    if(uiState.selectedGroundIndex != null && (uiState.selectedGroundIndex < 0 || uiState.selectedGroundIndex >= ground.length)){
      uiState.selectedGroundIndex = null;
      if(uiState.selectionMode === "item") uiState.selectionMode = null;
    }

    groundItemPills.innerHTML = ground.map((it, idx) => {
      const def = getItemDef(it.defId);
      const name = def ? def.name : it.defId;
      const icon = getItemIcon(it.defId);
      const qty = it.qty || 1;
      const dmg = def?.type === ItemTypes.WEAPON ? displayDamageLabel(def.id, qty) : "";
      const badge = def?.type === ItemTypes.WEAPON ? `<span class="pillBadge">${escapeHtml(dmg || "")}</span>` : "";
      const stack = qty > 1 ? ` x${escapeHtml(String(qty))}` : "";
      const tip = def ? buildItemTooltip(def, it, qty) : "";
      const sel = (idx === uiState.selectedGroundIndex) ? "selected" : "";
      return `<button class="itemPill ground ${sel}" data-gidx="${idx}" data-tooltip="${escapeHtml(tip)}">
        <span class="pillIcon" aria-hidden="true">${escapeHtml(icon)}</span>
        <span class="pillName">${escapeHtml(name)}${stack}</span>
        ${badge}
      </button>`;
    }).join("");

    groundItemPills.querySelectorAll(".itemPill.ground").forEach(btn => {
      btn.onclick = () => {
        const idx = Number(btn.getAttribute("data-gidx"));
        uiState.selectedGroundIndex = idx;
        uiState.selectionMode = "item";
        uiState.selectedTarget = null;
        renderAreaPills();
        renderGroundItem();
      };
    });

    // Show Collect only when an item is explicitly selected.
    if(uiState.selectionMode === "item" && uiState.selectedGroundIndex != null){
      btnCollect.classList.remove("hidden");
    } else {
      btnCollect.classList.add("hidden");
    }

    const full = inventoryCount(p.inventory) >= INVENTORY_LIMIT;
    btnCollect.disabled = full || uiState.phase !== "needs_action";
    btnCollect.setAttribute("data-tooltip", full ? "Inventory is full. Discard something first." : "Pick up the selected item");
  }

  function renderInventory(){
    const p = world.entities.player;
    // Header meta: district + attributes + poison
    const a = p.attrs || { F:0, D:0, P:0 };
    if(youMetaEl){
      const k = Number(p.kills || 0);
      youMetaEl.textContent = `D${p.district} • S${a.F} D${a.D} P${a.P} • K${k}`;
    }
    const poisoned = (p.status || []).some(s => s?.type === "poison");
    if(youPoisonEl){
      if(poisoned) youPoisonEl.classList.remove("hidden");
      else youPoisonEl.classList.add("hidden");
    }

    const hp = clamp(Number(p.hp ?? 100), 0, 100);
    const fp = clamp(Number(p.fp ?? 100), 0, 100);
    if(youHpTextEl) youHpTextEl.textContent = `${hp}/100`;
    if(youFpTextEl) youFpTextEl.textContent = `${fp}/100`;

    const hpPct = hp / 100;
    const fpPct = fp / 100;
    function barClass(pct){
      if(pct >= 0.5) return "good";
      if(pct >= 0.25) return "warn";
      return "bad";
    }
    if(youHpBarEl){
      youHpBarEl.style.width = `${Math.round(hpPct*100)}%`;
      youHpBarEl.classList.remove("good","warn","bad");
      youHpBarEl.classList.add(barClass(hpPct));
    }
    if(youFpBarEl){
      youFpBarEl.style.width = `${Math.round(fpPct*100)}%`;
      youFpBarEl.classList.remove("good","warn","bad");
      youFpBarEl.classList.add(barClass(fpPct));
    }
    invCountEl.textContent = String(inventoryCount(p.inventory));

    const items = p.inventory?.items || [];
    const weaponEq = p.inventory?.equipped?.weaponDefId;
    const defEq = p.inventory?.equipped?.defenseDefId;

    // Equipped slots (render as pills, even when empty)
    function renderEquipSlot(el, defId, kind){
      if(!el) return;
      if(!defId){
        const label = (kind === "weapon") ? "Attack Slot" : "Defense Slot";
        el.innerHTML = `<button class="itemPill emptySlot slotEquip" disabled aria-disabled="true" data-kind="${escapeHtml(kind)}" data-tooltip="Empty ${escapeHtml(label)}">
          <span class="pillIcon" aria-hidden="true">＋</span>
          <span class="pillName">${escapeHtml(label)}</span>
        </button>`;
        return;
      }

      const def = getItemDef(defId);
      const icon = getItemIcon(defId);
      const name = def?.name || defId;
      const tip = def ? def.description : "";
      // Click equipped slot to unequip.
      el.innerHTML = `<button class="itemPill slotEquip" data-kind="${escapeHtml(kind)}" data-tooltip="${escapeHtml(tip || "Click to unequip")}">
        <span class="pillIcon" aria-hidden="true">${escapeHtml(icon)}</span>
        <span class="pillName">${escapeHtml(name)}</span>
        <span class="pillSub">(equipped)</span>
      </button>`;
    }
    renderEquipSlot(attackSlotEl, weaponEq, "weapon");
    renderEquipSlot(defenseSlotEl, defEq, "defense");

    // Slot interactions (unequip)
    attackSlotEl?.querySelectorAll(".slotEquip:not(.emptySlot)").forEach(btn => {
      btn.onclick = () => {
        if(p.inventory?.equipped) p.inventory.equipped.weaponDefId = null;
        saveToLocal(world);
        renderInventory();
        pushToast("Attack slot cleared.");
      };
    });
    defenseSlotEl?.querySelectorAll(".slotEquip:not(.emptySlot)").forEach(btn => {
      btn.onclick = () => {
        if(p.inventory?.equipped) p.inventory.equipped.defenseDefId = null;
        saveToLocal(world);
        renderInventory();
        pushToast("Defense slot cleared.");
      };
    });

    // Render fixed inventory slots (video-game style): always show INVENTORY_LIMIT pills.
    // Filled pills map 1:1 to items[] indices; remaining slots are empty placeholders.
    const slots = Array.from({ length: INVENTORY_LIMIT }, (_, slotIdx) => {
      const it = items[slotIdx];
      if(!it){
        return `<button class="itemPill emptySlot" disabled aria-disabled="true" data-tooltip="Empty slot">
          <span class="pillIcon" aria-hidden="true">＋</span>
          <span class="pillName">Empty</span>
        </button>`;
      }

      const def = getItemDef(it.defId);
      const name = def ? def.name : it.defId;
      const qty = it.qty || 1;
      const dmg = def?.type === ItemTypes.WEAPON ? displayDamageLabel(def.id, qty) : "";
      const eq = (weaponEq && it.defId === weaponEq) ? "equipped" : "";
      const de = (defEq && it.defId === defEq) ? "defEquipped" : "";
      const badge = def?.type === ItemTypes.WEAPON ? `<span class="pillBadge">${escapeHtml(dmg || "")}</span>` : "";
      const stack = qty > 1 ? ` x${escapeHtml(String(qty))}` : "";
      const tooltip = buildItemTooltip(def, it, qty);
      return `<button class="itemPill ${eq} ${de}" data-idx="${slotIdx}" data-tooltip="${escapeHtml(tooltip)}">
        <span class="pillIcon" aria-hidden="true">${escapeHtml(getItemIcon(it.defId))}</span>
        <span class="pillName">${escapeHtml(name)}${stack}</span>
        ${badge}
        <span class="pillRemove" data-remove-idx="${slotIdx}" title="Discard">×</span>
      </button>`;
    });

    invPillsEl.innerHTML = slots.join("");

    // interactions
    // Remove buttons
    invPillsEl.querySelectorAll(".pillRemove").forEach(x => {
      x.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(x.getAttribute("data-remove-idx"));
        const it = items[idx];
        const def = it ? getItemDef(it.defId) : null;
        const name = def?.name || it?.defId || "item";
        const p = world.entities.player;
        if(p?.inventory?.items?.[idx]){
          p.inventory.items.splice(idx, 1);
          if(p.inventory?.equipped?.weaponDefId && !p.inventory.items.some(it2 => it2.defId === p.inventory.equipped.weaponDefId)) p.inventory.equipped.weaponDefId = null;
          if(p.inventory?.equipped?.defenseDefId && !p.inventory.items.some(it2 => it2.defId === p.inventory.equipped.defenseDefId)) p.inventory.equipped.defenseDefId = null;
          saveToLocal(world);
          renderInventory();
          pushToast(`Discarded ${name}.`);
        }
      };
    });

    // Only interactive pills (ignore empty placeholders)
    invPillsEl.querySelectorAll(".itemPill:not(.emptySlot)").forEach(btn => {
      btn.onclick = () => {
        const idx = Number(btn.getAttribute("data-idx"));
        const it = items[idx];
        const def = getItemDef(it.defId);
        if(!def) return;

        if(def.type === ItemTypes.WEAPON){
          p.inventory.equipped.weaponDefId = def.id;
          saveToLocal(world);
          renderInventory();
          return;
        }
        if(def.type === ItemTypes.PROTECTION){
          p.inventory.equipped.defenseDefId = def.id;
          saveToLocal(world);
          renderInventory();
          return;
        }
        if(def.type === ItemTypes.CONSUMABLE){
          // Use immediately (dialogs are reserved for death/victory)
          const res = useInventoryItem(world, "player", idx, "player");
          world = res.nextWorld;
          uiState.dayEvents.push(...(res.events || []));
          saveToLocal(world);
          renderInventory();
          toastEvents(res.events || []);
          return;
        }
      };
    });
  }

  function buildItemTooltip(def, it, qty){
    if(!def) return "";
    const lines = [];
    lines.push(def.name);
    if(def.type === ItemTypes.WEAPON){
      const dmg = displayDamageLabel(def.id, qty);
      if(dmg) lines.push(`Damage: ${dmg}`);
    }
    if(def.type === ItemTypes.PROTECTION){
      lines.push("Protection item.");
    }
    if(def.type === ItemTypes.CONSUMABLE){
      lines.push("Consumable.");
    }
    if(it?.usesLeft != null) lines.push(`Uses left: ${it.usesLeft}`);
    if(def.description) lines.push(def.description);
    return lines.join("\n");
  }

  function sync(){
    if(!world) return;

    dayEl.textContent = String(world.meta.day);
    seedEl.textContent = String(world.meta.seed);

    const p = world.entities.player;

    curAreaEl.textContent = String(p.areaId);

    renderInventory();
    renderGroundItem();

    const movesLeft = Math.max(0, MAX_MOVES_PER_DAY - uiState.movesUsed);
    movesLeftEl.textContent = String(movesLeft);
    if(movesLeftEl2) movesLeftEl2.textContent = String(movesLeft);

    // Panel state toggles
    if(uiState.phase === "needs_action"){
      needsActionEl.classList.remove("hidden");
      exploreStateEl.classList.add("hidden");
      if(trappedStateEl) trappedStateEl.classList.add("hidden");
    } else if(uiState.phase === "trapped"){
      needsActionEl.classList.add("hidden");
      exploreStateEl.classList.add("hidden");
      if(trappedStateEl) trappedStateEl.classList.remove("hidden");
    } else {
      needsActionEl.classList.add("hidden");
      exploreStateEl.classList.remove("hidden");
      if(trappedStateEl) trappedStateEl.classList.add("hidden");
    }

    // Contextual actions for the current area
    const curArea = world.map.areasById[String(p.areaId)];
    const canDrink = uiState.phase === "needs_action" && !!curArea?.hasWater;
    if(btnDrink){
      if(canDrink) btnDrink.classList.remove("hidden");
      else btnDrink.classList.add("hidden");
    }

    // Trap-related actions
    const invItems = p.inventory?.items || [];
    const hasNet = invItems.some(it => it.defId === "net" && (it.qty || 1) > 0);
    const hasMine = invItems.some(it => it.defId === "mine" && (it.qty || 1) > 0);
    if(btnSetNet){
      if(uiState.phase === "needs_action" && hasNet) btnSetNet.classList.remove("hidden");
      else btnSetNet.classList.add("hidden");
    }
    if(btnSetMine){
      if(uiState.phase === "needs_action" && hasMine) btnSetMine.classList.remove("hidden");
      else btnSetMine.classList.add("hidden");
    }

    // Trapped UI
    if(uiState.phase === "trapped"){
      if(trapDaysEl) trapDaysEl.textContent = String(p.trappedDays ?? 0);
      const hasDagger = invItems.some(it => it.defId === "dagger" && (it.qty || 1) > 0);
      if(btnCutNet){
        if(hasDagger) btnCutNet.classList.remove("hidden");
        else btnCutNet.classList.add("hidden");
      }
    }

    // Map overlay area info (focused area)
    const focus = uiState.focusedAreaId;
    const a = world.map.areasById[String(focus)];
    const visited = world.flags.visitedAreas.includes(focus);
    const revealed = visited || focus === p.areaId;
    const biome = revealed ? (a?.biome || "—") : "Unknown";
    const water = revealed ? ((a?.hasWater) ? "Yes" : "No") : "Unknown";
    const status = visited ? "Visited" : (revealed ? "Revealed" : "Hidden");
    areaInfoEl.innerHTML = `
      <div><strong>Area ${escapeHtml(String(focus))}</strong></div>
      <div class="muted tiny">Biome: ${escapeHtml(String(biome))}</div>
      <div class="muted tiny">Water: ${escapeHtml(String(water))}</div>
      <div class="muted tiny">Status: ${escapeHtml(String(status))}</div>
    `;

    // Left panel pills (current area occupants)
    renderAreaPills();

    // Debug list (compact)
    if(debugList){
      const everyone = [
        { id: "player", name: "You", district: p.district, hp: p.hp ?? 100, fp: p.fp ?? 100, areaId: p.areaId, dead: (p.hp ?? 0) <= 0, attrs: p.attrs, inv: p.inventory, kills: p.kills || 0 },
        ...Object.values(world.entities.npcs || {}).map(n => ({
          id: n.id,
          name: n.name,
          district: n.district,
          hp: n.hp ?? 100,
          fp: n.fp ?? 100,
          areaId: n.areaId,
          dead: (n.hp ?? 0) <= 0,
          attrs: n.attrs,
          inv: n.inventory,
          kills: n.kills || 0,
        }))
      ];
      everyone.sort((a,b) => (a.dead - b.dead) || (a.areaId - b.areaId) || String(a.name).localeCompare(String(b.name)));
      debugList.innerHTML = everyone.map(t => {
        const status = t.dead ? "DEAD" : "ALIVE";
        const F = t.attrs?.F ?? 0;
        const D = t.attrs?.D ?? 0;
        const P = t.attrs?.P ?? 0;
        const K = Number(t.kills || 0);
        const invHtml = renderInvPills(t.inv);
        return `<div class="debugCard ${t.dead ? "dead" : ""}">
          <div class="debugTop"><strong>${escapeHtml(t.name)}</strong><span class="muted tiny">${escapeHtml(districtTag(t.district))}</span></div>
          <div class="debugBottom"><span>HP ${escapeHtml(String(t.hp))}</span><span>FP ${escapeHtml(String(t.fp ?? 100))}</span><span>Area ${escapeHtml(String(t.areaId))}</span><span>F${escapeHtml(String(F))} D${escapeHtml(String(D))} P${escapeHtml(String(P))}</span><span>K${escapeHtml(String(K))}</span><span>${status}</span></div>
          <div class="debugInv">${invHtml}</div>
        </div>`;
      }).join("") || `<div class="muted small">—</div>`;
    }

    // Debug AI metrics (toggle)
    if(debugAiToggle && debugAiMetrics){
      if(debugAiToggle.checked){
        const last = Array.isArray(world.log?.days) ? world.log.days[world.log.days.length - 1] : null;
        const d = last?.debug || null;
        if(d){
          debugAiMetrics.innerHTML =
            `<div>NPCs sharing an area: <strong>${escapeHtml(String(d.sharedNpcCount ?? "—"))}</strong></div>` +
            `<div>NPC attacks: possible <strong>${escapeHtml(String(d.attacksPossible ?? "—"))}</strong> • executed <strong>${escapeHtml(String(d.attacksExecuted ?? "—"))}</strong></div>`;
        } else {
          debugAiMetrics.innerHTML = `<div class="muted small">No metrics for this day yet.</div>`;
        }
      } else {
        debugAiMetrics.innerHTML = "";
      }
    }

    mapUI.setData({ world, paletteIndex: 0 });
    mapUI.render();

    // If player died, lock controls
    const dead = (p.hp ?? 0) <= 0;
    const everyoneAlive = [
      { id: "player", hp: p.hp ?? 100 },
      ...Object.values(world.entities.npcs || {}).map(n => ({ id: n.id, hp: n.hp ?? 100 }))
    ].filter(x => (x.hp ?? 0) > 0);
    const playerWon = !dead && (everyoneAlive.length === 1) && (everyoneAlive[0].id === "player");

    if(playerWon){
      showLeftAlert("Victory. You are the last tribute alive.");
      openVictoryDialog();
      btnDefend.disabled = true;
      btnNothing.disabled = true;
      if(btnDrink) btnDrink.disabled = true;
      btnAttack.disabled = true;
      btnCollect.disabled = true;
      btnEndDay.disabled = true;
      return;
    }
    if(dead){
      showLeftAlert("You died. Restart the game.");
      // Show a dedicated game over dialog (e.g., if the area vanished).
      const a = world?.map?.areasById?.[String(p.areaId)];
      const reason = (a && a.isActive === false) ? "area_closed" : "death";
      openDeathDialog({ reason });
      btnDefend.disabled = true;
      btnNothing.disabled = true;
      if(btnDrink) btnDrink.disabled = true;
      btnAttack.disabled = true;
      btnCollect.disabled = true;
      btnEndDay.disabled = true;
    } else {
      btnDefend.disabled = false;
      btnNothing.disabled = false;
      if(btnDrink) btnDrink.disabled = false;
      btnAttack.disabled = (Number(p.fp ?? 0) < 10);
      // Collect availability handled in renderGroundItem()
      btnEndDay.disabled = false;
    }
  }

  // Action buttons (commit immediately)
  btnDefend.onclick = () => {
    if(!world) return;
    const { nextWorld, events } = commitPlayerAction(world, { kind:"DEFEND" });
    world = nextWorld;
    uiState.dayEvents.push(...events);
    uiState.phase = "explore";
    saveToLocal(world);
    sync();
    openResultDialog(events);
  };

  btnNothing.onclick = () => {
    if(!world) return;
    const kind = "NOTHING";
    const { nextWorld, events } = commitPlayerAction(world, { kind });
    world = nextWorld;
    uiState.dayEvents.push(...events);
    uiState.phase = "explore";
    saveToLocal(world);
    sync();
    if(shouldShowActionResult(kind, events)) openResultDialog(events);
  };

  btnDrink.onclick = () => {
    if(!world) return;
    const p = world.entities.player;
    const a = world.map.areasById[String(p.areaId)];
    if(!a?.hasWater){
      showLeftAlert("There is no water here.");
      return;
    }
    const { nextWorld, events } = commitPlayerAction(world, { kind:"DRINK" });
    world = nextWorld;
    uiState.dayEvents.push(...events);
    uiState.phase = "explore";
    saveToLocal(world);
    sync();
    openResultDialog(events);
  };

  if(btnSetNet){
    btnSetNet.onclick = () => {
      if(!world) return;
      const { nextWorld, events } = commitPlayerAction(world, { kind:"SET_TRAP", trapDefId:"net" });
      world = nextWorld;
      uiState.dayEvents.push(...events);
      uiState.phase = "explore";
      saveToLocal(world);
      sync();
      openResultDialog(events);
    };
  }

  if(btnSetMine){
    btnSetMine.onclick = () => {
      if(!world) return;
      const { nextWorld, events } = commitPlayerAction(world, { kind:"SET_TRAP", trapDefId:"mine" });
      world = nextWorld;
      uiState.dayEvents.push(...events);
      uiState.phase = "explore";
      saveToLocal(world);
      sync();
      openResultDialog(events);
    };
  }

  if(btnCutNet){
    btnCutNet.onclick = () => {
      if(!world) return;
      const { nextWorld, events } = commitPlayerAction(world, { kind:"CUT_NET" });
      world = nextWorld;
      uiState.dayEvents.push(...events);
      // Cutting the net counts as your action for the day.
      uiState.phase = "explore";
      saveToLocal(world);
      sync();
      openResultDialog(events);
    };
  }

  btnCollect.onclick = () => {
    if(!world) return;
    if(uiState.selectionMode !== "item" || uiState.selectedGroundIndex == null){
      showLeftAlert("Select an item to collect.");
      return;
    }
    const { nextWorld, events } = commitPlayerAction(world, { kind:"COLLECT", itemIndex: uiState.selectedGroundIndex });
    world = nextWorld;
    uiState.dayEvents.push(...events);
    uiState.phase = "explore";
    saveToLocal(world);
    sync();
    openResultDialog(events);
  };

  btnAttack.onclick = () => {
    if(!world) return;
    if(!uiState.selectedTarget || uiState.selectedTarget === "player"){
      showLeftAlert("Select a player to attack.");
      return;
    }
    const { nextWorld, events } = commitPlayerAction(world, { kind:"ATTACK", targetId: uiState.selectedTarget });
    world = nextWorld;
    uiState.dayEvents.push(...events);
    uiState.phase = "explore";
    saveToLocal(world);
    sync();
    openResultDialog(events);
  };

  function performEndDay(){
    if(!world) return;
    const intents = generateNpcIntents(world);
    world = endDay(world, intents, uiState.dayEvents);
    uiState.focusedAreaId = world.entities.player.areaId;
    resetDayState();
    saveToLocal(world);
    sync();
    const evs = world.log.days[world.log.days.length-1]?.events || [];
    if(shouldShowEndDayDialog(evs)) openEndDayDialog(evs);
  }

  btnEndDay.onclick = () => {
    performEndDay();
  };

  if(btnEndDayTrapped){
    btnEndDayTrapped.onclick = () => btnEndDay.onclick();
  }

  document.getElementById("debugAdvance").onclick = () => {
    if(!world) return;

    // If user hasn't committed an action yet, auto-commit NOTHING for testing.
    if(uiState.phase === "needs_action"){
      const { nextWorld, events } = commitPlayerAction(world, { kind:"NOTHING" });
      world = nextWorld;
      uiState.dayEvents.push(...events);
      uiState.phase = "explore";
    }

    const intents = generateNpcIntents(world);
    world = endDay(world, intents, uiState.dayEvents);
    uiState.focusedAreaId = world.entities.player.areaId;
    resetDayState();
    saveToLocal(world);
    sync();
    const evs = world.log.days[world.log.days.length-1]?.events || [];
    if(shouldShowEndDayDialog(evs)) openEndDayDialog(evs);
  };

  document.getElementById("regen").onclick = () => {
    startNewGame(world.meta.mapSize, world.meta.totalPlayers || 24, world.entities.player.district || 12);
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
    resetDayState();
    saveToLocal(world);
    sync();
  };

  document.getElementById("clearLocal").onclick = () => {
    clearLocal();
    alert("Save cleared. Refresh and start a new game.");
  };

  mapUI.setData({ world, paletteIndex: 0 });
  sync();

  // Prevent opening multiple death dialogs.
  if(!uiState.deathDialogShown) uiState.deathDialogShown = false;
  if(!uiState.victoryDialogShown) uiState.victoryDialogShown = false;

  function openResultDialog(events){
    // UI change: results are shown as toasts (dialogs are reserved for death/victory).
    toastEvents(events);
  }

  function openDeathDialog({ reason = "death" } = {}){
    // Avoid stacking dialogs.
    if(uiState.deathDialogShown) return;
    uiState.deathDialogShown = true;

    const player = world?.entities?.player;
    const area = player ? world?.map?.areasById?.[String(player.areaId)] : null;
    const diedFromClosedArea = (reason === "area_closed") || (area && area.isActive === false);

    const title = "Game over";
    const msg = diedFromClosedArea
      ? "Your area vanished. You died."
      : "You died.";

    const overlay = document.createElement("div");
    overlay.className = "modalOverlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="h1" style="margin:0;">${title}</div>
        <div class="muted" style="margin-top:8px;">${msg}</div>

        <div class="row" style="margin-top:14px; justify-content:flex-end; gap:8px;">
          <button id="restartGame" class="btn danger">Restart</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector("#restartGame").onclick = () => {
      clearLocal();
      world = null;
      uiState.deathDialogShown = false;
      overlay.remove();
      renderStart();
    };
  }

  function openVictoryDialog(){
    if(uiState.victoryDialogShown) return;
    uiState.victoryDialogShown = true;

    const overlay = document.createElement("div");
    overlay.className = "modalOverlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="h1" style="margin:0;">Victory</div>
        <div class="muted" style="margin-top:8px;">Congratulations. You are the last tribute alive.</div>

        <div class="row" style="margin-top:14px; justify-content:flex-end; gap:8px;">
          <button id="restartGame" class="btn primary">Restart</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector("#restartGame").onclick = () => {
      clearLocal();
      world = null;
      uiState.deathDialogShown = false;
      uiState.victoryDialogShown = false;
      overlay.remove();
      renderStart();
    };
  }

  function shouldShowActionResult(kind, events){
    // Show when the player chose a meaningful action OR something meaningful happened.
    if(kind !== "NOTHING") return true;

    const notes = (events || []).filter(e => e.type === "NOTHING").map(e => e.note).filter(Boolean);
    const nonQuietNote = notes.find(n => n !== "quiet_day");
    if(nonQuietNote) return true;

    // Only show a popup for NOTHING if something affected *you*.
    const affectsPlayer = (e) => {
      if(!e) return false;
      const who = e.who ?? null;
      const target = e.target ?? e.targetId ?? null;
      if(who === "player") return true;
      if(target === "player") return true;
      return false;
    };

    const meaningfulTypes = new Set([
      "DAMAGE_RECEIVED",
      "DEATH",
      "SELF_DAMAGE",
      "POISON_APPLIED",
      "POISON_TICK",
      "SHIELD_BLOCK",
      "SHIELD_BROKEN",
      "FLASK_REVEAL",
      "HEAL",
      "DRINK",
      "EAT",
      "STARVING"
    ]);
    return (events || []).some(e => meaningfulTypes.has(e.type) && affectsPlayer(e));
  }

  function formatEvents(events){
    const npcName = (id) => {
      if(id === "player") return "You";
      const n = world?.entities?.npcs?.[id];
      return n?.name || id;
    };

    const out = [];
    for(const e of (events || [])){
      switch(e.type){
        case "USE_ITEM": {
          if(e.ok){
            const def = getItemDef(e.itemDefId);
            const nm = def?.name || e.itemDefId;
            out.push(`You used ${nm}.`);
          } else {
            out.push("You tried to use an item, but it failed.");
          }
          break;
        }
        case "INVISIBLE": {
          if(e.who === "player") out.push("You are camouflaged for the day.");
          break;
        }
        case "ATTACK": {
          if(e.ok){
            const weap = e.weapon ? ` with ${e.weapon}` : "";
            if(e.dmgDealt === 0) out.push(`You attacked ${npcName(e.target)}${weap}, but it was blocked.`);
            else out.push(`You attacked ${npcName(e.target)}${weap} and dealt ${e.dmgDealt} damage.`);
          } else {
            if(e.reason === "target_invisible") out.push("You tried to attack, but the target was invisible.");
            else if(e.reason === "too_tired") out.push("You are too exhausted to attack.");
            else out.push("You tried to attack, but there was no valid target.");
          }
          break;
        }
        case "FP_COST": {
          if(e.who !== "player") break;
          const kind = String(e.kind || "ACTION");
          const spent = Number(e.spent || 0);
          const fp = Number(e.fp ?? 0);
          // Avoid spamming for NOTHING.
          if(kind === "NOTHING") break;
          out.push(`You spent ${spent} FP (${kind}). FP is now ${fp}.`);
          break;
        }
        case "DEFEND": {
          out.push(e.with ? `You defended with ${e.with}.` : "You defended.");
          break;
        }
        case "DRINK": {
          if(e.ok){
            if((e.gained || 0) > 0) out.push(`You drank water and restored ${e.gained} FP.`);
            else out.push("You drank water, but your FP was already full.");
          } else {
            out.push("You tried to drink water, but there was no water here.");
          }
          break;
        }
        case "TRAP_SET": {
          if(e.ok){
            const def = getItemDef(e.trapDefId);
            const nm = def?.name || e.trapDefId;
            out.push(`You set a ${nm}. It will activate on Day ${e.armedOnDay}.`);
          } else {
            out.push("You tried to set a trap, but it failed.");
          }
          break;
        }
        case "TRAPPED": {
          out.push(`You are trapped for ${e.days} more day(s).`);
          break;
        }
        case "CUT_NET": {
          if(e.ok) out.push("You cut the net with a Dagger and escaped.");
          else out.push("You tried to cut the net, but you have no Dagger.");
          break;
        }
        case "NET_TRIGGER": {
          // Area-wide event. Only show if player is in that area.
          if(e.areaId === world?.entities?.player?.areaId){
            if(e.caught?.length) out.push(`A Net trap caught: ${e.caught.map(npcName).join(", ")}.`);
            else out.push("A Net trap triggered, but caught no one.");
          }
          break;
        }
        case "MINE_BLAST": {
          if(e.injured?.length){
            out.push(`A mine exploded somewhere in the arena. Injured: ${e.injured.map(npcName).join(", ")}.`);
          } else {
            out.push("A mine exploded somewhere in the arena.");
          }
          break;
        }
        case "CREATURE_ATTACK": {
          if(e.who === "player"){
            out.push(`${e.creature} attacked you. You lost ${e.dmg} HP.`);
          } else {
            out.push(`${e.creature} attacked ${npcName(e.who)}.`);
          }
          break;
        }
        case "NOTHING": {
          out.push("You did nothing.");
          if(e.note === "caught_off_guard") out.push("You were caught off guard.");
          if(e.note === "quiet_day") out.push("Nothing happened.");
          if(e.note === "camouflage_prevented_attack") out.push("Your camouflage prevented an ambush.");
          break;
        }
        case "COLLECT": {
          if(e.ok){
            if(e.queued){
              const def = getItemDef(e.itemDefId);
              const nm = def?.name || e.itemDefId;
              const qty = e.qty && e.qty > 1 ? ` x${e.qty}` : "";
              out.push(`You will attempt to collect ${nm}${qty} when the day ends.`);
              break;
            }
            if(e.opened){
              out.push("You opened a backpack.");
              if(e.gained?.length) out.push(`You gained: ${e.gained.map(x => getItemDef(x)?.name || x).join(", ")}.`);
            } else {
              const def = getItemDef(e.itemDefId);
              const nm = def?.name || e.itemDefId;
              const qty = e.qty && e.qty > 1 ? ` x${e.qty}` : "";
              out.push(`You picked up ${nm}${qty}.`);
            }
          } else {
            if(e.reason === "inventory_full") out.push("You couldn't pick it up: your inventory is full.");
            else out.push("You couldn't pick up the item.");
          }
          break;
        }
        case "SHIELD_BLOCK": {
          if(e.who === "player") out.push("Your shield blocked the attack.");
          else out.push(`${npcName(e.who)} blocked the attack with a shield.`);
          break;
        }
        case "SHIELD_BROKEN": {
          out.push(`${npcName(e.who)}'s shield was broken.`);
          break;
        }
        case "SELF_DAMAGE": {
          out.push(`You were hurt by your own ${e.weapon} (${e.dmg} damage).`);
          break;
        }
        case "POISON_APPLIED": {
          out.push(`${npcName(e.who)} was poisoned.`);
          break;
        }
        case "POISON_TICK": {
          out.push(`${npcName(e.who)} took ${e.dmg} poison damage.`);
          break;
        }
        case "HEAL": {
          if(e.who === "player") out.push(`You healed ${e.amount} HP.`);
          else out.push(`${npcName(e.who)} healed ${e.amount} HP.`);
          break;
        }
        case "POISON_CURED": {
          if(e.who === "player") out.push("Your poison was cured.");
          else out.push(`${npcName(e.who)}'s poison was cured.`);
          break;
        }
        case "FLASK_REVEAL": {
          out.push(`The flask was ${e.kind}.`);
          break;
        }
        case "MOVE": {
          out.push(`You moved from Area ${e.from} to Area ${e.to}.`);
          break;
        }
        case "DAMAGE_RECEIVED": {
          if(e.from === "environment") out.push(`You took ${e.dmg} damage from the environment.`);
          else out.push(`You took ${e.dmg} damage from ${npcName(e.from)}.`);
          break;
        }
        case "INFO": {
          if(e.msg) out.push(e.msg);
          break;
        }
        case "DEATH": {
          if(e.who === "player"){
            if(e.reason === "area_closed") out.push("You died: your area vanished.");
            else if(e.reason === "starvation") out.push("You died of starvation.");
            else out.push("You died.");
          }
          else out.push(`${npcName(e.who)} died.`);
          break;
        }

        case "EAT": {
          if(e.who === "player") out.push("You found food and restored your fatigue.");
          else out.push(`${npcName(e.who)} found food.`);
          break;
        }
        case "ARRIVAL": {
          out.push(`${npcName(e.who)} arrived in your area (Area ${e.to}).`);
          break;
        }
        default:
          break;
      }
    }
    return out;
  }

  function openEndDayDialog(events){
    // UI change: end-of-day notifications are toasts (no dialog).
    const npcName = (id) => {
      if(id === "player") return "You";
      const n = world?.entities?.npcs?.[id];
      return n?.name || id;
    };

    const evs = Array.isArray(events) ? events : [];

    const deadIds = new Set();
    for(const e of evs){
      if(e?.type === "DEATH" && e.who) deadIds.add(e.who);
      if(e?.type === "MINE_BLAST" && Array.isArray(e.dead)){
        for(const id of e.dead){ if(id) deadIds.add(id); }
      }
    }
    deadIds.delete("player");
    const deadNames = Array.from(deadIds).map(id => npcName(id));
    const cannonCount = deadNames.length;

    if(cannonCount > 0){
      pushToast(`Cannon shots: ${cannonCount}`, { kind:"event" });
      const list = deadNames.slice(0, 10);
      const suffix = deadNames.length > 10 ? ` (+${deadNames.length - 10} more)` : "";
      pushToast([`Fallen tributes:`, `${list.join(", ")}${suffix}`], { kind:"event" });
    }

    const dmgLines = [];
    for(const e of evs){
      if(!e || e.who !== "player") continue;
      if(e.type === "POISON_TICK") dmgLines.push(`Poison: -${e.dmg} HP`);
      else if(e.type === "MINE_HIT") dmgLines.push(`Mine: -${e.dmg} HP`);
      else if(e.type === "CREATURE_ATTACK") dmgLines.push(`${e.creature}: -${e.dmg} HP`);
    }
    if(dmgLines.length){
      pushToast(["End of day damage:", ...dmgLines], { kind:"danger" });
    }

    const other = evs.filter(e => e && (e.type === "INFO"));
    for(const e of other){
      if(e.msg) pushToast(String(e.msg), { kind:"info" });
    }
  }

  function shouldShowEndDayDialog(events){
    // Only show the end-of-day popup if something meaningful happened:
    // - any tribute died (including the player)
    // - the player took damage during the day rollover (poison tick, mine, daily threat)
    const evs = Array.isArray(events) ? events : [];
    let anyDeath = false;
    for(const e of evs){
      if(!e) continue;
      if(e.type === "DEATH" && e.who) { anyDeath = true; break; }
      if(e.type === "MINE_BLAST" && Array.isArray(e.dead) && e.dead.length) { anyDeath = true; break; }
    }
    if(anyDeath) return true;

    const rolloverDamage = evs.some(e => e && e.who === "player" && ["POISON_TICK","MINE_HIT","CREATURE_ATTACK","HOSTILE_EVENT","LASER"].includes(e.type) && Number(e.dmg || 0) > 0);
    return rolloverDamage;
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

// Debug helper: render an inventory as compact pills.
// This must live at the top-level because sync() uses it.
function renderInvPills(inv){
  const items = Array.isArray(inv?.items) ? inv.items : [];
  if(!items.length) return `<span class="muted tiny">(empty)</span>`;
  return items.slice(0, 7).map(it => {
    const defId = it.defId;
    const def = getItemDef(defId);
    const icon = getItemIcon(defId);
    const qty = Number(it.qty || 1);
    const stack = qty > 1 ? ` x${escapeHtml(String(qty))}` : "";
    const title = escapeHtml(def?.description || "");
    return `<span class="debugItemPill" title="${title}"><span class="pillIcon" aria-hidden="true">${escapeHtml(icon)}</span>${escapeHtml(def?.name || defId)}${stack}</span>`;
  }).join("");
}

renderStart();
