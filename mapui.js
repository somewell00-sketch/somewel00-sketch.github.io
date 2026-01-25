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

    canvas.addEventListener("mousemove", (e) => this.handleMove(e));
    canvas.addEventListener("mouseleave", () => { this.hoveredId = null; this.render(); });
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
    const {x,y} = this.canvasToWorld(e);
    const id = this.hitTest(x,y);
    const enabled = !!this.canMove();
    const nextHover = (enabled && id != null && this.isVisitable(id)) ? id : null;
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
