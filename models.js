/* ============================================================
 *  LABOTOMY — models.js
 *  All world data, textures, spawning, physics & draw routines.
 *  index.html only handles player input, camera, HUD & main loop.
 * ============================================================ */
window.MODELS = (function () {
'use strict';

// ============================================================
//  CONFIG
// ============================================================
const CELL = 14;                 // world px per terrain column
const PIX = 7;                   // pixel-art cell size
const WORLD_COLS = 900;
const WORLD_W = WORLD_COLS * CELL;
const SLAB_H = 220;              // visible terrain slab thickness
const DEATH_Y = 640;             // fell-off-world threshold

const TT = {
  DIRT: 0, ICE: 1, BOUNCE: 2, STICKY: 3,
  CRUMBLE: 4, SPIKE: 5, CONVEYOR: 6
};

const MAX_BULLETS  = 40;
const MAX_DEBRIS   = 240;
const MAX_RAGDOLLS = 12;
const MAX_ENEMIES  = 8;

// ============================================================
//  INJECTED FROM index.html
// ============================================================
let rnd, rndi, clamp, pick;
let fx, addPopup, killMsg;
let player, state, view;
let shake, flash, onPlayerCaught;
let solveCon, circleVsAABB, boxVsAABB;

// ============================================================
//  TEXTURES (offscreen canvases, built once)
// ============================================================
const TEX = {};

function makeTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  return c;
}

function buildTextures() {
  // little side-view pistol sprite
  TEX.gun = makeTex(30, 16, (g) => {
    // barrel
    g.fillStyle = '#5c5c6c';
    g.fillRect(2, 5, 22, 6);
    // body
    g.fillStyle = '#3a3a48';
    g.fillRect(0, 4, 24, 8);
    // grip
    g.fillStyle = '#2b2b36';
    g.fillRect(2, 11, 8, 5);
    // muzzle
    g.fillStyle = '#1f1f28';
    g.fillRect(23, 6, 3, 4);
    // top rail
    g.fillStyle = '#7a7a8c';
    g.fillRect(6, 3, 14, 2);
    // trigger guard
    g.strokeStyle = '#1f1f28';
    g.lineWidth = 1;
    g.strokeRect(9, 9, 6, 5);
    // tiny yellow glow sight
    g.fillStyle = '#ffcc44';
    g.fillRect(20, 4, 3, 2);
  });

  // ammo box sprite
  TEX.ammo = makeTex(14, 12, (g) => {
    g.fillStyle = '#ffd24a';
    g.fillRect(1, 3, 12, 8);
    g.fillStyle = '#e5a71a';
    g.fillRect(1, 3, 12, 2);
    g.fillStyle = '#8a5a10';
    g.fillRect(2, 5, 10, 1);
    g.fillRect(2, 9, 10, 1);
  });

  // bullet sprite (drawn as rect, no need for canvas — but keep for fx)
  TEX.bullet = makeTex(6, 6, (g) => {
    g.fillStyle = '#fff2b8';
    g.fillRect(1, 1, 4, 4);
    g.fillStyle = '#ffcc44';
    g.fillRect(2, 2, 2, 2);
  });
}

// ============================================================
//  TERRAIN DATA
// ============================================================
const terrain = {
  gy: new Float32Array(WORLD_COLS),      // ground top-Y (smaller = higher)
  s: new Uint8Array(WORLD_COLS),         // solid flag
  t: new Uint8Array(WORLD_COLS),         // material type
  crumble: new Float32Array(WORLD_COLS), // crumble timer
  cd: new Float32Array(WORLD_COLS)       // conveyor direction (-1, 0, 1)
};

const lavas = [];

function terrainTypeAt(x) {
  const c = Math.floor(x / CELL);
  if (c < 0 || c >= WORLD_COLS) return TT.DIRT;
  return terrain.t[c];
}

function conveyorDirAt(x) {
  const c = Math.floor(x / CELL);
  if (c < 0 || c >= WORLD_COLS) return 0;
  return terrain.cd[c];
}

function terrainYAt(x) {
  const c = Math.floor(x / CELL);
  if (c < 0 || c >= WORLD_COLS) return Infinity;
  if (!terrain.s[c]) return Infinity;
  return terrain.gy[c];
}

function footprintGround(x, hw) {
  const c0 = Math.floor((x - hw) / CELL);
  const c1 = Math.floor((x + hw) / CELL);
  let best = Infinity;
  for (let c = c0; c <= c1; c++) {
    if (c < 0 || c >= WORLD_COLS) continue;
    if (terrain.s[c] && terrain.gy[c] < best) best = terrain.gy[c];
  }
  return best;
}

function addCrumble(col, dt) {
  if (col >= 0 && col < WORLD_COLS) terrain.crumble[col] += dt;
}

// ============================================================
//  WORLD GENERATION
// ============================================================
function generateWorld() {
  let h = 0, diff = 0, c = 0;
  const endFlat = WORLD_COLS - 40;

  lavas.length = 0;
  for (let i = 0; i < WORLD_COLS; i++) {
    terrain.crumble[i] = 0;
    terrain.cd[i] = 0;
  }

  // flat safe start
  for (; c < 55; c++) {
    terrain.gy[c] = 0; terrain.s[c] = 1; terrain.t[c] = TT.DIRT;
  }

  const randType = () => {
    const r = Math.random();
    if (r < 0.62) return TT.DIRT;
    if (r < 0.72) return TT.ICE;
    if (r < 0.80) return TT.BOUNCE;
    if (r < 0.86) return TT.STICKY;
    if (r < 0.91) return TT.CRUMBLE;
    if (r < 0.95) return TT.SPIKE;
    return TT.CONVEYOR;
  };

  while (c < endFlat) {
    const r = Math.random();
    const d = diff;

    if (r < 0.20) {
      // flat stretch
      const n = rndi(5, 12);
      const t = randType();
      const cd = t === TT.CONVEYOR ? (Math.random() < 0.5 ? -1 : 1) : 0;
      for (let i = 0; i < n && c < endFlat; i++) {
        terrain.gy[c] = h; terrain.s[c] = 1;
        terrain.t[c] = t; terrain.cd[c] = cd; c++;
      }
    } else if (r < 0.44) {
      // slope
      const n = rndi(4, 9);
      const dir = h > 70 ? -1 : h < -70 ? 1 : (Math.random() < 0.5 ? -1 : 1);
      const step = dir * rnd(4, 9);
      const t = Math.random() < 0.25 ? TT.ICE : TT.DIRT;
      for (let i = 0; i < n && c < endFlat; i++) {
        h = clamp(h + step, -140, 140);
        terrain.gy[c] = h; terrain.s[c] = 1; terrain.t[c] = t; c++;
      }
    } else if (r < 0.73) {
      // gap (and possible lava)
      const n = rndi(2, 2 + Math.round(d * 4));
      for (let i = 0; i < n && c < endFlat; i++) {
        terrain.gy[c] = h; terrain.s[c] = 0; c++;
      }
      if (n >= 3 && Math.random() < 0.30 + d * 0.20) {
        const lx = (c - n) * CELL;
        lavas.push({ x: lx, w: n * CELL, y: h + 240, anim: rnd(0, 6.28) });
      }
    } else if (r < 0.89) {
      // pillar / mesa
      const upN = rndi(2, 4);
      let hh = h;
      for (let i = 0; i < upN && c < endFlat; i++) {
        hh = clamp(hh - rnd(12, 22), -140, 140);
        terrain.gy[c] = hh; terrain.s[c] = 1; terrain.t[c] = TT.DIRT; c++;
      }
      const topN = rndi(3, 8);
      const topType = Math.random() < 0.22 ? TT.SPIKE
                    : (Math.random() < 0.25 ? TT.BOUNCE : TT.DIRT);
      for (let i = 0; i < topN && c < endFlat; i++) {
        terrain.gy[c] = hh; terrain.s[c] = 1; terrain.t[c] = topType; c++;
      }
      for (let i = 0; i < upN && c < endFlat; i++) {
        hh = clamp(hh + rnd(12, 22), -140, 140);
        terrain.gy[c] = hh; terrain.s[c] = 1; terrain.t[c] = TT.DIRT; c++;
      }
      h = hh;
    } else {
      // wide chasm
      const n = rndi(3, 6);
      for (let i = 0; i < n && c < endFlat; i++) {
        terrain.gy[c] = h; terrain.s[c] = 0; c++;
      }
      if (n >= 3 && Math.random() < 0.4) {
        const lx = (c - n) * CELL;
        lavas.push({ x: lx, w: n * CELL, y: h + 240, anim: rnd(0, 6.28) });
      }
    }
    diff = Math.min(1, diff + 0.005);
  }
  for (; c < WORLD_COLS; c++) {
    terrain.gy[c] = 0; terrain.s[c] = 1; terrain.t[c] = TT.DIRT;
  }
}

// ============================================================
//  ISLANDS / BOXES / SPRINGS / PLANKS / PICKUPS
// ============================================================
const islands = [];
const boxes   = [];
const springs = [];
const planks  = [];
const pickups = [];

// ---------- boxes (soft-body wooden crates) ----------
function makeBox(cx, cy, size) {
  const hh = size / 2;
  const pts = [
    { x: cx - hh, y: cy - hh, px: cx - hh, py: cy - hh, r: 3 },
    { x: cx + hh, y: cy - hh, px: cx + hh, py: cy - hh, r: 3 },
    { x: cx + hh, y: cy + hh, px: cx + hh, py: cy + hh, r: 3 },
    { x: cx - hh, y: cy + hh, px: cx - hh, py: cy + hh, r: 3 }
  ];
  const cons = [];
  const link = (i, j) => cons.push({
    a: pts[i], b: pts[j],
    d: Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
  });
  link(0, 1); link(1, 2); link(2, 3); link(3, 0); link(0, 2); link(1, 3);
  return {
    pts, cons, size,
    aabb: { x: 0, y: 0, w: 0, h: 0 },
    vy: 0, dead: false,
    push(dx, dy) {
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        p.x += dx; p.px += dx * 0.55;
        p.y += dy; p.py += dy * 0.55;
      }
    }
  };
}

