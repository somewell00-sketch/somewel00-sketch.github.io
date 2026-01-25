import { BIOME_PT, PALETTES, BIOME_BG } from "./mapgen.js";

function rgbaFromHex(hex, a){
  const h = hex.replace("#","");
  const r = parseInt(h.slice(0,2), 16);
  const g = parseInt(h.slice(2,4), 16);
  const b = parseInt(h.slice(4,6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function drawPath(ctx, poly){
  ctx.beginPath();
  ctx.moveTo(poly[0][0], poly[0][1]);
  for(let i=1;i<poly.length;i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.closePath();
}

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

const polylabelFn =
  (typeof window.polylabel === "function") ? window.polylabel :
  (window.polylabel && typeof window.polylabel.default === "function") ? window.polylabel.default :
  null;

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

function drawSafeLabel(ctx, poly, label, isEmoji){
  if (!polylabelFn) return;
  const p = polylabelFn([poly], 1.0);
  const x = p[0], y = p[1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const r = inradiusAtPoint(poly, x, y);
  if (!Number.isFinite(r) || r <= 0.1) return;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = isEmoji
    ? "28px system-ui, -apple-system, Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif"
    : "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

  const m = ctx.measureText(label);
  const w = m.width;
  const h = isEmoji ? 28 : 14;
  const box = r * 1.35;
  const scale = Math.min(box / w, box / h, 1);
  if (scale < 0.35){ ctx.restore(); return; }

  ctx.translate(x, y);
  ctx.scale(scale, scale);

  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.50)";
  ctx.fillStyle = isEmoji ? "rgba(255,255,255,0.95)" : "rgba(20,20,24,0.95)";
  ctx.strokeText(label, 0, 0);
  ctx.fillText(label, 0, 0);

  ctx.restore();
}

// --- Narrative tooltip text (5–7 words), with biome variations ---
const NOISE_TEXT_BY_BIOME = {
  default: {
    silent: [
      "Only wind and distant stillness",
      "Nothing seems to have happened here",
      "The area feels untouched and calm",
    ],
    quiet: [
      "Faint traces of recent passage",
      "Something passed through, long ago",
      "The place feels mostly undisturbed",
    ],
    noisy: [
      "Signs of recent movement everywhere",
      "This place has drawn attention",
      "Activity lingers in the air",
    ],
    high: [
      "Voices and movement echo nearby",
      "This area feels dangerously active",
      "Someone is definitely close",
    ],
    unknown: [
      "The territory remains unknown",
      "No information about this place",
      "What lies here is uncertain",
    ]
  },

  // Biome-specific variants (still short, still ambiguous)
  desert: {
    silent: ["Heat shimmers, nothing else moves", "Dry air, absolute quiet", "Sand lies still and empty"],
    quiet: ["Footprints fade beneath drifting sand", "Dry tracks, then sudden silence", "A hush settles over the dunes"],
    noisy: ["Sand shifts with hurried movement", "Dust trails linger in sunlight", "Activity stirs across the dunes"],
    high: ["Shouts carry across open sand", "Movement storms through the dunes", "Someone is running close by"],
  },
  glacier: {
    silent: ["Ice creaks, then falls silent", "Frozen air, nothing stirs", "Stillness wrapped in brittle cold"],
    quiet: ["Cracks suggest recent passage", "Cold tracks fade into frost", "Faint echoes under the ice"],
    noisy: ["Ice chips scatter from quick steps", "Sharp echoes bounce off ice", "Movement rings through the glacier"],
    high: ["Cracking ice, voices very near", "The glacier shakes with movement", "Someone is dangerously close now"],
  },
  tundra: {
    silent: ["Snowfields lie flat and quiet", "Only wind over empty frost", "Cold stillness presses all around"],
    quiet: ["Faint tracks cross the snow", "A passage, then bitter calm", "The tundra feels mostly undisturbed"],
    noisy: ["Snow crunches with recent movement", "Activity disturbs the white silence", "Something stirs beyond the drift"],
    high: ["Voices cut through frozen air", "Footfalls pound across hard snow", "Someone is definitely close"],
  },
  mountain: {
    silent: ["Thin air and distant stillness", "Rocks watch in quiet calm", "Only wind along the ridges"],
    quiet: ["Loose gravel hints at passage", "A path disturbed, then calm", "Echoes fade into the peaks"],
    noisy: ["Echoes carry from recent movement", "Stones tumble, voices somewhere", "Activity clings to the cliffs"],
    high: ["Shouts ricochet between the peaks", "Heavy steps shake loose stone", "Someone is very close"],
  },
  forest: {
    silent: ["Leaves barely stir in silence", "Birds quiet, woods listening", "Still canopy, no recent signs"],
    quiet: ["Twigs snapped, then calm returns", "A trail disturbed, now quiet", "Faint rustle, far away"],
    noisy: ["Branches sway with recent movement", "Footsteps disturb the undergrowth", "Activity ripples through the trees"],
    high: ["Voices thread between the trunks", "The forest trembles with movement", "Someone is definitely close"],
  },
  woods: {
    silent: ["Woods feel calm and untouched", "Only wind in the branches", "Everything holds its breath"],
    quiet: ["Faint tracks weave between trees", "A passage, then quiet returns", "The grove feels mostly undisturbed"],
    noisy: ["Leaves scatter from hurried movement", "Recent activity stirs the grove", "This place has drawn attention"],
    high: ["Voices echo through the woods", "Movement closes in fast", "Someone is definitely close"],
  },
  jungle: {
    silent: ["Humidity hangs, surprisingly quiet", "Vines still, no fresh signs", "A heavy calm settles here"],
    quiet: ["Faint disturbance in tangled vines", "Something passed, the jungle waits", "The canopy hides old tracks"],
    noisy: ["Leaves whip from recent movement", "Life stirs, footsteps nearby", "Activity lingers in thick air"],
    high: ["Crashing foliage, voices close", "The jungle roars with movement", "Someone is dangerously close"],
  },
  swamp: {
    silent: ["Still water, no ripples", "Murk rests in quiet silence", "Only insects in the gloom"],
    quiet: ["Mud prints sink into stillness", "Faint splashes, then silence", "The swamp feels mostly undisturbed"],
    noisy: ["Water churns with recent movement", "Mud churned, something passed", "Activity lingers in the mire"],
    high: ["Splashes and voices very near", "The mire thrashes with movement", "Someone is definitely close"],
  },
  lake: {
    silent: ["Water lies flat and quiet", "Only distant ripples remain", "The shore feels calm"],
    quiet: ["Faint tracks along the shore", "A passage, then still water", "The lake feels mostly undisturbed"],
    noisy: ["Ripples spread from recent movement", "The shore shows fresh activity", "This place has drawn attention"],
    high: ["Splashes echo nearby", "Voices carry across the water", "Someone is definitely close"],
  },
  industrial: {
    silent: ["Machines rest, the metal quiet", "Empty halls, no recent noise", "Only distant hum remains"],
    quiet: ["Scuffs suggest recent passage", "A faint clank, then calm", "The place feels mostly undisturbed"],
    noisy: ["Footsteps ring through metal", "Echoes linger in empty halls", "This place has drawn attention"],
    high: ["Loud echoes, movement very near", "Metal shakes with heavy steps", "Someone is dangerously close"],
  },
  fairy: {
    silent: ["Air sparkles, eerily quiet", "Soft glow, no recent signs", "Stillness feels almost magical"],
    quiet: ["Faint shimmer marks a passage", "Whispers fade into calm", "The grove feels mostly undisturbed"],
    noisy: ["Glittering trails hint at movement", "The air stirs with activity", "This place has drawn attention"],
    high: ["Whispers rush, movement very near", "Magic crackles in the air", "Someone is definitely close"],
  },
};

function _hashStr(s){
  const str = String(s || "");
  let h = 2166136261;
  for(let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickVariant(list, seed){
  const arr = Array.isArray(list) ? list : [];
  if(!arr.length) return "";
  const idx = (seed >>> 0) % arr.length;
  return arr[idx];
}

export class MapUI {
  constructor({ canvas, onAreaClick, getCurrentAreaId, canMove, options }){
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onAreaClick = onAreaClick;
    this.getCurrentAreaId = getCurrentAreaId || (() => (this.world?.entities?.player?.areaId ?? 1));
    this.canMove = canMove || (() => true);

    // Rendering options
    // - followPlayer: keeps the current area centered and applies a zoom factor
    // - zoom: additional zoom multiplier (only meaningful when followPlayer=true)
    // - draggable: allow panning the map by dragging
    // - smooth: animate camera transitions between areas
    // - smoothness: 0..1, higher = snappier (only meaningful when smooth=true)
    // - showViewport: draw the main map viewport rectangle (useful for minimaps)
    // - getViewportRect: () => {x0,y0,x1,y1} in geom coords
    this.options = Object.assign({
      followPlayer: false,
      zoom: 1,
      padding: 18,
      draggable: false,
      smooth: false,
      smoothness: 0.22,
      showViewport: false,
      getViewportRect: null,
    }, options || {});

    // Current view transform (geom -> canvas)
    this._view = { s: 1, tx: 0, ty: 0, geomW: 1, geomH: 1, canvasW: this.canvas.width, canvasH: this.canvas.height };
    this._viewTarget = null;
    this._raf = null;
    this._lastTs = null;

    // Drag-to-pan state (in canvas pixels)
    this._pan = { x: 0, y: 0 };
    this._drag = { active: false, moved: false, startX: 0, startY: 0, lastX: 0, lastY: 0 };

    this.hoveredId = null;
    // Last mouse position in canvas pixels (used to anchor tooltips).
    this._mouse = { cx: 0, cy: 0, has: false };

    canvas.addEventListener("mousemove", (e) => this.handleMove(e));
    canvas.addEventListener("mouseleave", () => {
      this.hoveredId = null;
      if(this._mouse) this._mouse.has = false;
      this.render();
    });
    canvas.addEventListener("click", (e) => this.handleClick(e));

    // Pointer events for dragging (safer across mouse/touch)
    canvas.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
    window.addEventListener("pointermove", (e) => this.handlePointerMove(e));
    window.addEventListener("pointerup", (e) => this.handlePointerUp(e));
    window.addEventListener("pointercancel", (e) => this.handlePointerUp(e));
  }

  setData({ world, paletteIndex=0 }){
    this.world = world;
    this.paletteIndex = paletteIndex;
    this.geom = world?.map?.uiGeom || null;
    this.render();
  }

  isVisitable(areaId){
    const cur = this.getCurrentAreaId();
    if (areaId === cur) return true;
    const adj = this.world.map.adjById[String(cur)] || [];
    return adj.includes(areaId);
  }

  canvasToWorld(evt){
    const rect = this.canvas.getBoundingClientRect();
    const cx = (evt.clientX - rect.left) * (this.canvas.width / rect.width);
    const cy = (evt.clientY - rect.top) * (this.canvas.height / rect.height);
    const v = this._view || { s: 1, tx: 0, ty: 0 };
    const s = Number(v.s) || 1;
    const x = (cx - (Number(v.tx) || 0)) / s;
    const y = (cy - (Number(v.ty) || 0)) / s;
    return { x, y, cx, cy };
  }

  hitTest(x,y){
    const cells = this.geom.cells;
    for(let i=cells.length-1; i>=0; i--){
      const c = cells[i];
      if(pointInPoly(x,y,c.poly)) return c.id;
    }
    return null;
  }

  handleMove(e){
    const {x,y,cx,cy} = this.canvasToWorld(e);
    const id = this.hitTest(x,y);

    // Hover/tooltip should work for *any* area under the cursor (even if not currently visitable).
    // Clicking is still restricted by canMove() + isVisitable().
    const nextHover = (id != null) ? id : null;

    this._mouse.cx = cx;
    this._mouse.cy = cy;
    this._mouse.has = (id != null);

    const enabled = !!this.canMove();
    if(nextHover !== this.hoveredId){
      this.hoveredId = nextHover;
      this.render();
    }
    this.canvas.style.cursor = (enabled && id != null && this.isVisitable(id)) ? "pointer" : "default";
  }

  handleClick(e){
    // If the user dragged, don't treat it as a click-to-move.
    if(this._drag?.moved) return;
    const {x,y} = this.canvasToWorld(e);
    const id = this.hitTest(x,y);
    if(id == null) return;
    // Clicking should follow the same rules as hovering:
    // only allow moves when movement is enabled and the destination is visitable.
    const enabled = !!this.canMove();
    if(!enabled) return;
    if(!this.isVisitable(id)) return;
    this.onAreaClick(id);
  }

  // --- Tooltip helpers ---
  _normalizeNoise(level){
    const v = String(level || "").toLowerCase();
    if(v === "high" || v === "highly" || v === "highly_noisy" || v === "very_noisy") return "high";
    if(v === "noisy") return "noisy";
    if(v === "silent") return "silent";
    if(v === "unknown") return "unknown";
    return "quiet";
  }

  _noisePhrase(areaId, biomeKey, level, day){
    const norm = this._normalizeNoise(level);
    const key = String(biomeKey || "").toLowerCase();
    const pack = NOISE_TEXT_BY_BIOME[key] || NOISE_TEXT_BY_BIOME.default;
    const list = (pack && pack[norm]) ? pack[norm] : (NOISE_TEXT_BY_BIOME.default[norm] || []);
    const seed = (Number(areaId)||0) * 73856093 ^ (Number(day)||0) * 19349663 ^ _hashStr(key) ^ _hashStr(norm);
    return pickVariant(list, seed);
  }

  _statusPhrase(area, day){
    if(!area) return null;
    if(area.isActive === false) return "Sealed. Entry is impossible.";
    if(Number(area.willCloseOnDay) === Number(day) + 1) return "The zone may seal by tomorrow.";
    return null;
  }

  _getTooltipLines(areaId){
    const area = this.world?.map?.areasById?.[String(areaId)] || null;
    const visited = new Set(this.world?.flags?.visitedAreas || []).has(areaId);
    const day = Number(this.world?.meta?.day ?? 1);

    // Unknown areas: keep it short and explicit.
    if(!visited || !area){
      const seed = (Number(areaId)||0) * 2654435761 ^ (Number(day)||0) * 97;
      const unknown = pickVariant(NOISE_TEXT_BY_BIOME.default.unknown, seed);
      return [
        `Area ${areaId}`,
        "Biome unknown.",
        unknown || "The territory remains unknown",
      ];
    }

    const biomeKey = String(area.biome || "");
    const biomeLabel = BIOME_PT[biomeKey] || biomeKey || "Unknown";
    const noiseState = area.noiseState || area.noise || area.noisy || "quiet";

    const lines = [];
    lines.push(`Area ${areaId}`);
    lines.push(`Biome: ${biomeLabel}`);
    lines.push(this._noisePhrase(areaId, biomeKey, noiseState, day));

    const st = this._statusPhrase(area, day);
    if(st) lines.push(st);

    if(area.hasWater) lines.push("You hear water nearby.");

    // Optional: add short flavor cues if present.
    const flavor = area?.flavorText || null;
    if(typeof flavor === "string" && flavor.trim()) lines.push(flavor.trim());

    return lines;
  }

  _drawTooltip(){
    if(!this._mouse?.has) return;
    if(this.hoveredId == null) return;
    if(!this.world) return;

    const ctx = this.ctx;
    const lines = this._getTooltipLines(this.hoveredId);
    if(!lines || !lines.length) return;

    // Layout in canvas space.
    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);

    const pad = 10;
    const lineH = 18;
    const maxW = 340;

    ctx.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

    // Measure width.
    let w = 0;
    for(const t of lines){
      w = Math.max(w, ctx.measureText(String(t)).width);
    }
    w = Math.min(maxW, Math.ceil(w));
    const h = pad*2 + lineH*lines.length;

    // Anchor near cursor but keep on-screen.
    let x = (Number(this._mouse.cx) || 0) + 14;
    let y = (Number(this._mouse.cy) || 0) + 14;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const boxW = w + pad*2;
    const boxH = h;
    if(x + boxW > cw - 8) x = cw - boxW - 8;
    if(y + boxH > ch - 8) y = ch - boxH - 8;
    x = Math.max(8, x);
    y = Math.max(8, y);

    // Background
    ctx.fillStyle = "rgba(12,12,14,0.88)";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    const r = 10;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + boxW, y, x + boxW, y + boxH, r);
    ctx.arcTo(x + boxW, y + boxH, x, y + boxH, r);
    ctx.arcTo(x, y + boxH, x, y, r);
    ctx.arcTo(x, y, x + boxW, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Text
    let ty = y + pad + 2;
    for(let i=0;i<lines.length;i++){
      const t = String(lines[i]);
      if(i === 0){
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      } else {
        ctx.fillStyle = "rgba(235,235,238,0.90)";
        ctx.font = "500 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      }
      ctx.fillText(t, x + pad, ty + i*lineH);
    }

    ctx.restore();
  }

  getViewRectGeom(){
    const v = this._view || { s: 1, tx: 0, ty: 0 };
    const s = Number(v.s) || 1;
    const tx = Number(v.tx) || 0;
    const ty = Number(v.ty) || 0;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    return {
      x0: (0 - tx) / s,
      y0: (0 - ty) / s,
      x1: (cw - tx) / s,
      y1: (ch - ty) / s,
    };
  }

  computeView(){
    const geom = this.geom;
    const canvas = this.canvas;
    const cw = canvas.width;
    const ch = canvas.height;
    const gw = Number(geom?.width || cw) || cw;
    const gh = Number(geom?.height || ch) || ch;

    // Fit the geom space into the canvas.
    const baseScale = Math.min(cw / gw, ch / gh);
    const baseTx = (cw - gw * baseScale) / 2;
    const baseTy = (ch - gh * baseScale) / 2;

    const follow = !!this.options.followPlayer;
    // Default zoom when following the player (can be overridden via options.zoom)
    const zoom = follow ? (Number(this.options.zoom) || 2.6) : 1;
    const pad = Number(this.options.padding) || 18;

    let s = baseScale * zoom;
    let tx = baseTx;
    let ty = baseTy;

    if(follow){
      const curId = this.getCurrentAreaId();
      const cell = (geom?.cells || []).find(c => c?.id === curId);
      let px = cell?.center?.x;
      let py = cell?.center?.y;
      if(!Number.isFinite(px) || !Number.isFinite(py)){
        // Fallback: approximate center from polygon vertices.
        const poly = cell?.poly || null;
        if(Array.isArray(poly) && poly.length){
          let sx = 0, sy = 0;
          for(const p of poly){ sx += p[0]; sy += p[1]; }
          px = sx / poly.length;
          py = sy / poly.length;
        } else {
          px = gw/2; py = gh/2;
        }
      }

      tx = (cw / 2) - (px * s);
      ty = (ch / 2) - (py * s);

      // Apply user pan (dragging) in canvas space.
      if(!!this.options.draggable){
        tx += (Number(this._pan?.x) || 0);
        ty += (Number(this._pan?.y) || 0);
      }

      // Clamp so the map doesn't drift too far outside the canvas.
      const minTx = cw - (gw * s) - pad;
      const maxTx = pad;
      const minTy = ch - (gh * s) - pad;
      const maxTy = pad;
      tx = Math.max(minTx, Math.min(maxTx, tx));
      ty = Math.max(minTy, Math.min(maxTy, ty));
    }

    return { s, tx, ty, geomW: gw, geomH: gh, canvasW: cw, canvasH: ch };
  }

  // --- Drag-to-pan handlers (optional) ---
  handlePointerDown(e){
    if(!this.options.draggable) return;
    // Only start drag on primary button/touch.
    if(e.button != null && e.button !== 0) return;
    this._drag.active = true;
    this._drag.moved = false;
    this._drag.startX = e.clientX;
    this._drag.startY = e.clientY;
    this._drag.lastX = e.clientX;
    this._drag.lastY = e.clientY;
    try { this.canvas.setPointerCapture?.(e.pointerId); } catch(_){ }
  }

  handlePointerMove(e){
    if(!this.options.draggable) return;
    if(!this._drag.active) return;
    const dx = e.clientX - this._drag.lastX;
    const dy = e.clientY - this._drag.lastY;
    this._drag.lastX = e.clientX;
    this._drag.lastY = e.clientY;

    const totalDx = e.clientX - this._drag.startX;
    const totalDy = e.clientY - this._drag.startY;
    if(Math.hypot(totalDx, totalDy) > 4) this._drag.moved = true;

    this._pan.x += dx;
    this._pan.y += dy;

    // Re-render smoothly if enabled.
    this.render();
  }

  handlePointerUp(e){
    if(!this.options.draggable) return;
    if(!this._drag.active) return;
    this._drag.active = false;
    // If it was just a tap (no move), allow normal click handling.
    // If it was a drag, keep the pan and stop.
    // Reset moved flag shortly after so a click event that fires right after doesn't move.
    if(this._drag.moved){
      setTimeout(() => { if(this._drag) this._drag.moved = false; }, 0);
    }
  }

  _stepAnimation(ts){
    if(!this.world || !this.geom) return;
    const target = this._viewTarget;
    if(!target) return;

    const cur = this._view || target;
    const last = this._lastTs;
    const dt = (typeof last === "number") ? Math.min(64, Math.max(0, ts - last)) : 16.67;
    this._lastTs = ts;

    const smoothness = Math.max(0.01, Math.min(0.85, Number(this.options.smoothness) || 0.22));
    // Convert smoothness to a per-frame lerp based on dt.
    const a = 1 - Math.pow(1 - smoothness, dt / 16.67);

    const lerp = (x, y) => x + (y - x) * a;

    const next = {
      s: lerp(cur.s, target.s),
      tx: lerp(cur.tx, target.tx),
      ty: lerp(cur.ty, target.ty),
      geomW: target.geomW,
      geomH: target.geomH,
      canvasW: target.canvasW,
      canvasH: target.canvasH,
    };

    this._view = next;
    this._renderWithCurrentView();

    const done = (Math.abs(next.s - target.s) < 0.001) &&
      (Math.abs(next.tx - target.tx) < 0.25) &&
      (Math.abs(next.ty - target.ty) < 0.25);

    if(!done){
      this._raf = requestAnimationFrame((t) => this._stepAnimation(t));
    } else {
      this._view = target;
      this._raf = null;
      this._lastTs = null;
      this._renderWithCurrentView();
    }
  }

  _ensureAnimating(){
    if(this._raf) return;
    this._raf = requestAnimationFrame((t) => this._stepAnimation(t));
  }

  _renderWithCurrentView(){
    // Internal: same as render(), but assumes this._view already set.
    if(!this.world || !this.geom) return;

    const ctx = this.ctx;
    const canvasW = this.canvas.width;
    const canvasH = this.canvas.height;
    const { blob, cells, river } = this.geom;
    const pal = PALETTES[this.paletteIndex] || PALETTES[0];

    const visited = new Set(this.world.flags.visitedAreas);
    const currentId = this.world.entities.player.areaId;

    // Clear in canvas space.
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,canvasW,canvasH);

    const curArea = this.world.map?.areasById?.[String(currentId)];
    const biome = String(curArea?.biome || "").toLowerCase();
    const bg = BIOME_BG[biome] || BIOME_BG.default || [pal.ocean, pal.ocean];
    const g = ctx.createRadialGradient(canvasW*0.25, canvasH*0.20, 40, canvasW*0.55, canvasH*0.55, Math.max(canvasW,canvasH));
    g.addColorStop(0, bg[0]);
    g.addColorStop(1, bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0,0,canvasW,canvasH);

    // Draw the map in geom space using the view transform.
    const v = this._view;
    ctx.save();
    ctx.setTransform(v.s, 0, 0, v.s, v.tx, v.ty);
    drawPath(ctx, blob);
    ctx.clip();

    for(const c of cells){
      const area = this.world.map.areasById[String(c.id)];
      if(!area) continue;

      const isVisited = visited.has(c.id);
      const isClosed = (area.isActive === false);
      const isWarning = (area.willCloseOnDay === (this.world.meta.day + 1));

      ctx.save();
      if(isClosed) ctx.globalAlpha = 0.10;

      if(isClosed){
        ctx.fillStyle = rgbaFromHex(area.color, 1.00);
      } else if(!isVisited){
        ctx.fillStyle = "#2a2f3a";
      } else {
        ctx.fillStyle = rgbaFromHex(area.color, 1.00);
      }
      drawPath(ctx, c.poly);
      ctx.fill();
      ctx.restore();

      if (isWarning){
        ctx.strokeStyle = "rgba(220,60,60,0.95)";
        ctx.lineWidth = 3 / v.s;
        ctx.setLineDash([]);
        drawPath(ctx, c.poly);
        ctx.stroke();
      } else if (isClosed){
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.lineWidth = 2 / v.s;
        ctx.setLineDash([6,4]);
        drawPath(ctx, c.poly);
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(0,0,0,0.22)";
        ctx.lineWidth = 1 / v.s;
        ctx.setLineDash([]);
        drawPath(ctx, c.poly);
        ctx.stroke();
      }

      ctx.save();
      if(isClosed) ctx.globalAlpha = 0.22;
      if (c.id === 1) drawSafeLabel(ctx, c.poly, "🍞", true);
      else drawSafeLabel(ctx, c.poly, String(c.id), false);
      ctx.restore();
    }

    if (river?.points?.length){
      const riverColor = pal.biomes.lake?.[0] || "#2a6fb0";

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      ctx.strokeStyle = rgbaFromHex(riverColor, 0.20);
      ctx.lineWidth = 10 / v.s;
      ctx.beginPath();
      ctx.moveTo(river.points[0].x, river.points[0].y);
      for(let i=1;i<river.points.length;i++) ctx.lineTo(river.points[i].x, river.points[i].y);
      ctx.stroke();

      ctx.strokeStyle = rgbaFromHex(riverColor, 0.90);
      ctx.lineWidth = 6 / v.s;
      ctx.beginPath();
      ctx.moveTo(river.points[0].x, river.points[0].y);
      for(let i=1;i<river.points.length;i++) ctx.lineTo(river.points[i].x, river.points[i].y);
      ctx.stroke();

      ctx.restore();
    }

    if(this.hoveredId != null && this.isVisitable(this.hoveredId)){
      const cell = cells.find(x => x.id === this.hoveredId);
      if(cell){
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = 2 / v.s;
        ctx.setLineDash([]);
        drawPath(ctx, cell.poly);
        ctx.stroke();
      }
    }

    {
      const cell = cells.find(x => x.id === currentId);
      if(cell){
        ctx.save();
        ctx.strokeStyle = "#ffff00";
        ctx.lineWidth = 4 / v.s;
        ctx.setLineDash([10,7]);
        drawPath(ctx, cell.poly);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Outer blob outline (in geom space)
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2 / v.s;
    ctx.setLineDash([]);
    drawPath(ctx, blob);
    ctx.stroke();

    // Back to canvas space
    ctx.restore();

    // Viewport indicator (for minimap)
    if(this.options.showViewport && typeof this.options.getViewportRect === "function"){
      const r = this.options.getViewportRect();
      if(r && Number.isFinite(r.x0) && Number.isFinite(r.y0) && Number.isFinite(r.x1) && Number.isFinite(r.y1)){
        ctx.save();
        ctx.setTransform(v.s, 0, 0, v.s, v.tx, v.ty);
        ctx.strokeStyle = "rgba(250,208,44,0.85)";
        ctx.lineWidth = 2 / v.s;
        ctx.setLineDash([6,4]);
        ctx.strokeRect(r.x0, r.y0, (r.x1 - r.x0), (r.y1 - r.y0));
        ctx.restore();
      }
    }

    // vignette
    const CX = canvasW/2, CY = canvasH/2;
    const baseR = Math.min(canvasW, canvasH) * 0.55;
    const vg = ctx.createRadialGradient(CX, CY, baseR*0.55, CX, CY, baseR*1.55);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = vg;
    ctx.fillRect(0,0,canvasW,canvasH);

    // Tooltip (in canvas space)
    this._drawTooltip(ctx);
  }

  _getTooltipLines(areaId){
    const area = this.world?.map?.areasById?.[String(areaId)] || null;
    if(!area) return null;

    const day = Number(this.world?.meta?.day ?? 1);
    const visited = new Set(this.world?.flags?.visitedAreas || []).has(areaId);

    const title = `Area ${areaId}`;
    if(!visited){
      return [
        title,
        "Unknown territory.",
        "Information is unclear until you enter.",
        "Biome: Unknown",
        "Noise: Unknown"
      ];
    }

    const biomeKey = area.biome;
    const biomeName = BIOME_PT[biomeKey] || biomeKey || "Unknown";

    const noise = String(area.noiseState || "quiet");
    let noiseLine = "The air is still.";
    let noiseTag = "Quiet";
    if(noise === "noisy"){
      noiseTag = "Noisy";
      noiseLine = "You catch faint movement and distant voices.";
    } else if(noise === "highly_noisy"){
      noiseTag = "Highly Noisy";
      noiseLine = "The arena is loud here. Something is hunting.";
    }

    const lines = [title, `Biome: ${biomeName}`, `Noise: ${noiseTag}`, noiseLine];

    if(area.hasWater) lines.push("Water: You spot usable water.");
    else lines.push("Water: No clear source.");

    const isClosed = (area.isActive === false);
    const isWarning = (area.willCloseOnDay === (day + 1));
    if(isClosed) lines.push("Status: Sealed off.");
    else if(isWarning) lines.push("Status: The barrier shifts tomorrow.");

    // Optional short flavor cues if present.
    const flavor = (typeof area.flavor === "string" && area.flavor.trim()) ? area.flavor.trim() : null;
    if(flavor) lines.push(flavor);

    return lines;
  }

  _drawTooltip(ctx){
    if(!this._mouse?.has) return;
    if(this.hoveredId == null) return;

    const lines = this._getTooltipLines(this.hoveredId);
    if(!lines || !lines.length) return;

    const pad = 10;
    const lineH = 16;
    const maxW = 340;

    ctx.save();
    ctx.setTransform(1,0,0,1,0,0);
    ctx.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

    // Measure width
    let w = 0;
    for(const s of lines){
      w = Math.max(w, ctx.measureText(String(s)).width);
    }
    w = Math.min(maxW, Math.ceil(w));
    const h = pad*2 + lineH * lines.length;

    // Anchor near cursor, clamp within canvas
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    let x = (Number(this._mouse.cx) || 0) + 14;
    let y = (Number(this._mouse.cy) || 0) + 14;
    if(x + w + pad*2 > cw) x = cw - (w + pad*2) - 8;
    if(y + h > ch) y = ch - h - 8;
    x = Math.max(8, x);
    y = Math.max(8, y);

    // Background
    ctx.fillStyle = "rgba(10,12,16,0.88)";
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    const r = 10;
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w+pad*2, y, x+w+pad*2, y+h, r);
    ctx.arcTo(x+w+pad*2, y+h, x, y+h, r);
    ctx.arcTo(x, y+h, x, y, r);
    ctx.arcTo(x, y, x+w+pad*2, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Text
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    // First line as title (slightly brighter)
    let ty = y + pad;
    ctx.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillText(String(lines[0]), x + pad, ty);
    ty += lineH;

    ctx.font = "500 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    for(let i=1;i<lines.length;i++){
      ctx.fillText(String(lines[i]), x + pad, ty);
      ty += lineH;
    }

    ctx.restore();
  }

  render(){
    if(!this.world || !this.geom) return;

    // Compute the target view transform.
    this._viewTarget = this.computeView();

    if(!!this.options.smooth){
      // If we don't have a current view yet, snap once then animate after.
      if(!this._view || !Number.isFinite(this._view.s)) this._view = this._viewTarget;
      this._ensureAnimating();
      return;
    }

    // No smoothing: snap to target and draw.
    this._view = this._viewTarget;
    this._renderWithCurrentView();
  }

  getAreaInfo(id){
    const area = this.world.map.areasById[String(id)];
    if(!area) return null;

    const cur = this.world.entities.player.areaId;
    const visited = new Set(this.world.flags.visitedAreas).has(id);
    const visitable = this.isVisitable(id);

    return {
      id,
      biome: BIOME_PT[area.biome] || area.biome,
      color: area.color,
      hasWater: !!area.hasWater,
      visited,
      visitable,
      current: (id === cur)
    };
  }
}
