(function (global) {
  "use strict";

  const DEFAULT_TILE = 32;
  const NEAR_TILES = 5;
  const FAR_TILES = 8;

  function isEntitySpec(value) {
    return !!(value && typeof value === "object" && value.root &&
      (value.v != null || value.kind === "enemy" || value.kind === "boss"));
  }

  function nodeSize(node) {
    const visual = node.visual || {}, body = node.body || {};
    if (Array.isArray(visual.size)) return visual.size;
    if (Array.isArray(body.size)) return body.size;
    if (body.radius) return [body.radius * 2, body.radius * 2];
    return [1, 1];
  }

  function create(options) {
    const tile = options.tile || DEFAULT_TILE;
    const instances = [];
    let serial = 0;

    const player = () => options.getPlayer && options.getPlayer();
    const bounds = () => options.getBounds ? options.getBounds() : { width: 24 * tile, height: 13 * tile };
    const isSolid = (c, r) => options.isSolid ? options.isSolid(c, r) : false;
    const playerX = () => { const p = player(); return p ? p.x + p.w / 2 : 0; };
    const playerY = () => { const p = player(); return p ? p.y + p.h / 2 : 0; };
    const vec = (value) => [((value && value[0]) || 0) * tile, ((value && value[1]) || 0) * tile];

    function makeEntity(instance, node, parent, isRoot, depth) {
      const size = nodeSize(node);
      return {
        uid: `${instance.uid}:${node.id || "entity"}:${instance.nextEntityId++}`,
        id: node.id || "entity", spec: node, tags: node.tags || [],
        parent, isRoot: !!isRoot, detached: false, isProjectile: false, depth: depth || 0,
        atOffset: vec(node.at), x: 0, y: 0, vx: 0, vy: 0,
        w: Math.max(6, (+size[0] || 1) * tile), h: Math.max(6, (+size[1] || 1) * tile),
        shape: (node.visual && node.visual.shape) || (node.body && node.body.shape) || "box",
        tint: (node.visual && node.visual.tint) || (isRoot ? "#c792ea" : "#7bd88f"),
        gravityOn: !!(node.body && node.body.gravity),
        hpMax: node.health && +node.health.max, hp: node.health && +node.health.max,
        contact: node.contact || null, emitters: node.emitters || {}, on: node.on || {},
        vars: Object.assign({}, node.vars || {}), ttl: node.life && +node.life.ttl,
        age: 0, motion: node.motion ? Object.assign({}, node.motion) : null,
        alive: true, enabled: true, telegraphUntil: 0, autoFireAt: 0,
        moveTarget: null, dashUntil: 0, children: [], brain: null,
      };
    }

    function addChildren(instance, parent, nodes, depth) {
      for (const node of nodes || []) {
        const child = makeEntity(instance, node, parent, false, depth);
        child.x = parent.x + child.atOffset[0]; child.y = parent.y + child.atOffset[1];
        parent.children.push(child); instance.entities.push(child);
        addChildren(instance, child, node.children, depth + 1);
      }
    }

    function spawn(spec, x, y, meta) {
      if (!isEntitySpec(spec)) throw new Error("not an EntitySpec");
      const instance = {
        uid: `spec${++serial}`, spec, defs: spec.defs || {}, entities: [], signals: new Set(),
        elapsed: 0, spawnTimes: [], nextEntityId: 0, killed: false, meta: meta || {},
        limits: Object.assign({ maxAlive: 64, maxSpawnsPerSecond: 12, maxSpawnDepth: 4 }, spec.limits || {}),
      };
      const root = makeEntity(instance, spec.root, null, true, 0);
      root.x = x; root.y = y; instance.root = root; instance.entities.push(root);
      addChildren(instance, root, spec.root.children, 1);
      if (spec.brain && spec.brain.states) {
        root.brain = { states: spec.brain.states, cur: null, tracks: [], stateSince: 0, near: false };
        enterState(instance, root, spec.brain.start);
      }
      runEvent(instance, root, "spawn", performance.now());
      instances.push(instance);
      return instance;
    }

    function reset() { instances.length = 0; }
    function living(instance) { return instance.entities.filter(e => e.alive && e.enabled); }
    function resolveDef(instance, ref) {
      if (instance.defs[ref]) return Object.assign({ id: ref }, instance.defs[ref]);
      const found = instance.entities.find(e => e.id === ref);
      return found && found.spec;
    }
    function findEntity(instance, id) { return instance.entities.find(e => e.id === id && e.alive); }

    function tokenize(source) {
      const out = [], re = /\s*([0-9]*\.?[0-9]+|'[^']*'|[A-Za-z_][\w.]*|<=|>=|==|!=|&&|\|\||[()<>!*/+\-,])/g;
      let match; while ((match = re.exec(source))) out.push(match[1]);
      return out;
    }
    function parse(tokens) {
      let index = 0;
      const peek = () => tokens[index], next = () => tokens[index++];
      const precedence = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6 };
      function primary() {
        const token = next();
        if (token === "(") { const value = expression(0); next(); return value; }
        if (token === "!") return { op: "!", a: primary() };
        if (token === "-") return { op: "neg", a: primary() };
        if (/^'.*'$/.test(token)) return { str: token.slice(1, -1) };
        if (/^[0-9.]+$/.test(token)) return { num: parseFloat(token) };
        if (peek() === "(") {
          next(); const args = [];
          if (peek() !== ")") { args.push(expression(0)); while (peek() === ",") { next(); args.push(expression(0)); } }
          next(); return { fn: token, args };
        }
        return { id: token };
      }
      function expression(minimum) {
        let left = primary();
        while (peek() && precedence[peek()] >= minimum && precedence[peek()]) {
          const op = next(), right = expression(precedence[op] + 1);
          left = { op, a: left, b: right };
        }
        return left;
      }
      return expression(0);
    }

    function pointOf(instance, ref, self) {
      if (ref === "player") return { x: playerX(), y: playerY() };
      if (ref === "self") return { x: self.x, y: self.y };
      const entity = findEntity(instance, ref);
      return entity ? { x: entity.x, y: entity.y } : { x: 0, y: 0 };
    }
    function distanceToPlayer(entity) { return Math.hypot(playerX() - entity.x, playerY() - entity.y) / tile; }
    function resolvePath(instance, path, self) {
      const parts = path.split(".");
      if (path === "true") return true;
      if (path === "false") return false;
      if (path === "timer") return self && self.brain ? instance.elapsed - self.brain.stateSince : instance.elapsed;
      if (path === "playerNear") return distanceToPlayer(self) < NEAR_TILES;
      if (path === "playerFar") return distanceToPlayer(self) > FAR_TILES;
      if (path === "playerAbove") return playerY() < self.y - tile;
      if (path === "playerBelow") return playerY() > self.y + tile;
      let value;
      if (parts[0] === "self") value = self;
      else if (parts[0] === "root") value = instance.root;
      else if (parts[0] === "player") { const p = player(); value = p || {}; }
      else if (parts[0] === "arena") value = { time: instance.elapsed };
      else return 0;
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === "hpPct" && value && value.hpMax) { value = value.hp / value.hpMax; continue; }
        value = value && value[parts[i]];
      }
      return value == null ? 0 : value;
    }
    function evaluateNode(instance, node, self) {
      if (Object.prototype.hasOwnProperty.call(node, "num")) return node.num;
      if (Object.prototype.hasOwnProperty.call(node, "str")) return node.str;
      if (node.id !== undefined) return resolvePath(instance, node.id, self);
      if (node.fn !== undefined) {
        const args = node.args.map(arg => evaluateNode(instance, arg, self)), selector = args[0];
        if (node.fn === "alive") return !!findEntity(instance, selector);
        if (node.fn === "exists") return instance.entities.some(e => e.id === selector);
        if (node.fn === "countAlive") {
          const tag = String(selector).startsWith("tag:") ? String(selector).slice(4) : null;
          return living(instance).filter(e => tag ? e.tags.includes(tag) : e.id === selector).length;
        }
        if (node.fn === "distance") { const a = pointOf(instance, args[0], self), b = pointOf(instance, args[1], self); return Math.hypot(a.x - b.x, a.y - b.y) / tile; }
        if (node.fn === "randomChance") return Math.random() < args[0];
        if (node.fn === "cooldownReady") return true;
        return 0;
      }
      if (node.op === "!") return !evaluateNode(instance, node.a, self);
      if (node.op === "neg") return -evaluateNode(instance, node.a, self);
      const a = evaluateNode(instance, node.a, self), b = evaluateNode(instance, node.b, self);
      switch (node.op) {
        case "&&": return a && b; case "||": return a || b;
        case "==": return a == b; case "!=": return a != b;
        case "<": return a < b; case ">": return a > b; case "<=": return a <= b; case ">=": return a >= b;
        case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return a / b;
      }
      return 0;
    }
    function evalExpr(instance, source, self) {
      try { return !!evaluateNode(instance, parse(tokenize(String(source))), self); } catch (_) { return false; }
    }

    function enterState(instance, entity, stateId) {
      const state = entity.brain && entity.brain.states[stateId];
      if (!state) return;
      entity.brain.cur = stateId; entity.brain.stateSince = instance.elapsed;
      entity.brain.tracks = (state.tracks || []).map(track => ({ spec: track, index: 0, loop: track.loop !== false, waitUntil: 0, started: false, done: false }));
      const enter = (state.enter || []).concat(entity.on.stateEnter || []);
      if (enter.length) entity.brain.tracks.push({ spec: { steps: enter }, index: 0, loop: false, waitUntil: 0, started: false, done: false });
    }
    function runExit(instance, entity, now) { for (const action of entity.on.stateExit || []) doAction(instance, entity, action, now); }
    function resolvePoint(instance, target, entity) {
      const world = bounds();
      if (target === "player") return { x: playerX(), y: playerY() };
      if (target === "self") return { x: entity.x, y: entity.y };
      if (target === "arena.randomAir") return { x: Math.max(tile, Math.min(world.width - tile, entity.x + (Math.random() - .5) * 16 * tile)), y: Math.max(tile, Math.min(world.height * .6, entity.y + (Math.random() - .5) * 8 * tile)) };
      if (target === "arena.randomGround") return { x: Math.max(tile, Math.min(world.width - tile, entity.x + (Math.random() - .5) * 16 * tile)), y: Math.max(tile, world.height - tile * 1.5) };
      const found = findEntity(instance, target);
      return found ? { x: found.x, y: found.y } : { x: entity.x, y: entity.y };
    }
    function waitMs(value) {
      if (typeof value === "number") return value * 1000;
      if (value && Array.isArray(value.range)) return (value.range[0] + Math.random() * (value.range[1] - value.range[0])) * 1000;
      if (value && value.seconds != null) return value.seconds * 1000;
      if (value && value.duration != null) return value.duration * 1000;
      return 500;
    }
    function advanceTracks(instance, entity, now) {
      if (!entity.brain) return;
      for (const track of entity.brain.tracks) {
        if (track.done) continue;
        let guard = 0;
        while (guard++ < 20) {
          const step = track.spec.steps && track.spec.steps[track.index];
          if (!step) { if (track.loop) { track.index = 0; continue; } track.done = true; break; }
          const verb = Object.keys(step)[0], args = step[verb];
          if (verb === "wait") {
            if (!track.started) { track.started = true; track.waitUntil = now + waitMs(args); }
            if (now < track.waitUntil) break;
            track.started = false; track.index++; continue;
          }
          if (verb === "telegraph") {
            if (!track.started) { track.started = true; track.waitUntil = now + ((args && args.time) || .5) * 1000; entity.telegraphUntil = track.waitUntil; }
            if (now < track.waitUntil) break;
            track.started = false; track.index++; continue;
          }
          if (verb === "moveTo" || verb === "dash") {
            if (!track.started) {
              track.started = true;
              entity.moveTarget = { point: resolvePoint(instance, args.target, entity), speed: (args.speed || (verb === "dash" ? 7 : 3)) * tile };
              if (verb === "dash") entity.dashUntil = now + (args.duration || .5) * 1000;
            }
            const arrived = !entity.moveTarget || Math.hypot(entity.moveTarget.point.x - entity.x, entity.moveTarget.point.y - entity.y) < 8;
            if (arrived || (verb === "dash" && now >= entity.dashUntil)) { entity.moveTarget = null; track.started = false; track.index++; continue; }
            break;
          }
          doAction(instance, entity, step, now); track.index++;
        }
      }
    }
    function evalTransitions(instance, entity, now) {
      if (!entity.brain) return;
      const state = entity.brain.states[entity.brain.cur];
      for (const transition of (state && state.transitions) || []) {
        if ((transition.when && evalExpr(instance, transition.when, entity)) || (transition.event && instance.signals.has(transition.event))) {
          runExit(instance, entity, now); enterState(instance, entity, transition.to); break;
        }
      }
    }

    function variableTarget(instance, entity, path) {
      if (!path) return null;
      const parts = String(path).split(".");
      let current = parts[0] === "root" ? instance.root : entity;
      for (let i = 1; i < parts.length - 1; i++) current = current[parts[i]] || (current[parts[i]] = {});
      return { object: current, key: parts[parts.length - 1] };
    }
    function patternAngles(pattern, base, count, spreadDegrees) {
      const total = Math.max(1, count | 0), spread = (spreadDegrees || 0) * Math.PI / 180, result = [];
      if (pattern === "ring") { for (let i = 0; i < total; i++) result.push(base + i / total * Math.PI * 2); return result; }
      if (pattern === "fan") { for (let i = 0; i < total; i++) result.push(base - spread / 2 + (total === 1 ? 0 : i / (total - 1) * spread)); return result; }
      if (pattern === "burst") { for (let i = 0; i < total; i++) result.push(base + (Math.random() - .5) * (spread || .3)); return result; }
      for (let i = 0; i < total; i++) result.push(base);
      return result;
    }
    function maySpawn(instance, now, depth) {
      instance.spawnTimes = instance.spawnTimes.filter(time => now - time < 1000);
      return living(instance).length < instance.limits.maxAlive && instance.spawnTimes.length < instance.limits.maxSpawnsPerSecond && depth <= instance.limits.maxSpawnDepth;
    }
    function spawnProjectile(instance, template, x, y, angle, speedOverride, now, depth) {
      if (!maySpawn(instance, now, depth)) return;
      instance.spawnTimes.push(now);
      const entity = makeEntity(instance, template, null, false, depth);
      entity.isProjectile = true; entity.x = x; entity.y = y;
      const speed = (speedOverride != null ? speedOverride : (entity.motion && entity.motion.speed != null ? entity.motion.speed : 5)) * tile;
      entity.vx = Math.cos(angle) * speed; entity.vy = Math.sin(angle) * speed;
      instance.entities.push(entity); runEvent(instance, entity, "spawn", now);
    }
    function fire(instance, entity, args, now) {
      let x = entity.x, y = entity.y, ref = args.ref, config = args;
      if (args.emitter) {
        const dot = args.emitter.indexOf("."), holderId = dot > 0 ? args.emitter.slice(0, dot) : entity.id;
        const name = dot > 0 ? args.emitter.slice(dot + 1) : args.emitter, holder = findEntity(instance, holderId);
        if (!holder) return;
        const emitter = (holder.emitters || {})[name] || {}, offset = vec(emitter.at);
        x = holder.x + offset[0]; y = holder.y + offset[1]; ref = ref || emitter.ref;
        config = Object.assign({ pattern: emitter.pattern }, args);
      }
      const template = resolveDef(instance, ref); if (!template) return;
      const base = Math.atan2(playerY() - y, playerX() - x);
      for (const angle of patternAngles(config.pattern || "aimed", base, config.count || 1, config.spread))
        spawnProjectile(instance, template, x, y, angle, config.speed, now, entity.depth + 1);
    }
    function doAction(instance, entity, step, now) {
      const verb = Object.keys(step)[0], args = step[verb] || {};
      switch (verb) {
        case "fire": fire(instance, entity, args, now); break;
        case "spawn": {
          const template = resolveDef(instance, args.ref); if (!template) break;
          const base = Math.atan2(playerY() - entity.y, playerX() - entity.x);
          for (const angle of patternAngles(args.pattern || "single", base, args.count || 1, args.spread || 40))
            spawnProjectile(instance, template, entity.x, entity.y, angle, args.speed, now, entity.depth + 1);
          break;
        }
        case "signal": instance.signals.add(typeof args === "string" ? args : args.name); break;
        case "setMotion": { const target = args.target && args.target !== "self" ? findEntity(instance, args.target) : entity; if (target) target.motion = Object.assign({}, args, { target: undefined }); break; }
        case "set": case "add": case "mul": {
          const target = variableTarget(instance, entity, args.target); if (!target) break;
          const current = +target.object[target.key] || 0, value = +args.value || 0;
          target.object[target.key] = verb === "set" ? value : verb === "add" ? current + value : current * value; break;
        }
        case "destroy": killEntity(instance, findEntity(instance, args.target) || entity, now); break;
        case "detach": { const target = findEntity(instance, args.target) || entity; target.parent = null; target.detached = true; break; }
        case "enable": case "disable": { const target = findEntity(instance, args.target) || entity; target.enabled = verb === "enable"; break; }
        case "telegraph": entity.telegraphUntil = now + (args.time || .4) * 1000; break;
      }
    }
    function runEvent(instance, entity, name, now) {
      instance.signals.add(name);
      for (const action of entity.on[name] || []) doAction(instance, entity, action, now);
    }
    function damageEntity(instance, entity, damage, now) {
      if (entity.hpMax == null || !entity.alive) return false;
      entity.hp -= damage; runEvent(instance, entity, "damage", now);
      if (entity.hpMax && entity.hp / entity.hpMax <= .5 && !entity.healthBelowSent) { entity.healthBelowSent = true; runEvent(instance, entity, "healthBelow", now); }
      if (entity.hp <= 0) killEntity(instance, entity, now);
      return true;
    }
    function killEntity(instance, entity, now) {
      if (!entity || !entity.alive) return;
      entity.alive = false; runEvent(instance, entity, "destroy", now);
      for (const child of entity.children) {
        const policy = (child.spec.link && child.spec.link.onParentDeath) || (entity.isRoot ? "destroy" : "ignore");
        if (policy === "destroy") killEntity(instance, child, now);
        else if (policy === "detach") { child.parent = null; child.detached = true; }
        else if (policy === "disable") child.enabled = false;
      }
      if (entity.parent) { runEvent(instance, entity.parent, "childDestroyed", now); runEvent(instance, entity.parent, "partDestroyed", now); }
      if (entity.isRoot && !instance.killed) {
        instance.killed = true;
        if (options.onRootKilled) options.onRootKilled(instance);
      }
    }

    function stepMotion(instance, entity, dt) {
      const motion = entity.motion || {}, speed = (motion.speed != null ? motion.speed : 3) * tile;
      let vx = entity.vx, vy = entity.vy, angle;
      if (motion.type === "static") { vx = 0; vy = 0; }
      else if (motion.type === "gravity") vy += 18 * tile * dt;
      else if (motion.type === "chase") { angle = Math.atan2(playerY() - entity.y, playerX() - entity.x); vx = Math.cos(angle) * speed; vy = Math.sin(angle) * speed; }
      else if (motion.type === "home") {
        const wanted = Math.atan2(playerY() - entity.y, playerX() - entity.x), current = Math.atan2(entity.vy, entity.vx) || wanted;
        const turn = (motion.turnRate || 120) * Math.PI / 180 * dt;
        let delta = ((wanted - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        delta = Math.max(-turn, Math.min(turn, delta)); angle = current + delta;
        vx = Math.cos(angle) * speed; vy = Math.sin(angle) * speed;
      } else if (motion.type === "hover") { vx = (playerX() - entity.x) * 1.5; vy = ((playerY() - 3 * tile) - entity.y) * 1.5; }
      else if (motion.type === "orbit") {
        entity.orbitAngle = (entity.orbitAngle || 0) + (motion.rate || 1.2) * dt;
        const radius = (motion.radius || 3) * tile;
        vx = (playerX() + Math.cos(entity.orbitAngle) * radius - entity.x) * 3;
        vy = (playerY() + Math.sin(entity.orbitAngle) * radius - entity.y) * 3;
      } else if (motion.type === "patrol") {
        entity.patrolOrigin = entity.patrolOrigin == null ? entity.x : entity.patrolOrigin; entity.patrolDir = entity.patrolDir || 1;
        if (entity.x > entity.patrolOrigin + (motion.range || 3) * tile) entity.patrolDir = -1;
        if (entity.x < entity.patrolOrigin - (motion.range || 3) * tile) entity.patrolDir = 1;
        vx = entity.patrolDir * speed; vy = 0;
      } else if (motion.type === "moveTo" || motion.type === "dash") {
        const point = resolvePoint(instance, motion.target || "player", entity), distance = Math.hypot(point.x - entity.x, point.y - entity.y) || 1;
        vx = (point.x - entity.x) / distance * speed; vy = (point.y - entity.y) / distance * speed;
      }
      const flying = ["home", "hover", "orbit", "moveTo", "dash"].includes(motion.type);
      entity.vx = vx; entity.vy = entity.gravityOn && !flying ? entity.vy + 18 * tile * dt : vy;
    }
    function integrate(entity, dt) {
      entity.x += entity.vx * dt; entity.y += entity.vy * dt;
      if (entity.isProjectile && isSolid(Math.floor(entity.x / tile), Math.floor(entity.y / tile))) {
        entity.alive = false;
        return;
      }
      if (entity.gravityOn) {
        const col = Math.floor(entity.x / tile), row = Math.floor((entity.y + entity.h / 2) / tile);
        if (isSolid(col, row)) { entity.y = row * tile - entity.h / 2 - .01; if (entity.vy > 0) entity.vy = 0; }
      }
      const world = bounds();
      if (entity.isProjectile && (entity.x < -tile || entity.x > world.width + tile || entity.y < -tile * 4 || entity.y > world.height + tile * 4)) entity.alive = false;
      if (!entity.isProjectile && entity.isRoot) {
        entity.x = Math.max(entity.w / 2, Math.min(world.width - entity.w / 2, entity.x));
        entity.y = Math.max(entity.h / 2, Math.min(world.height + tile * 2, entity.y));
      }
    }
    function stepEntity(instance, entity, dt, now) {
      entity.age += dt;
      if (entity.ttl && entity.age >= entity.ttl) { killEntity(instance, entity, now); return; }
      if (entity.parent && !entity.detached) { entity.x = entity.parent.x + entity.atOffset[0]; entity.y = entity.parent.y + entity.atOffset[1]; return; }
      if (entity.moveTarget) {
        const distance = Math.hypot(entity.moveTarget.point.x - entity.x, entity.moveTarget.point.y - entity.y) || 1;
        entity.vx = (entity.moveTarget.point.x - entity.x) / distance * entity.moveTarget.speed;
        entity.vy = (entity.moveTarget.point.y - entity.y) / distance * entity.moveTarget.speed;
      } else if (entity.motion) stepMotion(instance, entity, dt);
      else if (entity.gravityOn) entity.vy += 18 * tile * dt;
      integrate(entity, dt);
      if (entity.isRoot && !entity.brain && Object.keys(entity.emitters).length && now >= entity.autoFireAt) {
        entity.autoFireAt = now + 1500;
        for (const name of Object.keys(entity.emitters)) fire(instance, entity, { emitter: name }, now);
      }
    }
    function hit(entity, x, y, radius) { return Math.abs(x - entity.x) <= entity.w / 2 + radius && Math.abs(y - entity.y) <= entity.h / 2 + radius; }
    function collisions(instance, shots, now) {
      for (const shot of shots || []) {
        if (shot.dead) continue;
        for (const entity of instance.entities) {
          if (!entity.alive || !entity.enabled || (entity.isProjectile && entity.hpMax == null)) continue;
          if (hit(entity, shot.x, shot.y, 5)) {
            shot.dead = true;
            if (entity.hpMax != null) damageEntity(instance, entity, options.playerShotDamage || 15, now);
            break;
          }
        }
      }
      const p = player(); if (!p) return;
      for (const entity of instance.entities) {
        if (!entity.alive || !entity.enabled || !entity.contact) continue;
        if (Math.abs(playerX() - entity.x) <= entity.w / 2 + p.w / 2 && Math.abs(playerY() - entity.y) <= entity.h / 2 + p.h / 2) {
          if (options.damagePlayer) options.damagePlayer(+entity.contact.damage || 1, now);
          runEvent(instance, entity, "contact", now);
          if (entity.contact.destroySelf) killEntity(instance, entity, now);
        }
      }
    }
    function update(now, dt, shots) {
      const step = Math.min(.1, dt == null ? 1 / 60 : dt);
      for (const instance of instances) {
        if (instance.killed && !living(instance).length) continue;
        instance.elapsed += step;
        const root = instance.root;
        if (root && root.alive) advanceTracks(instance, root, now);
        for (const entity of instance.entities) if (entity.alive && entity.enabled) stepEntity(instance, entity, step, now);
        collisions(instance, shots, now);
        if (root && root.alive && root.brain) {
          const distance = distanceToPlayer(root);
          if (distance < NEAR_TILES && !root.brain.near) { runEvent(instance, root, "playerNear", now); root.brain.near = true; }
          else if (distance > FAR_TILES && root.brain.near) { runEvent(instance, root, "playerFar", now); root.brain.near = false; }
          evalTransitions(instance, root, now);
        }
        instance.entities = instance.entities.filter(entity => entity.alive || entity.isRoot);
        instance.signals.clear();
      }
    }

    function drawShape(ctx, shape, x, y, width, height) {
      ctx.beginPath();
      if (shape === "circle" || shape === "ellipse") ctx.ellipse(x, y, width / 2, height / 2, 0, 0, Math.PI * 2);
      else if (shape === "diamond") { ctx.moveTo(x, y - height / 2); ctx.lineTo(x + width / 2, y); ctx.lineTo(x, y + height / 2); ctx.lineTo(x - width / 2, y); ctx.closePath(); }
      else if (shape === "triangle") { ctx.moveTo(x, y - height / 2); ctx.lineTo(x + width / 2, y + height / 2); ctx.lineTo(x - width / 2, y + height / 2); ctx.closePath(); }
      else ctx.rect(x - width / 2, y - height / 2, width, height);
    }
    function draw(ctx, now) {
      for (const instance of instances) for (const entity of instance.entities) {
        if (!entity.alive || !entity.enabled) continue;
        drawShape(ctx, entity.shape, entity.x, entity.y, entity.w, entity.h);
        ctx.fillStyle = now < entity.telegraphUntil && Math.floor(now / 80) % 2 ? "#ffffff" : entity.tint;
        ctx.globalAlpha = entity.isProjectile ? 1 : .92; ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = "#0e1015"; ctx.lineWidth = entity.isRoot ? 2 : 1; ctx.stroke(); ctx.lineWidth = 1;
        if (entity.hpMax && !entity.isProjectile) {
          const width = Math.max(entity.w, 24);
          ctx.fillStyle = "#2a2f3a"; ctx.fillRect(entity.x - width / 2, entity.y - entity.h / 2 - 8, width, 4);
          ctx.fillStyle = instance.spec.kind === "boss" ? "#c792ea" : "#7bd88f";
          ctx.fillRect(entity.x - width / 2, entity.y - entity.h / 2 - 8, width * Math.max(0, entity.hp / entity.hpMax), 4);
        }
      }
    }

    function stats() {
      return {
        roots: instances.filter(instance => instance.root && instance.root.alive).length,
        bosses: instances.filter(instance => instance.spec.kind === "boss" && instance.root.alive).length,
        entities: instances.reduce((sum, instance) => sum + living(instance).length, 0),
      };
    }
    return { spawn, reset, update, draw, stats, instances };
  }

  function createWorkshop(options) {
    const canvas = options.canvas, ctx = canvas.getContext("2d"), tile = options.tile || DEFAULT_TILE;
    const cols = Math.floor(canvas.width / tile), rows = Math.floor(canvas.height / tile);
    const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) =>
      c === 0 || c === cols - 1 || r === rows - 1 ? "X" : " "));
    for (let c = 5; c <= 9 && c < cols; c++) grid[Math.min(8, rows - 2)][c] = "X";
    for (let c = 14; c <= 18 && c < cols; c++) grid[Math.min(8, rows - 2)][c] = "X";
    const solid = (c, r) => c < 0 || c >= cols ? true : r < 0 || r >= rows ? false : grid[r][c] === "X";
    let player = null, shots = [], keys = {}, mouse = { x: 0, y: 0 }, lastShot = 0;
    let running = false, frameId = 0, lastFrame = 0, deaths = 0, startedAt = 0;
    const host = create({
      tile, isSolid: solid, getBounds: () => ({ width: canvas.width, height: canvas.height }),
      getPlayer: () => player, playerShotDamage: 15,
      damagePlayer: (_, now) => {
        if (!player || now < player.invulnUntil) return;
        player.hp--; player.invulnUntil = now + 1000;
        if (player.hp <= 0) { deaths++; player.hp = 3; respawn(); player.invulnUntil = now + 1500; }
      },
    });
    function respawn() { player.x = 2 * tile + 6; player.y = canvas.height - tile - player.h; player.vx = player.vy = 0; player.grounded = true; }
    function stepPlayer() {
      player.vx = (keys.ArrowLeft || keys.KeyA ? -3.2 : 0) + (keys.ArrowRight || keys.KeyD ? 3.2 : 0);
      if ((keys.ArrowUp || keys.Space || keys.KeyW) && player.grounded) { player.vy = -9.6; player.grounded = false; }
      player.vy = Math.min(player.vy + .5, 12); player.x += player.vx;
      let top = Math.floor(player.y / tile), bottom = Math.floor((player.y + player.h - 1) / tile);
      if (player.vx > 0) { const c = Math.floor((player.x + player.w) / tile); for (let r = top; r <= bottom; r++) if (solid(c, r)) player.x = c * tile - player.w - .01; }
      else if (player.vx < 0) { const c = Math.floor(player.x / tile); for (let r = top; r <= bottom; r++) if (solid(c, r)) player.x = (c + 1) * tile + .01; }
      player.y += player.vy; player.grounded = false;
      const left = Math.floor(player.x / tile), right = Math.floor((player.x + player.w - 1) / tile);
      if (player.vy > 0) { const r = Math.floor((player.y + player.h) / tile); for (let c = left; c <= right; c++) if (solid(c, r)) { player.y = r * tile - player.h - .01; player.vy = 0; player.grounded = true; } }
      else if (player.vy < 0) { const r = Math.floor(player.y / tile); for (let c = left; c <= right; c++) if (solid(c, r)) { player.y = (r + 1) * tile + .01; player.vy = 0; } }
      if (player.y > canvas.height + 80) respawn();
    }
    function render(now) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (grid[r][c] === "X") {
        ctx.fillStyle = "#4a5568"; ctx.fillRect(c * tile, r * tile, tile, tile);
        ctx.fillStyle = "#5d6b80"; ctx.fillRect(c * tile, r * tile, tile, 3);
      }
      host.draw(ctx, now);
      for (const shot of shots) { ctx.fillStyle = "#ffd166"; ctx.beginPath(); ctx.arc(shot.x, shot.y, 4, 0, Math.PI * 2); ctx.fill(); }
      if (!(now < player.invulnUntil && Math.floor(now / 100) % 2)) {
        ctx.fillStyle = "#6fc3ff"; ctx.fillRect(player.x, player.y, player.w, player.h);
        ctx.fillStyle = "#0e1015"; ctx.fillRect(player.x + 12, player.y + 6, 4, 4);
      }
      for (let i = 0; i < player.hp; i++) { ctx.fillStyle = "#f07178"; ctx.fillRect(6 + i * 12, 6, 9, 9); }
    }
    function frame(now) {
      if (!running) return;
      frameId = requestAnimationFrame(frame);
      const dt = Math.min(.1, (now - lastFrame) / 1000 || 1 / 60); lastFrame = now;
      stepPlayer();
      for (const shot of shots) {
        shot.vy += .35; shot.x += shot.vx; shot.y += shot.vy;
        if (solid(Math.floor(shot.x / tile), Math.floor(shot.y / tile))) shot.dead = true;
      }
      host.update(now, dt, shots); shots = shots.filter(shot => !shot.dead && shot.y < canvas.height + 60);
      render(now);
      const stats = host.stats(), root = host.instances[0] && host.instances[0].root;
      if (options.onHud) options.onHud(`t ${((now - startedAt) / 1000).toFixed(1)}s · deaths ${deaths} · entities ${stats.entities}` + (root && root.alive ? ` · ${root.id} ${root.hp == null ? "∞" : root.hp + "/" + root.hpMax}hp` : ""));
      if (!stats.roots) { running = false; if (options.onDefeated) options.onDefeated(); }
    }
    function start(spec) {
      if (!isEntitySpec(spec)) return;
      stop(false); host.reset(); shots = []; deaths = 0;
      player = { x: 0, y: 0, w: 20, h: 28, vx: 0, vy: 0, grounded: true, hp: 3, invulnUntil: 0 };
      respawn();
      const size = nodeSize(spec.root), rootH = Math.max(6, (+size[1] || 1) * tile);
      host.spawn(spec, canvas.width * .62, spec.root.body && spec.root.body.gravity ? canvas.height - tile - rootH / 2 : canvas.height * .32);
      running = true; lastFrame = performance.now(); startedAt = lastFrame;
      if (options.onStart) options.onStart();
      canvas.focus(); frameId = requestAnimationFrame(frame);
    }
    function stop(notify = true) {
      running = false; cancelAnimationFrame(frameId); keys = {};
      if (notify && options.onStop) options.onStop();
    }
    canvas.addEventListener("keydown", event => {
      keys[event.code] = true;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "KeyR"].includes(event.code)) event.preventDefault();
      if (event.code === "KeyR" && running && options.getSpec) start(options.getSpec());
    });
    global.addEventListener("keyup", event => { keys[event.code] = false; });
    canvas.addEventListener("blur", () => { keys = {}; });
    canvas.addEventListener("click", () => canvas.focus());
    canvas.addEventListener("mousemove", event => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = (event.clientX - rect.left) * canvas.width / rect.width;
      mouse.y = (event.clientY - rect.top) * canvas.height / rect.height;
    });
    canvas.addEventListener("mousedown", event => {
      if (event.button !== 0 || !running) return;
      const now = performance.now(); if (now - lastShot < 320) return; lastShot = now;
      const x = player.x + player.w / 2, y = player.y + player.h / 2;
      const dx = mouse.x - x, dy = mouse.y - y, distance = Math.hypot(dx, dy) || 1;
      shots.push({ x, y, vx: dx / distance * 10, vy: dy / distance * 10 - 1.5, dead: false });
    });
    return { start, stop, host };
  }

  global.EntityRuntime = { create, createWorkshop, isEntitySpec };
})(typeof window !== "undefined" ? window : globalThis);