// ---------- planks (rope bridges) ----------
function makePlank(x1, y1, x2, y2) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const N = Math.max(4, Math.round(len / 11) + 1);
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    pts.push({ x, y, px: x, py: y, r: 3, pin: (i === 0 || i === N - 1) });
  }
  const cons = [];
  for (let i = 0; i < N - 1; i++) {
    cons.push({
      a: pts[i], b: pts[i + 1],
      d: Math.hypot(pts[i].x - pts[i + 1].x, pts[i].y - pts[i + 1].y)
    });
  }
  // a couple of diagonal stiffeners for a planky feel
  for (let i = 0; i < N - 2; i++) {
    cons.push({
      a: pts[i], b: pts[i + 2],
      d: Math.hypot(pts[i].x - pts[i + 2].x, pts[i].y - pts[i + 2].y),
      k: 0.4
    });
  }
  return { pts, cons, broken: false, health: 2 };
}

function breakPlank(plank, breakIdx) {
  if (plank.broken) return;
  plank.broken = true;
  for (let i = 0; i < plank.pts.length; i++) plank.pts[i].pin = false;

  const idx = clamp(breakIdx, 1, plank.cons.length - 1);
  const brk = plank.cons[idx];
  if (!brk) return;
  const cx = (brk.a.x + brk.b.x) * 0.5;
  const cy = (brk.a.y + brk.b.y) * 0.5;

  // kick every point outward from the break
  for (let i = 0; i < plank.pts.length; i++) {
    const p = plank.pts[i];
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const kick = 3.5;
    p.px = p.x - (dx / d) * kick;
    p.py = p.y - (dy / d) * kick - 0.8;
  }
  plank.cons.splice(idx, 1);

  // splinters
  for (let i = 0; i < 10; i++) {
    spawnDebris(
      cx + rnd(-8, 8), cy + rnd(-8, 8),
      rnd(-180, 180), rnd(-260, -60),
      rnd(2, 4),
      pick(['#9a6a32', '#7a4a24', '#c89a5a'])
    );
  }
  fx.burst(cx, cy, 12, {
    colors: [[0.75, 0.5, 0.28], [0.55, 0.35, 0.18], [0.95, 0.75, 0.45]],
    spMax: 260, grav: 900, sizeMax: 7
  });
  shake(0.22);
}

// ---------- pickups ----------
function spawnPickup(x, y, type, amount) {
  pickups.push({
    x, y, vy: 0, type, amount: amount || 0,
    taken: false, anim: rnd(0, 6.28), life: 30
  });
}

// ---------- place everything ----------
function placeStuff() {
  islands.length = 0;
  boxes.length = 0;
  springs.length = 0;
  planks.length = 0;
  pickups.length = 0;
  lavas.length = 0;

  let c = 70;
  while (c < WORLD_COLS - 70) {
    const r = Math.random();
    if (r < 0.30) {
      const wCols = rndi(3, 6);
      const w = wCols * CELL;
      const baseH = terrain.s[c] ? terrain.gy[c] : 0;
      const y = baseH - rnd(130, 220);
      islands.push({ x: c * CELL, y: y, w: w, h: 16, anim: rnd(0, 6.28) });
      if (Math.random() < 0.4) boxes.push(makeBox(c * CELL + w / 2, y - 22, 26));
      c += wCols + rndi(8, 18);
    } else if (r < 0.58) {
      if (terrain.s[c]) {
        const n = rndi(1, 3);
        for (let i = 0; i < n; i++) {
          boxes.push(makeBox(c * CELL + 7 + i * 30, terrain.gy[c] - 22, 26));
        }
      }
      c += rndi(10, 22);
    } else if (r < 0.74) {
      if (terrain.s[c]) {
        springs.push({
          x: c * CELL - 7, y: terrain.gy[c] - 13,
          w: CELL * 2, h: 13, anim: 0
        });
      }
      c += rndi(14, 30);
    } else if (r < 0.84) {
      // extra lava pit
      if (terrain.s[c] && c + 4 < WORLD_COLS) {
        const n = rndi(3, 5);
        for (let i = 0; i < n; i++) terrain.s[c + i] = 0;
        lavas.push({ x: c * CELL, w: n * CELL, y: terrain.gy[c] + 240, anim: rnd(0, 6.28) });
        c += n + 6;
      } else c += 8;
    } else {
      c += rndi(6, 16);
    }
  }

  // ---- connect nearby islands with plank bridges ----
  islands.sort((a, b) => a.x - b.x);
  for (let i = 0; i < islands.length - 1; i++) {
    const A = islands[i];
    const B = islands[i + 1];
    const gap = B.x - (A.x + A.w);
    const dy = Math.abs(A.y - B.y);
    if (gap > 0 && gap < 240 && dy < 110 && Math.random() < 0.78) {
      const x1 = A.x + A.w;
      const y1 = A.y + 5;
      const x2 = B.x;
      const y2 = B.y + 5;
      planks.push(makePlank(x1, y1, x2, y2));
    }
  }

  // ---- a few free-floating planks across gaps ----
  for (let i = 0; i < islands.length - 2; i++) {
    if (Math.random() < 0.20) {
      const A = islands[i];
      const B = islands[i + 2];
      const gap = B.x - (A.x + A.w);
      if (gap > 40 && gap < 420) {
        planks.push(makePlank(A.x + A.w, A.y + 5, B.x, B.y + 5));
      }
    }
  }

  // ---- gun & ammo pickups ----
  // one gun guaranteed not too far in
  const midIsl = islands[Math.floor(islands.length * 0.35)];
  if (midIsl) {
    spawnPickup(midIsl.x + midIsl.w / 2, midIsl.y - 32, 'gun', rndi(10, 16));
  }
  // extras
  for (let i = 0; i < islands.length; i += 3) {
    const isl = islands[i];
    if (Math.random() < 0.55) {
      if (Math.random() < 0.5) {
        spawnPickup(isl.x + isl.w / 2, isl.y - 32, 'gun', rndi(8, 18));
      } else {
        spawnPickup(isl.x + isl.w / 2, isl.y - 32, 'ammo', rndi(6, 12));
      }
    }
  }
  // ground pickups
  for (let cc = 80; cc < WORLD_COLS - 80; cc += rndi(60, 120)) {
    if (terrain.s[cc] && Math.random() < 0.30) {
      const type = Math.random() < 0.35 ? 'gun' : 'ammo';
      const amt = type === 'gun' ? rndi(10, 24) : rndi(4, 10);
      spawnPickup(cc * CELL + 7, terrain.gy[cc] - 20, type, amt);
    }
  }
}

