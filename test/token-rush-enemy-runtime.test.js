import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { SoloSliceRoom } from '../server/solo-slice-room.js';
import { loadTokenRushEnemyCatalogFile } from '../shared/token-rush-enemies.js';
import { compileTokenRushLevel } from '../shared/token-rush-level.js';

const demoLevelFile = new URL('../content/token-rush-enemy-demo-level.json', import.meta.url);

async function authoredRoom() {
  const catalog = loadTokenRushEnemyCatalogFile().catalog;
  const document = JSON.parse(await readFile(demoLevelFile, 'utf8'));
  return new SoloSliceRoom({ level: compileTokenRushLevel(document, catalog) });
}

function bossIn(room) {
  return room.enemies.find((enemy) => enemy.type === 'ossuary-colossus' && !enemy.detached);
}

test('JSON transition atomically detaches a live nested subtree into a deterministic new entity', async () => {
  const room = await authoredRoom();
  const boss = bossIn(room);
  room.player.position = { x: boss.position.x - 200, y: boss.position.y };

  room.updateEnemies(0.02);

  const detached = room.enemies.find((enemy) => enemy.rootPartId === 'left-arm');
  assert.ok(detached);
  assert.equal(detached.id, `${boss.id}~left-arm~1`);
  assert.equal(detached.detached, true);
  assert.deepEqual([...detached.partMap.keys()], ['left-arm', 'left-claw']);
  assert.equal(boss.partMap.has('left-arm'), false);
  assert.equal(boss.partMap.has('left-claw'), false);
  assert.deepEqual(detached.velocity, { x: -130, y: -170 });

  room.updateEnemies(0.02);
  assert.equal(detached.controllerRuntime.has('detached-left-arm-hunt'), true);
  const snapshot = room.enemyRuntime.snapshot();
  assert.equal(snapshot.find((enemy) => enemy.id === boss.id).parts.some((part) => part.id === 'left-arm'), false);
  assert.deepEqual(snapshot.find((enemy) => enemy.id === detached.id).parts.map((part) => part.id), ['left-arm', 'left-claw']);

  const secondRoom = await authoredRoom();
  const secondBoss = bossIn(secondRoom);
  secondRoom.player.position = { x: secondBoss.position.x - 200, y: secondBoss.position.y };
  secondRoom.updateEnemies(0.02);
  assert.equal(secondRoom.enemies.find((enemy) => enemy.rootPartId === 'left-arm').id, detached.id);
});

test('destroyed parts disappear and a detach-policy child survives as a new entity', async () => {
  const room = await authoredRoom();
  const boss = bossIn(room);

  room.enemyRuntime.destroyPart(boss, 'bell-skull');

  const crown = room.enemies.find((enemy) => enemy.rootPartId === 'crown');
  assert.ok(crown);
  assert.equal(crown.detached, true);
  assert.equal(boss.alive, true);
  assert.equal(boss.partMap.get('bell-skull').alive, false);
  assert.equal(boss.partMap.has('crown'), false);
  let snapshot = room.enemyRuntime.snapshot();
  const bossSnapshot = snapshot.find((enemy) => enemy.id === boss.id);
  assert.equal(bossSnapshot.parts.some((part) => part.id === 'bell-skull' || part.id === 'crown'), false);
  assert.deepEqual(snapshot.find((enemy) => enemy.id === crown.id).parts.map((part) => part.id), ['crown']);

  room.enemyRuntime.destroyPart(crown, 'crown');
  snapshot = room.enemyRuntime.snapshot();
  const destroyedCrown = snapshot.find((enemy) => enemy.id === crown.id);
  assert.equal(destroyedCrown.alive, false);
  assert.deepEqual(destroyedCrown.parts, []);
});

test('nested part HP is independently targetable and disappearing destruction leaves the entity alive', async () => {
  const room = await authoredRoom();
  const boss = bossIn(room);
  const crownPosition = room.enemyRuntime.partPosition(boss, 'crown');
  room.player.position = { x: crownPosition.x - 50, y: crownPosition.y };
  room.player.facing = 1;

  const hit = room.enemyRuntime.resolvePlayerAttack(room.player);

  assert.deepEqual(hit, { entityId: boss.id, partId: 'crown' });
  assert.equal(boss.alive, true);
  assert.equal(boss.health, 8);
  assert.equal(boss.partMap.get('crown').alive, false);
  const snapshot = room.enemyRuntime.snapshot().find((enemy) => enemy.id === boss.id);
  assert.equal(snapshot.parts.some((part) => part.id === 'crown'), false);
  assert.equal(snapshot.parts.some((part) => part.id === 'bell-skull'), true);
});

test('a child-owned JSON melee timeline telegraphs then damages from the child world position', async () => {
  const room = await authoredRoom();
  const boss = bossIn(room);
  for (const enemy of room.enemies) if (enemy !== boss) enemy.alive = false;
  const clawPosition = room.enemyRuntime.partPosition(boss, 'right-claw');
  room.player.position = { x: clawPosition.x - 15, y: clawPosition.y };
  room.player.health = room.player.maxHealth;
  room.player.invulnerabilityTicks = 0;

  for (let tick = 0; tick < 9; tick += 1) room.enemyRuntime.updateAttacks(boss, room.player);
  const telegraph = room.enemyRuntime.snapshot().find((enemy) => enemy.id === boss.id).attacks;
  assert.equal(telegraph.some((attack) => attack.id === 'right-rake'), true);
  assert.equal(room.player.health, room.player.maxHealth);

  for (let tick = 0; tick < 3; tick += 1) room.enemyRuntime.updateAttacks(boss, room.player);
  assert.equal(room.player.health, room.player.maxHealth - 1);
  assert.equal(room.feedback.some((event) => event.type === 'playerHurt' && event.text.includes('Right Bone Claw')), true);
});
