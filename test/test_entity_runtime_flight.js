/* Headless smoke test for the flying-enemy fixes in agent/web/entity_runtime.js:
   (1) player-seeking motions only engage within motion.range; (2) flyers are blocked
   by solid tiles. Run with:  node test/test_entity_runtime_flight.js
   Exits non-zero on failure. No DOM needed (createWorkshop is never called). */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "agent", "web", "entity_runtime.js"), "utf8");
const sandbox = { performance: { now: () => 0 }, Math, console };
sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox);
const RT = sandbox.EntityRuntime;
if (!RT) throw new Error("EntityRuntime did not load");

const TILE = 32;
let failures = 0;
function check(name, cond) {
  if (cond) { console.log("  ok  -", name); }
  else { console.log("  FAIL-", name); failures++; }
}

function hoverEnemy(range) {
  return {
    v: 1, id: "flit", name: "Flit", kind: "enemy",
    root: { id: "flit", tags: ["enemy"],
      visual: { shape: "box", size: [1, 1], tint: "#6fc3ff" },
      body: { shape: "box", size: [1, 1], gravity: 0 },
      health: { max: 4 }, contact: { damage: 1 },
      motion: { type: "hover", speed: 2, range } },
  };
}

// --- 1. Awareness range: far player is ignored, near player is chased ---
(() => {
  const player = { x: 3000, y: 160, w: 20, h: 28 };   // far away (~90 tiles)
  const host = RT.create({
    tile: TILE, isSolid: () => false,
    getBounds: () => ({ width: 4000, height: 600 }),
    getPlayer: () => player,
  });
  const inst = host.spawn(hoverEnemy(5), 320, 160);   // range 5 tiles
  const startX = inst.root.x;
  for (let i = 0; i < 120; i++) host.update(0, 1 / 60, []);
  check("far player: enemy holds near its post (does not traverse toward player)",
        Math.abs(inst.root.x - startX) < 2 * TILE && inst.root.x < 1000);

  player.x = 460;   // now ~4.4 tiles away -> within range
  const beforeX = inst.root.x;
  for (let i = 0; i < 30; i++) host.update(0, 1 / 60, []);
  check("near player: enemy re-engages and moves toward the player",
        inst.root.x > beforeX + 4);
})();

// --- 2. Platform collision: a flyer cannot pass through a solid tile column ---
(() => {
  const player = { x: 640, y: 160, w: 20, h: 28 };    // to the right, within range
  const WALL_COL = 13;                                // solid column at x 416..448
  const host = RT.create({
    tile: TILE, isSolid: (c) => c === WALL_COL,
    getBounds: () => ({ width: 4000, height: 600 }),
    getPlayer: () => player,
  });
  const inst = host.spawn(hoverEnemy(20), 320, 160);  // starts left of the wall, big range
  for (let i = 0; i < 300; i++) host.update(0, 1 / 60, []);
  const rightEdge = inst.root.x + inst.root.w / 2;
  check("flyer is blocked by the solid column (stays left of the wall)",
        rightEdge <= WALL_COL * TILE + 0.5);
})();

// --- 3. A multi-tile body overlapping a solid is NOT frozen (boss can still seek) ---
(() => {
  const player = { x: 360, y: 300, w: 20, h: 28 };   // adjacent to the boss, within range
  const PLAT_ROW = 9;                                 // solid row cutting through the boss body
  const host = RT.create({
    tile: TILE, isSolid: (c, r) => r === PLAT_ROW,
    getBounds: () => ({ width: 2000, height: 1200 }),
    getPlayer: () => player,
  });
  const boss = {
    v: 1, id: "b", name: "B", kind: "boss",
    root: { id: "b", tags: ["boss"], visual: { shape: "box", size: [2.4, 1.2] },
      body: { shape: "box", size: [2.4, 1.2], gravity: 0 }, health: { max: 100 },
      contact: { damage: 1 }, motion: { type: "hover", speed: 2, range: 8 } },
  };
  const inst = host.spawn(boss, 300, 300);            // body overlaps the platform row
  const startX = inst.root.x;
  for (let i = 0; i < 120; i++) host.update(0, 1 / 60, []);
  check("boss overlapping a platform still moves toward the adjacent player (not frozen)",
        inst.root.x > startX + 4);
})();

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall entity_runtime flight checks passed");