// ============================================================
//  BULLETS
// ============================================================
const bullets = [];

function spawnBullet(x, y, dx, dy, addVx) {
  if (bullets.length >= MAX_BULLETS) bullets.shift();
  bullets.push({
    x, y, px: x, py: y,
    vx: dx * 620 + addVx * 0.35,
    vy: dy * 620 - 30,
    r: 3,
    life: 3.2
  });
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    if (b.life <= 0) { bullets.splice(i, 1); continue; }

    const vx = b.x - b.px;
    const vy = b.y - b.py;
    b.px = b.x; b.py = b.y;
    b.vx *= 0.995;
    b.vy = b.vy * 0.995 + 1400 * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // trail sparkle
    if (Math.random() < 0.6) {
      fx.burst(b.x, b.y, 1, {
        colors: [[1, 0.9, 0.45], [1, 0.7, 0.2]],
        spMax: 30, grav: 0, sizeMax: 3,
        lifeMax: 0.22, glow: true, drag: 0.7
      });
    }

    // world bounds
    if (b.x < 0 || b.x > WORLD_W || b.y > DEATH_Y + 60) {
      bullets.splice(i, 1); continue;
    }

    // terrain
    const col = Math.floor(b.x / CELL);
    if (col >= 0 && col < WORLD_COLS && terrain.s[col] && b.y > terrain.gy[col]) {
      damageTerrain(b.x, b.y, 13);
      bullets.splice(i, 1);
      continue;
    }

    // planks
    let hit = false;
    for (let p = 0; p < planks.length && !hit; p++) {
      const plank = planks[p];
      if (plank.broken) continue;
      const pts = plank.pts;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], c2 = pts[k + 1];
        const dx2 = c2.x - a.x, dy2 = c2.y - a.y;
        const len2 = dx2 * dx2 + dy2 * dy2;
        const t = clamp(((b.x - a.x) * dx2 + (b.y - a.y) * dy2) / (len2 || 1), 0, 1);
        const cx = a.x + dx2 * t, cy = a.y + dy2 * t;
        if (Math.hypot(b.x - cx, b.y - cy) < 6) {
          breakPlank(plank, k);
          hit = true;
          break;
        }
      }
    }
    if (hit) { bullets.splice(i, 1); continue; }

    // enemies
    for (let e = 0; e < enemies.length; e++) {
      const en = enemies[e];
      if (!en.alive) continue;
      if (Math.abs(b.x - en.x) < en.hw + 3 && Math.abs(b.y - en.y) < en.hh + 3) {
        en.hp = (en.hp || 2) - 1;
        fxBurst(b.x, b.y, 8, {
          colors: [[1, 0.35, 0.45], [1, 0.6, 0.6]],
          spMax: 260, grav: 700, sizeMax: 8
        });
        if (en.hp <= 0) killEnemy(en, 'shot');
        bullets.splice(i, 1);
        hit = true;
        break;
      }
    }
    if (hit) continue;

    // boxes
    for (let k = 0; k < boxes.length; k++) {
      const box = boxes[k];
      if (box.dead) continue;
      const a = box.aabb;
      if (b.x > a.x && b.x < a.x + a.w && b.y > a.y && b.y < a.y + a.h) {
        // punch a piece off
        box.push(b.vx * 0.02, b.vy * 0.02);
        for (let d = 0; d < 6; d++) {
          spawnDebris(b.x + rnd(-4, 4), b.y + rnd(-4, 4),
            rnd(-120, 120) + b.vx * 0.15,
            rnd(-120, 40) + b.vy * 0.1,
            rnd(2, 4), '#a86a2a');
        }
        bullets.splice(i, 1);
        hit = true;
        break;
      }
    }
  }
}

// ============================================================
//  TERRAIN DESTRUCTION
// ============================================================
function pickTerrainColor(type) {
  switch (type) {
    case TT.ICE:      return pick(['#7ae4ff', '#3a9fc8', '#1d5a80']);
    case TT.BOUNCE:   return pick(['#5aef7a', '#2fa048', '#1a6b2c']);
    case TT.STICKY:   return pick(['#a94be0', '#6c2b9c', '#3d1658']);
    case TT.CRUMBLE:  return pick(['#b08050', '#8f6440', '#6f4d30']);
    case TT.SPIKE:    return pick(['#7a1a2a', '#4a0e18', '#2a0810']);
    case TT.CONVEYOR: return pick(['#e09630', '#8a5810', '#3e2a08']);
    default:          return pick(['#5252c8', '#3d3d9a', '#2b2b66']);
  }
}

function damageTerrain(x, y, radius) {
  const c0 = Math.max(0, Math.floor((x - radius) / CELL));
  const c1 = Math.min(WORLD_COLS - 1, Math.floor((x + radius) / CELL));
  let removed = 0;
  let craters = 0;

  for (let c = c0; c <= c1; c++) {
    if (!terrain.s[c]) continue;
    const cx = c * CELL + CELL / 2;
    const dx = Math.abs(cx - x);
    if (dx > radius) continue;

    const drop = Math.sqrt(radius * radius - dx * dx) * 0.85;
    const depth = y - terrain.gy[c];
    if (depth < -8) continue;                    // bullet above surface
    const carve = Math.min(drop, Math.max(2, depth + drop * 0.6));
    if (carve <= 0.5) continue;

    // spawn falling debris from removed material
    const nDeb = Math.max(1, Math.floor(carve / 2));
    for (let i = 0; i < nDeb; i++) {
      spawnDebris(
        cx + rnd(-4, 4),
        terrain.gy[c] + rnd(-2, 4),
        rnd(-160, 160),
        rnd(-280, -60),
        rnd(2, 4),
        pickTerrainColor(terrain.t[c])
      );
    }

    // heat color slightly — ice and dirt look different
    terrain.gy[c] += carve;

    // deep holes near lava may open lava seams
    removed++;
    if (terrain.gy[c] > 300) craters++;
  }

  if (removed > 0) {
    shake(0.16);
    flash(0.05);
    fx.burst(x, y, 10, {
      colors: [[0.65, 0.55, 0.4], [0.4, 0.35, 0.3], [0.85, 0.75, 0.5]],
      spMax: 300, grav: 1200, sizeMax: 8
    });
  }
}

// ============================================================
//  DEBRIS
// ============================================================
const debris = [];

function spawnDebris(x, y, vx, vy, size, color) {
  if (debris.length >= MAX_DEBRIS) debris.shift();
  debris.push({
    x, y,
    px: x - vx / 60, py: y - vy / 60,
    r: size, color,
    life: 3.5 + Math.random() * 2
  });
}

function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.life -= dt;
    if (d.life <= 0) { debris.splice(i, 1); continue; }

    const vx = (d.x - d.px) * 0.998;
    const vy = (d.y - d.py) * 0.998;
    d.px = d.x; d.py = d.y;
    d.x += vx;
    d.y += vy + 2600 * dt * dt;

    // terrain
    const g = terrainYAt(d.x);
    if (g !== Infinity && d.y + d.r > g) {
      d.y = g - d.r;
      const curVy = d.y - d.py;
      d.py = d.y + curVy * 0.32;      // bounce
      d.px = d.x - vx * 0.55;         // friction
    }

    if (d.y > DEATH_Y + 200) debris.splice(i, 1);
  }
}

// ============================================================
//  ENEMIES
// ============================================================
const enemies = [];
const ragdolls = [];

