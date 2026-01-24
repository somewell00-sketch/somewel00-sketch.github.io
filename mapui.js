import { BIOME_PT, PALETTES } from "./mapgen.js";

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
  constructor({ canvas, onAreaClick, getCurrentAreaId, canMove }){
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onAreaClick = onAreaClick;
    this.getCurrentAreaId = getCurrentAreaId || (() => (this.world?.entities?.player?.areaId ?? 1));
    this.canMove = canMove || (() => true);

    this.hoveredId = null;

    canvas.addEventListener("mousemove", (e) => this.handleMove(e));
    canvas.addEventListener("mouseleave", () => { this.hoveredId = null; this.render(); });
    canvas.addEventListener("click", (e) => this.handleClick(e));
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

  canvasToLocal(evt){
    const rect = this.canvas.getBoundingClientRect();
    const x = (evt.clientX - rect.left) * (this.canvas.width / rect.width);
    const y = (evt.clientY - rect.top) * (this.canvas.height / rect.height);
    return { x, y };
  }

  hitTest(x,y){
    // brute-force ok
    const cells = this.geom.cells;
    for(let i=cells.length-1; i>=0; i--){
      const c = cells[i];
      if(pointInPoly(x,y,c.poly)) return c.id;
    }
    return null;
  }

  handleMove(e){
    const {x,y} = this.canvasToLocal(e);
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
    const {x,y} = this.canvasToLocal(e);
    const id = this.hitTest(x,y);
    if(id == null) return;
    this.onAreaClick(id);
  }

  render(){
    if(!this.world || !this.geom) return;

    const ctx = this.ctx;
    const { width:W, height:H, blob, cells, river } = this.geom;
    const pal = PALETTES[this.paletteIndex] || PALETTES[0];

    const visited = new Set(this.world.flags.visitedAreas);
    const currentId = this.world.entities.player.areaId;

    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = pal.ocean;
    ctx.fillRect(0,0,W,H);

    // clip continente
    ctx.save();
    drawPath(ctx, blob);
    ctx.clip();

    // draw cells
    for(const c of cells){
      const area = this.world.map.areasById[String(c.id)];
      if(!area) continue;

      const isVisited = visited.has(c.id);
      const isClosed = (area.isActive === false);
      const isWarning = (area.willCloseOnDay === (this.world.meta.day + 1));

      // Fill
      // - Unvisited areas: dark.
      // - Visited areas: biome color.
      // - Closed areas ("disappeared"): always render at 10% opacity, even if unvisited.
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

      // Border
      if (isWarning){
        ctx.strokeStyle = "rgba(220,60,60,0.95)";
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        drawPath(ctx, c.poly);
        ctx.stroke();
      } else if (isClosed){
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.lineWidth = 2;
        ctx.setLineDash([6,4]);
        drawPath(ctx, c.poly);
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(0,0,0,0.22)";
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        drawPath(ctx, c.poly);
        ctx.stroke();
      }

      // Labels: keep them, but fade them heavily on closed areas.
      ctx.save();
      if(isClosed) ctx.globalAlpha = 0.22;
      if (c.id === 1) drawSafeLabel(ctx, c.poly, "🍞", true);
      else drawSafeLabel(ctx, c.poly, String(c.id), false);
      ctx.restore();
    }

    // river overlay
    if (river?.points?.length){
      const riverColor = pal.biomes.lake?.[0] || "#2a6fb0";

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      ctx.strokeStyle = rgbaFromHex(riverColor, 0.20);
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(river.points[0].x, river.points[0].y);
      for(let i=1;i<river.points.length;i++) ctx.lineTo(river.points[i].x, river.points[i].y);
      ctx.stroke();

      ctx.strokeStyle = rgbaFromHex(riverColor, 0.90);
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(river.points[0].x, river.points[0].y);
      for(let i=1;i<river.points.length;i++) ctx.lineTo(river.points[i].x, river.points[i].y);
      ctx.stroke();

      ctx.restore();
    }

    // hover only if visitable
    if(this.hoveredId != null && this.isVisitable(this.hoveredId)){
      const cell = cells.find(x => x.id === this.hoveredId);
      if(cell){
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        drawPath(ctx, cell.poly);
        ctx.stroke();
      }
    }

    // current border
    {
      const cell = cells.find(x => x.id === currentId);
      if(cell){
        ctx.save();
        ctx.strokeStyle = "#ffff00";
        ctx.lineWidth = 4;
        ctx.setLineDash([10,7]);
        drawPath(ctx, cell.poly);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.restore();

    // outline blob
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    drawPath(ctx, blob);
    ctx.stroke();

    // vignette
    const CX = W/2, CY = H/2;
    const g = ctx.createRadialGradient(CX,CY,290*0.65, CX,CY, 290*1.55);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = g;
    ctx.fillRect(0,0,W,H);
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