function spawnEnemy() {
  if (enemies.length >= MAX_ENEMIES) return;
  const side = Math.random() < 0.72 ? 1 : -1;
  const sx = player.x + side * (view.W * 0.55 + rnd(60, 200));
  let sy = player.y - rnd(80, 260);
  const c = Math.floor(sx / CELL);
  if (c >= 0 && c < WORLD_COLS && terrain.s[c]) sy = terrain.gy[c] - 40;
  enemies.push({
    x: sx, y: sy, vx: 0, vy: 0,
    hw: 11, hh: 11,
    onGround: false, alive: true,
    dir: -side,
    speed: rnd(165, 235),
    smart: Math.random() < 0.7,
    jumpCd: 0, crushTimer: 0,
    phase: rnd(0, 6.28),
    wobble: rnd(0, 6.28),
    hp: 2
  });
}

function killEnemy(e, cause) {
  if (!e.alive) return;
  e.alive = false;
  const sx = e.x - (player ? player.x : 0) - view.W * 0.5;
  // only spawn visible ragdoll
  if (Math.abs(e.x - player.x) < view.W) {
    makeRagdoll(e.x, e.y, 22, e.vx, e.vy, false);
    fxBurst(e.x, e.y, 14, {
      colors: [[1, 0.35, 0.45], [1, 0.6, 0.6], [1, 0.9, 0.4]],
      spMin: 100, spMax: 360, grav: 700, sizeMax: 11
    });
    fxPixel(e.x, e.y, 8, {
      colors: [[0.6, 0.1, 0.2], [0.9, 0.3, 0.4]],
      spMax: 280, grav: 1200, sizeMax: 6
    });
    addPopup(e.x, e.y - 22, killMsg(cause), '#ff6b7d');
    shake(0.18);
  }
  state.kills++;
}

function updateEnemies(dt) {
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.alive) continue;

    e.vy += 2600 * dt;
    if (e.vy > 1800) e.vy = 1800;
    e.jumpCd -= dt;
    e.wobble += dt * 6;

    // chase
    const dx = player.x - e.x;
    if (Math.abs(dx) > 30) e.dir = Math.sign(dx) || e.dir;

    // material effects
    const cUnder = Math.floor(e.x / CELL);
    const tUnder = (cUnder >= 0 && cUnder < WORLD_COLS) ? terrain.t[cUnder] : TT.DIRT;
    let speedMul = 1;
    if (e.onGround && tUnder === TT.ICE) speedMul = 0.9;
    if (e.onGround && tUnder === TT.STICKY) speedMul = 0.6;
    e.vx = e.dir * e.speed * speedMul;
    if (e.onGround && tUnder === TT.CONVEYOR) {
      e.vx += conveyorDirAt(e.x) * 180;
    }

    // jump AI
    if (e.onGround && e.jumpCd <= 0) {
      const aheadX = e.x + e.dir * (e.hw + 16);
      const gAhead = terrainYAt(aheadX);
      if (gAhead === Infinity) {
        if (e.smart && Math.random() < 0.45) {
          e.vy = -820 * 0.94;
          e.jumpCd = 0.5;
        }
      } else if (gAhead < e.y - 14) {
        e.vy = -820 * 0.96;
        e.jumpCd = 0.4;
      }
    }

    e.x += e.vx * dt;
    e.y += e.vy * dt;

    // terrain
    const g = footprintGround(e.x, e.hw);
    if (g !== Infinity && e.y + e.hh > g) {
      e.y = g - e.hh;
      e.vy = 0;
      e.onGround = true;

      if (tUnder === TT.BOUNCE && e.jumpCd < -0.15) {
        e.vy = -900;
        e.onGround = false;
        e.jumpCd = 0.3;
      } else if (tUnder === TT.SPIKE) {
        killEnemy(e, 'spike');
        continue;
      } else if (tUnder === TT.CRUMBLE) {
        const cc = Math.floor(e.x / CELL);
        if (cc >= 0 && cc < WORLD_COLS) terrain.crumble[cc] += dt * 0.8;
      }
    } else {
      e.onGround = false;
    }

    // islands
    for (let k = 0; k < islands.length; k++) {
      const isl = islands[k];
      const n = circleVsAABB(e.x, e.y, e.hh, isl.x, isl.y, isl.w, isl.h);
      if (n) {
        e.x += n.nx * n.depth;
        e.y += n.ny * n.depth;
        if (n.ny < -0.5) { e.vy = 0; e.onGround = true; }
        else if (n.ny > 0.5) e.vy = Math.max(e.vy, 0);
      }
    }

    // planks
    for (let k = 0; k < planks.length; k++) {
      const plank = planks[k];
      if (plank.broken) continue;
      const pts = plank.pts;
      for (let j = 0; j < pts.length - 1; j++) {
        const a = pts[j], c2 = pts[j + 1];
        const dx2 = c2.x - a.x, dy2 = c2.y - a.y;
        const len2 = dx2 * dx2 + dy2 * dy2;
        const t = clamp(((e.x - a.x) * dx2 + (e.y - a.y) * dy2) / (len2 || 1), 0, 1);
        const cx = a.x + dx2 * t, cy = a.y + dy2 * t;
        const ddx = e.x - cx, ddy = e.y - cy;
        const d = Math.hypot(ddx, ddy);
        const thresh = e.hh + 3;
        if (d < thresh) {
          const ux = d > 0.001 ? ddx / d : 0;
          const uy = d > 0.001 ? ddy / d : -1;
          const depth = thresh - d;
          e.x += ux * depth;
          e.y += uy * depth;
          if (uy < -0.6) { e.vy = 0; e.onGround = true; }
        }
      }
    }

    // boxes
    for (let k = 0; k < boxes.length; k++) {
      const box = boxes[k];
      if (box.dead) continue;
      const a = box.aabb;
      const n = boxVsAABB(e.x - e.hw, e.y - e.hh, e.hw * 2, e.hh * 2,
                          a.x, a.y, a.w, a.h);
      if (n) {
        if (box.vy > 90 && e.y < a.y + a.h * 0.6) {
          killEnemy(e, 'crush');
          break;
        }
        e.crushTimer += dt;
        if (e.crushTimer > 0.7) {
          killEnemy(e, 'crush');
          break;
        }
        e.x += n.nx * n.depth;
        e.y += n.ny * n.depth;
        if (n.ny < -0.5) { e.vy = 0; e.onGround = true; }
        else if (n.ny > 0.5) e.vy = Math.max(e.vy, 0);
        box.push(-n.nx * n.depth * 0.55, -n.ny * n.depth * 0.55);
      }
    }
    if (!e.alive) continue;
    e.crushTimer = Math.max(0, e.crushTimer - dt * 1.8);

    // springs
    for (let k = 0; k < springs.length; k++) {
      const sp = springs[k];
      if (e.x + e.hw < sp.x || e.x - e.hw > sp.x + sp.w) continue;
      if (e.y + e.hh < sp.y || e.y - e.hh > sp.y + sp.h) continue;
      if (e.vy > 0) {
        e.vy = -1250;
        sp.anim = 1;
      }
    }

    // separation
    for (let j = 0; j < enemies.length; j++) {
      if (j === i) continue;
      const o = enemies[j];
      if (!o.alive) continue;
      const ddx = e.x - o.x;
      const ddy = e.y - o.y;
      if (Math.abs(ddx) < e.hw + o.hw && Math.abs(ddy) < e.hh + o.hh) {
        const push = (e.hw + o.hw - Math.abs(ddx)) * 0.5 * (ddx >= 0 ? 1 : -1);
        e.x += push;
        o.x -= push;
      }
    }

    // lava
    for (let k = 0; k < lavas.length; k++) {
      const lv = lavas[k];
      if (e.x + e.hw < lv.x || e.x - e.hw > lv.x + lv.w) continue;
      if (e.y + e.hh > lv.y) {
        killEnemy(e, 'lava');
        fxBurst(e.x, lv.y, 14, {
          colors: [[1, 0.6, 0.2], [1, 0.3, 0.1], [1, 0.9, 0.4]],
          spMax: 300, grav: -250, sizeMax: 12, upBias: 150
        });
        break;
      }
    }
    if (!e.alive) continue;

    // fell off
    if (e.y > DEATH_Y) {
      e.alive = false;
      if (Math.abs(e.x - player.x) < view.W) {
        makeRagdoll(e.x, e.y, 22, e.vx, e.vy, false);
        addPopup(e.x, e.y - 20, killMsg('fall'), '#ff8899');
      }
      state.kills++;
    }
  }
}

// ============================================================
//  JELLY RAGDOLLS  (soft-body squares, 3x3 grid)
// ============================================================
function makeRagdoll(cx, cy, size, vx, vy, isPlayer) {
  if (ragdolls.length >= MAX_RAGDOLLS) ragdolls.shift();

  const step = size / 2;
  const s = 1 / 60;
  const pts = [];
  for (let ry = 0; ry < 3; ry++) {
    for (let rx = 0; rx < 3; rx++) {
      const x = cx + (rx - 1) * step;
      const y = cy + (ry - 1) * step;
      pts.push({
        x, y,
        px: x - vx * s, py: y - vy * s,
        r: 2.2
      });
    }
  }
  const cons = [];
  const add = (a, b, k) => cons.push({
    a: pts[a], b: pts[b],
    d: Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y),
    k: k === undefined ? 1 : k
  });
  // edges
  add(0, 1); add(1, 2); add(3, 4); add(4, 5); add(6, 7); add(7, 8);
  add(0, 3); add(3, 6); add(1, 4); add(4, 7); add(2, 5); add(5, 8);
  // diagonals
  add(0, 4); add(4, 8); add(2, 4); add(4, 6);
  // outer shear (softer)
  add(0, 2, 0.55); add(6, 8, 0.55); add(0, 6, 0.55); add(2, 8, 0.55);

  ragdolls.push({
    pts, cons,
    color: isPlayer ? '#39d5ff' : '#e63048',
    size,
    life: 12,
    settleTimer: 0
  });
}

function updateRagdolls(dt) {
  for (let i = ragdolls.length - 1; i >= 0; i--) {
    const r = ragdolls[i];
    r.life -= dt;
    if (r.life < 0) {
      // fade out
      if (r.pts[4].y > DEATH_Y + 200) { ragdolls.splice(i, 1); continue; }
    }
    const P = r.pts;

    let allGone = true;
    for (let j = 0; j < P.length; j++) {
      if (P[j].y < DEATH_Y + 300) { allGone = false; break; }
    }
    if (allGone) { ragdolls.splice(i, 1); continue; }

    const g = 2600 * dt * dt;
    for (let j = 0; j < P.length; j++) {
      const p = P[j];
      const vx = (p.x - p.px) * 0.998;
      const vy = (p.y - p.py) * 0.998;
      p.px = p.x; p.py = p.y;
      p.x += vx;
      p.y += vy + g;
    }

    for (let it = 0; it < 8; it++) {
      for (let j = 0; j < r.cons.length; j++) solveCon(r.cons[j], 0.72);
      for (let j = 0; j < P.length; j++) {
        const p = P[j];
        // terrain
        const gy = terrainYAt(p.x);
        if (gy !== Infinity && p.y + p.r > gy) {
          const vx = p.x - p.px;
          const vy = p.y - p.py;
          p.y = gy - p.r;
          p.py = p.y + vy * 0.06;
          p.px = p.x - vx * 0.68;
        }
        // islands
        for (let k = 0; k < islands.length; k++) {
          const isl = islands[k];
          if (p.x + p.r < isl.x || p.x - p.r > isl.x + isl.w) continue;
          if (p.y + p.r < isl.y || p.y - p.r > isl.y + isl.h) continue;
          collidePointAABB(p, isl.x, isl.y, isl.w, isl.h);
        }
      }
    }
  }
}

// ============================================================
//  BOX PHYSICS
// ============================================================
function updateBoxAABB(box) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const P = box.pts;
  for (let i = 0; i < 4; i++) {
    const p = P[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  box.aabb.x = minX - 1;
  box.aabb.y = minY - 1;
  box.aabb.w = maxX - minX + 2;
  box.aabb.h = maxY - minY + 2;
}

function updateBoxes(dt) {
  const g = 2600 * dt * dt;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (box.dead) continue;
    let sumVy = 0;
    const P = box.pts;
    for (let j = 0; j < 4; j++) {
      const p = P[j];
      const vx = (p.x - p.px) * 0.998;
      const vy = (p.y - p.py) * 0.998;
      p.px = p.x; p.py = p.y;
      p.x += vx;
      p.y += vy + g;
      sumVy += p.y - p.py;
    }
    box.vy = (sumVy / 4) / Math.max(dt, 0.0001);

    for (let it = 0; it < 5; it++) {
      for (let j = 0; j < box.cons.length; j++) solveCon(box.cons[j], 0.9);
      for (let j = 0; j < 4; j++) {
        const p = P[j];
        const gy = terrainYAt(p.x);
        if (gy !== Infinity && p.y + p.r > gy) {
          const vx = p.x - p.px;
          const vy = p.y - p.py;
          p.y = gy - p.r;
          p.py = p.y + vy * 0.06;
          p.px = p.x - vx * 0.68;
        }
        for (let k = 0; k < islands.length; k++) {
          const isl = islands[k];
          if (p.x + p.r < isl.x || p.x - p.r > isl.x + isl.w) continue;
          if (p.y + p.r < isl.y || p.y - p.r > isl.y + isl.h) continue;
          collidePointAABB(p, isl.x, isl.y, isl.w, isl.h);
        }
      }
    }
    updateBoxAABB(box);
    if (box.aabb.y > DEATH_Y + 260) box.dead = true;
  }

  // box vs box
  for (let i = 0; i < boxes.length; i++) {
    const A = boxes[i];
    if (A.dead) continue;
    for (let j = i + 1; j < boxes.length; j++) {
      const B = boxes[j];
      if (B.dead) continue;
      const a = A.aabb, b = B.aabb;
      if (a.x + a.w < b.x || b.x + b.w < a.x) continue;
      if (a.y + a.h < b.y || b.y + b.h < a.y) continue;
      const ox = Math.min(a.x + a.w - b.x, b.x + b.w - a.x);
      const oy = Math.min(a.y + a.h - b.y, b.y + b.h - a.y);
      if (ox < oy) {
        const dir = (a.x + a.w * 0.5) < (b.x + b.w * 0.5) ? -1 : 1;
        const push = ox * 0.25 * dir;
        A.push(push, 0);
        B.push(-push, 0);
      } else {
        const dir = (a.y + a.h * 0.5) < (b.y + b.h * 0.5) ? -1 : 1;
        const push = oy * 0.25 * dir;
        A.push(0, push);
        B.push(0, -push);
      }
    }
  }
}

// ============================================================
//  PLANKS PHYSICS
// ============================================================
function updatePlanks(dt) {
  const g = 2600 * dt * dt;
  for (let i = 0; i < planks.length; i++) {
    const plank = planks[i];
    const P = plank.pts;

    for (let j = 0; j < P.length; j++) {
      const p = P[j];
      if (p.pin) { p.px = p.x; p.py = p.y; continue; }
      const vx = (p.x - p.px) * 0.996;
      const vy = (p.y - p.py) * 0.996;
      p.px = p.x; p.py = p.y;
      p.x += vx;
      p.y += vy + g * 0.7;
    }

    const stiff = plank.broken ? 0.55 : 0.9;
    for (let it = 0; it < (plank.broken ? 4 : 6); it++) {
      for (let j = 0; j < plank.cons.length; j++) solveCon(plank.cons[j], stiff);
      for (let j = 0; j < P.length; j++) {
        const p = P[j];
        if (p.pin) continue;
        const gy = terrainYAt(p.x);
        if (gy !== Infinity && p.y + p.r > gy) {
          const vx = p.x - p.px;
          const vy = p.y - p.py;
          p.y = gy - p.r;
          p.py = p.y + vy * 0.15;
          p.px = p.x - vx * 0.75;
        }
        for (let k = 0; k < islands.length; k++) {
          const isl = islands[k];
          if (p.x + p.r < isl.x || p.x - p.r > isl.x + isl.w) continue;
          if (p.y + p.r < isl.y || p.y - p.r > isl.y + isl.h) continue;
          collidePointAABB(p, isl.x, isl.y, isl.w, isl.h);
        }
      }
    }

    // despawn broken planks that have drifted far away
    if (plank.broken && Math.abs(P[0].x - player.x) > view.W * 1.6) {
      planks.splice(i, 1);
      i--;
    }
  }
}

function playerVsPlanks(p) {
  let grounded = false;
  let x = p.x, y = p.y;
  for (let pi = 0; pi < planks.length; pi++) {
    const plank = planks[pi];
    const pts = plank.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 0.0001) continue;
      const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1);
      const cx = a.x + dx * t, cy = a.y + dy * t;
      const ddx = x - cx, ddy = y - cy;
      const d = Math.hypot(ddx, ddy);
      const thresh = p.hh + 3;
      if (d < thresh) {
        const ux = d > 0.001 ? ddx / d : 0;
        const uy = d > 0.001 ? ddy / d : -1;
        const depth = thresh - d;
        x += ux * depth;
        y += uy * depth;
        if (uy < -0.55 && p.vy > -50) {
          grounded = true;
          if (p.vy > 0) p.vy = 0;
        }
        // slam = break
        if (p.vy > 900 && !plank.broken) {
          breakPlank(plank, i);
          shake(0.3);
        }
      }
    }
  }
  return { x, y, grounded };
}

// ============================================================
//  PICKUPS UPDATE
// ============================================================
function updatePickups(dt) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const pk = pickups[i];
    pk.life -= dt;
    pk.anim += dt * 3;
    if (pk.life < 0 || pk.taken) {
      pickups.splice(i, 1);
      continue;
    }

    // float gently
    pk.y += Math.sin(pk.anim) * 0.15;

    // player collision
    const dx = player.x - pk.x;
    const dy = player.y - pk.y;
    if (dx * dx + dy * dy < 26 * 26 && player.alive) {
      pk.taken = true;
      if (pk.type === 'gun') {
        player.hasGun = true;
        player.ammo += pk.amount;
        addPopup(pk.x, pk.y - 22, 'GUN!', '#ffd24a');
        fxBurst(pk.x, pk.y, 16, {
          colors: [[1, 0.85, 0.3], [1, 0.7, 0.2], [1, 1, 0.7]],
          spMax: 260, grav: 200, sizeMax: 10
        });
      } else {
        player.ammo += pk.amount;
        addPopup(pk.x, pk.y - 22, '+' + pk.amount + ' AMMO', '#ffd24a');
        fxBurst(pk.x, pk.y, 10, {
          colors: [[1, 0.85, 0.3], [1, 1, 0.6]],
          spMax: 220, grav: 200, sizeMax: 8
        });
      }
      shake(0.12);
    }
  }
}

// ============================================================
//  SPRINGS ANIM
// ============================================================
function updateSprings(dt) {
  for (let i = 0; i < springs.length; i++) {
    if (springs[i].anim > 0) {
      springs[i].anim = Math.max(0, springs[i].anim - dt * 4);
    }
  }
}

// ============================================================
//  CRUMBLE TILES
// ============================================================
function updateCrumble(dt) {
  for (let c = 0; c < WORLD_COLS; c++) {
    if (terrain.crumble[c] > 0) {
      terrain.crumble[c] += dt * 0.5;
      if (terrain.crumble[c] > 1.1 && terrain.s[c]) {
        terrain.s[c] = 0;
        fxPixel(c * CELL + CELL / 2, terrain.gy[c], 6, {
          colors: [[0.5, 0.4, 0.3], [0.35, 0.25, 0.2], [0.7, 0.55, 0.4]],
          spMax: 180, grav: 1400, sizeMax: 6
        });
      }
    }
  }
}

// ============================================================
//  TOP-LEVEL UPDATE
// ============================================================
function update(dt) {
  updateBullets(dt);
  updateDebris(dt);
  updatePlanks(dt);
  updateBoxes(dt);
  updateRagdolls(dt);
  updateEnemies(dt);
  updateSprings(dt);
  updatePickups(dt);
  updateCrumble(dt);

  // cleanup
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (boxes[i].dead) boxes.splice(i, 1);
  }
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e.alive) { enemies.splice(i, 1); continue; }
    if (Math.abs(e.x - player.x) > 2400) enemies.splice(i, 1);
  }
  for (let i = ragdolls.length - 1; i >= 0; i--) {
    if (Math.abs(ragdolls[i].pts[4].x - player.x) > view.W * 2.2) {
      ragdolls.splice(i, 1);
    }
  }
}

// ============================================================
//  DRAW HELPERS
// ============================================================
function drawLavas(ctx, camX, camY) {
  const t = performance.now() * 0.003;
  for (let i = 0; i < lavas.length; i++) {
    const lv = lavas[i];
    const sx = lv.x - camX;
    const sy = lv.y - camY;
    if (sx + lv.w < -40 || sx > ctx.canvas.width + 40) continue;
    if (sy > view.H + 40) continue;
    const h = Math.max(120, view.H - sy);

    const grd = ctx.createLinearGradient(0, sy - 20, 0, sy + 60);
    grd.addColorStop(0, 'rgba(255,120,30,0.35)');
    grd.addColorStop(1, 'rgba(255,60,10,0.0)');
    ctx.fillStyle = grd;
    ctx.fillRect(sx - 8, sy - 20, lv.w + 16, 80);

    ctx.fillStyle = '#c93a00';
    ctx.fillRect(sx, sy, lv.w, h);
    for (let c = 0; c < lv.w; c += PIX) {
      const wave = Math.sin(t + (c * 0.4) + lv.anim) * 2;
      ctx.fillStyle = '#ff8c1a';
      ctx.fillRect(sx + c, sy + wave - 2, PIX, 5);
      ctx.fillStyle = '#ffd24a';
      ctx.fillRect(sx + c, sy + wave, PIX, 2);
    }
  }
}

function drawTerrain(ctx, camX, camY) {
  const c0 = Math.max(0, Math.floor(camX / CELL) - 1);
  const c1 = Math.min(WORLD_COLS - 1, Math.ceil((camX + view.W) / CELL) + 1);

  for (let c = c0; c <= c1; c++) {
    if (!terrain.s[c]) continue;
    const sx = Math.round(c * CELL - camX);
    const sy = Math.round(terrain.gy[c] - camY);
    if (sy > view.H) continue;
    const bodyH = Math.min(SLAB_H, view.H - sy + 40);
    if (bodyH <= 0) continue;

    const type = terrain.t[c];
    const rows = Math.min(8, Math.ceil(bodyH / PIX));

    for (let row = 0; row < rows; row++) {
      const by = sy + row * PIX;
      for (let col = 0; col < 2; col++) {
        const odd = ((c * 2 + col + row) & 1) === 0;
        let col1;
        if (type === TT.ICE) {
          if (row === 0) col1 = odd ? '#7ae4ff' : '#5ac8e8';
          else if (row === 1) col1 = odd ? '#3a9fc8' : '#2c7fa8';
          else if (row < 4) col1 = odd ? '#1d5a80' : '#174a6e';
          else col1 = odd ? '#0f3355' : '#0a2540';
        } else if (type === TT.BOUNCE) {
          if (row === 0) col1 = odd ? '#5aef7a' : '#3fd060';
          else if (row === 1) col1 = odd ? '#2fa048' : '#238c3a';
          else if (row < 4) col1 = odd ? '#1a6b2c' : '#155424';
          else col1 = odd ? '#0d3b18' : '#092a10';
        } else if (type === TT.STICKY) {
          if (row === 0) col1 = odd ? '#a94be0' : '#8b3ac8';
          else if (row === 1) col1 = odd ? '#6c2b9c' : '#54207a';
          else if (row < 4) col1 = odd ? '#3d1658' : '#2e1042';
          else col1 = odd ? '#1e0a2b' : '#15071e';
        } else if (type === TT.CRUMBLE) {
          if (row === 0) col1 = odd ? '#b08050' : '#8f6440';
          else if (row === 1) col1 = odd ? '#6f4d30' : '#5c3e26';
          else if (row < 4) col1 = odd ? '#3e2a1a' : '#322010';
          else col1 = odd ? '#1e140a' : '#160e06';
        } else if (type === TT.SPIKE) {
          if (row === 0) col1 = odd ? '#7a1a2a' : '#5c1420';
          else if (row === 1) col1 = odd ? '#4a0e18' : '#3a0a12';
          else if (row < 4) col1 = odd ? '#2a0810' : '#20060c';
          else col1 = odd ? '#140408' : '#0e0204';
        } else if (type === TT.CONVEYOR) {
          if (row === 0) col1 = odd ? '#e09630' : '#c87a1a';
          else if (row === 1) col1 = odd ? '#8a5810' : '#6e460a';
          else if (row < 4) col1 = odd ? '#3e2a08' : '#301e06';
          else col1 = odd ? '#1a1004' : '#120a02';
        } else {
          if (row === 0) col1 = odd ? '#5252c8' : '#3d3d9a';
          else if (row === 1) col1 = odd ? '#2b2b66' : '#232354';
          else if (row < 4) col1 = odd ? '#1c1c45' : '#18183a';
          else col1 = odd ? '#141430' : '#111128';
        }
        ctx.fillStyle = col1;
        ctx.fillRect(sx + col * PIX, by, PIX, PIX);
      }
    }

    // top decals
    if (type === TT.SPIKE) {
      const spCount = 2;
      for (let s = 0; s < spCount; s++) {
        const tx = sx + s * (CELL / spCount) + 1;
        ctx.fillStyle = '#d8a8b0';
        ctx.beginPath();
        ctx.moveTo(tx, sy);
        ctx.lineTo(tx + CELL / (spCount * 2), sy - 8);
        ctx.lineTo(tx + CELL / spCount - 2, sy);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#8a4a55';
        ctx.fillRect(tx + CELL / (spCount * 2) - 1, sy - 4, 2, 4);
      }
    } else if (type === TT.CONVEYOR) {
      const dir = terrain.cd[c] || 1;
      const t = performance.now() * 0.006 * dir;
      for (let s = 0; s < 2; s++) {
        const off = ((t + s * 7) % 14 + 14) % 14;
        const ax = sx + off - 3;
        ctx.fillStyle = '#ffe0a0';
        ctx.beginPath();
        if (dir > 0) {
          ctx.moveTo(ax, sy + 3);
          ctx.lineTo(ax + 4, sy + 6);
          ctx.lineTo(ax, sy + 9);
        } else {
          ctx.moveTo(ax + 4, sy + 3);
          ctx.lineTo(ax, sy + 6);
          ctx.lineTo(ax + 4, sy + 9);
        }
        ctx.closePath();
        ctx.fill();
      }
    } else if (type === TT.CRUMBLE) {
      const warn = terrain.crumble[c] / 1.1;
      if (warn > 0.05) {
        ctx.globalAlpha = warn * 0.6 + 0.2;
        ctx.fillStyle = '#ffb070';
        ctx.fillRect(sx, sy, CELL, 3);
        ctx.globalAlpha = 1;
      }
    } else if (type === TT.ICE) {
      ctx.fillStyle = 'rgba(200,240,255,0.35)';
      ctx.fillRect(sx + 2, sy + 1, 4, 2);
    }
  }
}

function drawIslands(ctx, camX, camY) {
  for (let i = 0; i < islands.length; i++) {
    const isl = islands[i];
    const sx = Math.round(isl.x - camX);
    const sy = Math.round(isl.y - camY);
    if (sx + isl.w < -20 || sx > view.W + 20) continue;
    if (sy > view.H) continue;
    const cols = Math.ceil(isl.w / CELL);
    for (let c = 0; c < cols; c++) {
      const cx = sx + c * CELL;
      for (let row = 0; row < 3; row++) {
        const by = sy + row * PIX;
        for (let col = 0; col < 2; col++) {
          const odd = ((c * 2 + col + row + i) & 1) === 0;
          let col1;
          if (row === 0) col1 = odd ? '#8a7ec8' : '#6e62a8';
          else if (row === 1) col1 = odd ? '#3e3568' : '#302954';
          else col1 = odd ? '#1e1a3e' : '#161230';
          ctx.fillStyle = col1;
          ctx.fillRect(cx + col * PIX, by, PIX, PIX);
        }
      }
    }
    ctx.fillStyle = '#0c0c1c';
    ctx.fillRect(sx, sy + 3 * PIX, isl.w, Math.max(0, isl.h - 3 * PIX) + 4);
  }
}

function drawPlanks(ctx, camX, camY) {
  for (let i = 0; i < planks.length; i++) {
    const plank = planks[i];
    const P = plank.pts;

    // shadow pass
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(P[0].x - camX + 2, P[0].y - camY + 3);
    for (let j = 1; j < P.length; j++) {
      ctx.lineTo(P[j].x - camX + 2, P[j].y - camY + 3);
    }
    ctx.stroke();

    // main wood
    ctx.strokeStyle = plank.broken ? '#7a4a24' : '#a86a2a';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(P[0].x - camX, P[0].y - camY);
    for (let j = 1; j < P.length; j++) {
      ctx.lineTo(P[j].x - camX, P[j].y - camY);
    }
    ctx.stroke();

    // highlight
    ctx.strokeStyle = 'rgba(255,210,140,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(P[0].x - camX, P[0].y - camY - 2);
    for (let j = 1; j < P.length; j++) {
      ctx.lineTo(P[j].x - camX, P[j].y - camY - 2);
    }
    ctx.stroke();

    // rope wraps at pinned ends
    ctx.fillStyle = '#5c3a0c';
    if (plank.pts[0].pin) {
      ctx.fillRect(P[0].x - camX - 4, P[0].y - camY - 5, 8, 10);
    }
    if (plank.pts[P.length - 1].pin) {
      const p = P[P.length - 1];
      ctx.fillRect(p.x - camX - 4, p.y - camY - 5, 8, 10);
    }
  }
}

function drawSprings(ctx, camX, camY) {
  for (let i = 0; i < springs.length; i++) {
    const sp = springs[i];
    const sx = Math.round(sp.x - camX);
    const sy = Math.round(sp.y - camY);
    if (sx + sp.w < -20 || sx > view.W + 20) continue;
    const squash = sp.anim * 8;
    ctx.fillStyle = '#2c7a3f';
    ctx.fillRect(sx, sy + sp.h - 4, sp.w, 4);
    ctx.fillStyle = '#4ade6a';
    ctx.fillRect(sx + 3, sy + squash, sp.w - 6, sp.h - 4 - squash);
    ctx.fillStyle = '#a8ffbe';
    ctx.fillRect(sx + 3, sy + squash, sp.w - 6, 3);
    ctx.fillStyle = '#1a4d28';
    ctx.fillRect(sx, sy + sp.h - 1, sp.w, 1);
  }
}

function drawBoxes(ctx, camX, camY) {
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (box.dead) continue;
    const a = box.aabb;
    if (a.x + a.w < camX - 30 || a.x > camX + view.W + 30) continue;
    const P = box.pts;
    ctx.beginPath();
    ctx.moveTo(P[0].x - camX, P[0].y - camY);
    ctx.lineTo(P[1].x - camX, P[1].y - camY);
    ctx.lineTo(P[2].x - camX, P[2].y - camY);
    ctx.lineTo(P[3].x - camX, P[3].y - camY);
    ctx.closePath();
    ctx.fillStyle = '#b8761f';
    ctx.fill();
    ctx.strokeStyle = '#5c3a0c';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(P[0].x - camX, P[0].y - camY);
    ctx.lineTo(P[1].x - camX, P[1].y - camY);
    ctx.strokeStyle = '#ffcc66';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(P[0].x - camX, P[0].y - camY);
    ctx.lineTo(P[2].x - camX, P[2].y - camY);
    ctx.moveTo(P[1].x - camX, P[1].y - camY);
    ctx.lineTo(P[3].x - camX, P[3].y - camY);
    ctx.strokeStyle = 'rgba(90,55,10,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawDebris(ctx, camX, camY) {
  for (let i = 0; i < debris.length; i++) {
    const d = debris[i];
    const sx = d.x - camX;
    const sy = d.y - camY;
    if (sx < -10 || sx > view.W + 10) continue;
    ctx.fillStyle = d.color;
    ctx.fillRect(sx - d.r, sy - d.r, d.r * 2, d.r * 2);
  }
}

function drawPickups(ctx, camX, camY) {
  const t = performance.now() * 0.004;
  for (let i = 0; i < pickups.length; i++) {
    const pk = pickups[i];
    const sx = pk.x - camX;
    const sy = pk.y - camY + Math.sin(t + pk.anim) * 2;
    if (sx < -30 || sx > view.W + 30) continue;

    // glow ring
    const glowR = 18 + Math.sin(t * 2 + pk.anim) * 3;
    const grd = ctx.createRadialGradient(sx, sy, 2, sx, sy, glowR);
    grd.addColorStop(0, pk.type === 'gun'
      ? 'rgba(255,210,70,0.55)'
      : 'rgba(120,220,255,0.55)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(sx - glowR, sy - glowR, glowR * 2, glowR * 2);

    if (pk.type === 'gun') {
      ctx.drawImage(TEX.gun, Math.round(sx - 15), Math.round(sy - 8));
    } else {
      ctx.drawImage(TEX.ammo, Math.round(sx - 7), Math.round(sy - 6));
    }
  }
}

function drawEnemies(ctx, camX, camY) {
  const t = performance.now() * 0.006;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.alive) continue;
    const sx = e.x - camX;
    const sy = e.y - camY;
    if (sx < -60 || sx > view.W + 60) continue;

    const wob = Math.sin(t * 2 + e.wobble) * 1.2;
    const size = e.hw * 2;
    const bx = sx - e.hw;
    const by = sy - e.hh + wob;

    ctx.globalAlpha = 0.14;
    ctx.fillStyle = '#ff3355';
    ctx.fillRect(bx - 4, by - 4, size + 8, size + 8);
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#e63048';
    ctx.fillRect(bx, by, size, size);

    ctx.fillStyle = '#ff7a8c';
    ctx.fillRect(bx, by, size, 3);
    ctx.fillRect(bx, by, 3, size);

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(bx, by + size - 3, size, 3);
    ctx.fillRect(bx + size - 3, by, 3, size);

    const ed = e.dir;
    ctx.fillStyle = '#0a0a12';
    const eyeY = by + size * 0.35;
    const eyeS = Math.max(3, size * 0.18);
    const eye1X = bx + size * 0.22 + (ed > 0 ? 2 : 0);
    const eye2X = bx + size * 0.62 + (ed > 0 ? 2 : 0);
    ctx.fillRect(eye1X, eyeY, eyeS, eyeS + 2);
    ctx.fillRect(eye2X, eyeY, eyeS, eyeS + 2);

    ctx.strokeStyle = '#6b0f1e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(eye1X - 1, eyeY - 3);
    ctx.lineTo(eye1X + eyeS + 1, eyeY - 1);
    ctx.moveTo(eye2X - 1, eyeY - 1);
    ctx.lineTo(eye2X + eyeS + 1, eyeY - 3);
    ctx.stroke();
  }
}

function drawJellySquare(ctx, r, camX, camY) {
  const P = r.pts;
  const sx0 = P[4].x - camX;
  if (sx0 < -140 || sx0 > view.W + 140) return;

  const col = r.color;
  const dark = col === '#39d5ff' ? '#0f7aa8' : '#8a1424';
  const light = col === '#39d5ff' ? '#a8f0ff' : '#ff8899';

  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(P[0].x - camX + 2, P[0].y - camY + 2);
  ctx.lineTo(P[1].x - camX + 2, P[1].y - camY + 2);
  ctx.lineTo(P[2].x - camX + 2, P[2].y - camY + 2);
  ctx.lineTo(P[5].x - camX + 2, P[5].y - camY + 2);
  ctx.lineTo(P[8].x - camX + 2, P[8].y - camY + 2);
  ctx.lineTo(P[7].x - camX + 2, P[7].y - camY + 2);
  ctx.lineTo(P[6].x - camX + 2, P[6].y - camY + 2);
  ctx.lineTo(P[3].x - camX + 2, P[3].y - camY + 2);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = col;
  const quads = [[0,1,4,3],[1,2,5,4],[3,4,7,6],[4,5,8,7]];
  for (let i = 0; i < quads.length; i++) {
    const q = quads[i];
    ctx.beginPath();
    ctx.moveTo(P[q[0]].x - camX, P[q[0]].y - camY);
    ctx.lineTo(P[q[1]].x - camX, P[q[1]].y - camY);
    ctx.lineTo(P[q[2]].x - camX, P[q[2]].y - camY);
    ctx.lineTo(P[q[3]].x - camX, P[q[3]].y - camY);
    ctx.closePath();
    ctx.fill();
  }

  ctx.beginPath();
  ctx.moveTo(P[0].x - camX, P[0].y - camY);
  ctx.lineTo(P[1].x - camX, P[1].y - camY);
  ctx.lineTo(P[2].x - camX, P[2].y - camY);
  ctx.lineTo(P[5].x - camX, P[5].y - camY);
  ctx.lineTo(P[8].x - camX, P[8].y - camY);
  ctx.lineTo(P[7].x - camX, P[7].y - camY);
  ctx.lineTo(P[6].x - camX, P[6].y - camY);
  ctx.lineTo(P[3].x - camX, P[3].y - camY);
  ctx.closePath();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.moveTo(P[0].x - camX + 2, P[0].y - camY + 2);
  ctx.lineTo(P[1].x - camX - 2, P[1].y - camY + 2);
  ctx.lineTo(P[3].x - camX + 2, P[3].y - camY - 2);
  ctx.closePath();
  ctx.fill();

  const ex1 = (P[0].x + P[3].x) * 0.5 - camX;
  const ex2 = (P[2].x + P[5].x) * 0.5 - camX;
  const ey = (P[0].y + P[2].y) * 0.5 - camY;
  ctx.fillStyle = 'rgba(10,15,25,0.65)';
  ctx.fillRect(ex1 - 3, ey - 3, 4, 5);
  ctx.fillRect(ex2 - 1, ey - 3, 4, 5);
}

function drawRagdolls(ctx, camX, camY) {
  for (let i = 0; i < ragdolls.length; i++) {
    drawJellySquare(ctx, ragdolls[i], camX, camY);
  }
}

function drawBullets(ctx, camX, camY) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    const sx = b.x - camX;
    const sy = b.y - camY;
    if (sx < -20 || sx > view.W + 20) continue;

    // trail line
    const tx = b.px - camX;
    const ty = b.py - camY;
    const grad = ctx.createLinearGradient(tx, ty, sx, sy);
    grad.addColorStop(0, 'rgba(255,200,80,0)');
    grad.addColorStop(1, 'rgba(255,220,120,0.9)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(sx, sy);
    ctx.stroke();

    // bullet core
    ctx.fillStyle = '#fff2b8';
    ctx.fillRect(sx - 2, sy - 2, 4, 4);
    ctx.fillStyle = '#ffcc44';
    ctx.fillRect(sx - 1, sy - 1, 2, 2);
  }
  ctx.restore();
}

// ============================================================
//  PUBLIC API
// ============================================================
return {
  // constants
  TT, CELL, PIX, WORLD_COLS, WORLD_W, SLAB_H, DEATH_Y,

  // injected helpers forwarded
  terrain,

  // data arrays (mutated in place)
  islands, boxes, springs, planks, pickups, bullets, debris,
  enemies, ragdolls, lavas,

  // textures
  TEX,

  // lifecycle
  init,
  generateWorld,
  placeStuff,
  update,

  // queries
  terrainTypeAt,
  conveyorDirAt,
  terrainYAt,
  footprintGround,
  addCrumble,

  // gameplay hooks
  spawnEnemy,
  killEnemy,
  makeRagdoll,
  spawnBullet,
  spawnPickup,
  damageTerrain,
  breakPlank,
  playerVsPlanks,

  // drawing
  draw: {
    lavas: drawLavas,
    terrain: drawTerrain,
    islands: drawIslands,
    planks: drawPlanks,
    springs: drawSprings,
    boxes: drawBoxes,
    debris: drawDebris,
    pickups: drawPickups,
    enemies: drawEnemies,
    ragdolls: drawRagdolls,
    bullets: drawBullets
  }
};

})();
