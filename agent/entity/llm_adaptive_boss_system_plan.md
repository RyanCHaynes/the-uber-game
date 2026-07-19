# LLM-Driven Adaptive Boss System

## Project Overview

This project is a simple 2D side-view action game built for a game jam. Each encounter takes place in a fixed arena containing ground and optional platforms. The player can move, jump, and fire projectiles.

The game follows a boss-rush structure:

1. The player fights a boss.
2. The round ends when either the player or boss dies.
3. The player gives feedback on the encounter.
4. Gameplay telemetry and player feedback are sent to an LLM.
5. The LLM modifies the boss to make the next encounter more fun.
6. The updated boss is loaded at runtime without recompiling or restarting the game.

The LLM may make the boss easier, harder, more complex, simpler, or mechanically different depending on the player's feedback and performance.

The central design challenge is to create a boss-definition system that provides:

- High creative flexibility
- Granular control over boss behavior
- Reliable first-pass generation
- Low token usage
- Safe runtime loading
- Support for nested and independently destructible entities
- Easy incremental modification

---

# 1. Recommended Authoring Format

## Use Sparse, Schema-Constrained JSON

JSON is the recommended interchange format.

XML would be substantially more verbose. YAML is visually lighter, but indentation errors, implicit typing, and parser inconsistencies make it less dependable for machine-generated content. A custom text format could be smaller, but it would require:

- A custom parser
- More documentation in the LLM prompt
- More examples
- Additional debugging
- More opportunities for malformed output

The token savings from replacing JSON punctuation would probably be smaller than the savings gained through a good patch system.

The recommended approach is:

1. Use sparse JSON for complete boss definitions.
2. Use compact patch operations for ordinary post-round changes.
3. Limit the model to a closed vocabulary of reliable primitives.
4. Allow those primitives to be combined freely.

The governing principle is:

> The LLM has a closed vocabulary of verbs, but nearly unlimited freedom to compose them.

The LLM should be able to create complex combinations, but it should not be able to invent unsupported behaviors or arbitrary engine code.

---

# 2. Two Related Data Formats

## 2.1 BossSpec

`BossSpec` defines a complete boss.

It contains:

- Metadata
- Entity definitions
- The root boss entity
- Nested child entities
- Projectile and summon templates
- States
- Behavior tracks
- Events
- Transitions
- Safety limits

A complete `BossSpec` is primarily used when:

- Creating a new boss
- Replacing the existing boss
- Saving a stable version
- Recovering from an invalid patch
- Performing major structural changes

## 2.2 BossPatch

`BossPatch` is used for incremental changes after most rounds.

Instead of regenerating the entire boss, the LLM returns a small list of operations.

```json
{
  "note": "Missiles were too difficult to avoid, but the player enjoyed destroying them.",
  "ops": [
    ["mul", "seeker.motion.speed", 0.85],
    ["set", "missileBurst.fire.count", 2],
    ["set", "missileWarning.telegraph.time", 0.75],
    ["add", "seeker.health.max", 1]
  ]
}
```

This approach provides much larger token savings than replacing JSON with another serialization format.

Every editable object should have a stable ID, including:

- Boss parts
- States
- Behavior tracks
- Attacks
- Telegraphs
- Emitters
- Projectiles
- Summons
- Transitions

Patches should target stable IDs rather than array indices.

Avoid:

```text
states[2].tracks[1].steps[4]
```

Prefer:

```text
phase2.missileTrack.missileBurst
```

Stable IDs make patches easier to generate, validate, debug, and preserve across revisions.

---

# 3. Everything Is an Entity

Boss bodies, arms, weapons, shields, missiles, mines, summoned enemies, environmental hazards, and debris should all use the same fundamental entity format.

An entity can contain any appropriate combination of the following components:

| Component | Purpose |
|---|---|
| `visual` | Sprite, primitive shape, animation, scale, tint, and rotation |
| `body` | Collision shape, gravity, mass, and collision layers |
| `health` | HP, armor, shielding, and vulnerabilities |
| `motion` | Continuous movement controller |
| `contact` | Touch damage, knockback, and self-destruction |
| `emitters` | Locations from which entities or projectiles spawn |
| `brain` | States, behavior tracks, and transitions |
| `children` | Attached nested entities |
| `on` | Event-triggered reactions |
| `vars` | Local state such as charge, rage, or attack count |
| `life` | Lifetime, expiration, and cleanup rules |
| `link` | Relationship to a parent or another entity |

A projectile should not require a unique hard-coded class. It is simply an entity with some combination of:

- A visual
- A collision body
- Motion
- Contact damage
- Health
- A lifetime
- Events
- Optional child entities
- Optional emitters
- Optional states

For example, a destructible homing missile may have:

- Two health
- Homing movement
- Contact damage
- An eight-second lifetime
- A death event that spawns fragments
- A signal informing the boss that the player destroyed it

Because projectiles are normal entities, they can themselves:

- Fire projectiles
- Change states
- Transform
- Spawn creatures
- Carry destructible components
- Attach to other entities
- React to player behavior

---

# 4. Entity Relationships

Each child entity should explicitly define its relationship to its parent.

```json
{
  "link": {
    "parent": "core",
    "socket": "leftArm",
    "followPosition": true,
    "followRotation": true,
    "onParentDeath": "destroy",
    "onOwnDeath": "detach"
  }
}
```

Useful lifecycle policies include:

- `destroy`: Remove the linked entity.
- `detach`: Preserve it as an independent entity.
- `disable`: Leave it visible but inactive.
- `ignore`: Apply no automatic effect.
- `transfer`: Attach it to another specified entity.
- `transform`: Replace it with another entity definition.

Damage relationships should also be explicit.

Possible damage models include:

- Independent health
- Shared health
- Partial damage transfer to parent
- Parent invulnerability while children exist
- Child invulnerability while another component exists
- Damage amplification when a related part is destroyed
- Damage reduction based on the number of surviving components

This allows encounters involving:

- Shield generators protecting a core
- Arms whose destruction removes attacks
- Armor plates that detach and become hazards
- Multiple heads with independent attacks
- Weak points that expose themselves only under certain conditions

---

# 5. Boss Logic

## 5.1 States with Parallel Behavior Tracks

A finite-state machine is a good foundation, but each state should support multiple concurrent behavior tracks.

A boss may simultaneously:

- Patrol between aerial positions
- Fire missiles every two seconds
- Summon mines periodically
- Rotate its body toward the player
- Monitor the destruction of its wings

This is easier to express as independent tracks than as one enormous sequence.

```json
{
  "id": "phase1",
  "tracks": [
    {
      "id": "movement",
      "loop": true,
      "steps": [
        {
          "moveTo": {
            "target": "arena.randomAir",
            "speed": 3
          }
        },
        {
          "wait": {
            "range": [0.3, 0.7]
          }
        }
      ]
    },
    {
      "id": "missileTrack",
      "loop": true,
      "steps": [
        {
          "id": "missileWarning",
          "telegraph": {
            "part": "leftWing",
            "time": 0.5,
            "style": "flash"
          }
        },
        {
          "id": "missileBurst",
          "fire": {
            "emitter": "leftWing.missiles",
            "count": 3,
            "spread": 18
          }
        },
        {
          "wait": 1.6
        }
      ]
    }
  ],
  "transitions": [
    {
      "when": "self.hpPct <= 0.5",
      "to": "phase2"
    },
    {
      "event": "bothWingsDestroyed",
      "to": "grounded"
    }
  ]
}
```

## 5.2 Named Arguments for Boss Definitions

Full boss definitions should use named arguments.

Prefer:

```json
{
  "fire": {
    "emitter": "leftWing.missiles",
    "count": 3,
    "spread": 18
  }
}
```

Avoid positional forms such as:

```json
["fire", "leftWing.missiles", 3, 18]
```

Named arguments are easier for the LLM to:

- Generate correctly
- Understand
- Edit
- Repair
- Validate

Compact arrays remain appropriate for patch operations because patch commands are short and standardized.

---

# 6. Primitive Behavior Vocabulary

The system does not need hundreds of behaviors. A relatively small set of orthogonal primitives can create a large design space.

## 6.1 Motion Controllers

Recommended continuous movement modes:

- `static`
- `velocity`
- `gravity`
- `patrol`
- `moveTo`
- `chase`
- `flee`
- `orbit`
- `home`
- `dash`
- `jump`
- `hover`
- `sine`
- `spline`
- `keepDistance`
- `avoid`
- `followParent`
- `followTarget`
- `mirrorPlayer`
- `strafe`
- `bounce`
- `fall`
- `rise`

Motion controllers should be replaceable during an encounter.

For example, a missile could:

1. Launch using `velocity`.
2. Wait for one second.
3. Switch to `home`.
4. Change to `orbit` if it misses the player.
5. Detonate after completing one orbit.

## 6.2 Discrete Actions

Recommended actions:

- `wait`
- `moveTo`
- `setMotion`
- `stop`
- `jump`
- `dash`
- `teleport`
- `face`
- `aim`
- `fire`
- `spawn`
- `destroy`
- `detach`
- `attach`
- `transform`
- `set`
- `add`
- `mul`
- `signal`
- `playAnimation`
- `telegraph`
- `applyStatus`
- `enable`
- `disable`
- `cameraShake`
- `setInvulnerable`
- `setCollision`
- `heal`
- `knockback`

## 6.3 Control Flow

Recommended control-flow features:

- Sequential steps
- Parallel tracks
- Infinite loops
- Fixed-count repetition
- Conditional branches
- Weighted random choices
- Random numeric ranges
- State transitions
- Interrupts
- Cooldowns
- Event listeners
- Timed state exits

## 6.4 Attack Patterns

Emitters should combine an entity reference with a firing pattern.

Recommended patterns:

- Single
- Burst
- Fan
- Ring
- Arc
- Spiral
- Sweep
- Alternating
- Random cone
- Aimed
- Predictive
- Ground-targeted
- Along a line
- From every matching component
- Mirrored
- Staggered
- Expanding ring
- Contracting ring

The emitter pattern should determine:

- Initial position
- Initial angle
- Initial timing
- Initial speed overrides

The spawned entity should determine its own behavior after spawning.

The same homing missile could therefore be fired as:

- A fan
- A ring
- A staggered sequence
- An alternating left-right volley
- A delayed burst

This avoids defining separate projectile types for every attack pattern.

---

# 7. Events and Signals

Events allow modular boss parts to communicate.

Recommended standard events:

- `spawn`
- `destroy`
- `damage`
- `healthBelow`
- `shieldBroken`
- `contact`
- `projectileDestroyed`
- `childDestroyed`
- `partDestroyed`
- `playerNear`
- `playerFar`
- `playerAbove`
- `playerBelow`
- `playerBehind`
- `playerHit`
- `playerMissed`
- `landed`
- `timer`
- `signal`
- `stateEnter`
- `stateExit`

Example:

```json
{
  "on": {
    "destroy": [
      {
        "signal": "leftWingDestroyed"
      },
      {
        "add": {
          "target": "root.vars.rage",
          "value": 1
        }
      },
      {
        "spawn": {
          "ref": "wingDebris",
          "count": 5,
          "pattern": "burst"
        }
      }
    ]
  }
}
```

Signals allow unrelated parts to communicate without tightly coupling their definitions.

Examples:

- A wing emits `wingDestroyed`.
- A missile emits `missileShotDown`.
- A shield node emits `shieldNodeLost`.
- A summoned creature emits `summonDefeated`.
- The boss brain reacts by changing state, becoming stunned, or enabling another attack.

---

# 8. Expression Language

The schema should include a small, deliberately limited expression language.

Example expressions:

```text
self.hpPct <= 0.5
alive("leftWing")
root.vars.rage >= 2
distance(self, player) < 4
countAlive("tag:shieldNode") == 0
player.isGrounded
player.velocity.x > 2
arena.time > 30
```

Recommended support:

- Basic arithmetic
- Comparisons
- Boolean operators
- Entity properties
- Boss variables
- Player properties
- Arena properties
- A small whitelist of functions

Possible built-in functions:

- `alive(id)`
- `exists(id)`
- `distance(a, b)`
- `countAlive(selector)`
- `hasTag(entity, tag)`
- `randomChance(value)`
- `cooldownReady(id)`
- `playerRecentDamage(seconds)`
- `playerHitRate(seconds)`
- `arenaEntityCount(selector)`

Do not permit:

- Arbitrary scripting
- Reflection
- Dynamic method calls
- File access
- Engine API access
- General-purpose code execution

Expressions should be parsed and validated before runtime.

A malformed expression should reject the patch rather than silently producing unexpected behavior.

---

# 9. Illustrative BossSpec

The following example demonstrates the proposed structure. It is illustrative rather than a finalized schema.

```json
{
  "v": 1,
  "id": "iron_moth",
  "name": "The Iron Moth",

  "limits": {
    "maxAlive": 80,
    "maxSpawnsPerSecond": 20,
    "maxSpawnDepth": 4
  },

  "vars": {
    "rage": 0
  },

  "defs": {
    "shard": {
      "tags": ["enemy", "projectile"],
      "visual": {
        "shape": "diamond",
        "size": [0.12, 0.12]
      },
      "body": {
        "shape": "circle",
        "radius": 0.08,
        "gravity": 0
      },
      "life": {
        "ttl": 1.2
      },
      "contact": {
        "damage": 1,
        "destroySelf": true
      }
    },

    "seeker": {
      "tags": ["enemy", "projectile", "shootable"],
      "visual": {
        "shape": "circle",
        "size": [0.4, 0.4]
      },
      "body": {
        "shape": "circle",
        "radius": 0.2,
        "gravity": 0
      },
      "health": {
        "max": 2
      },
      "life": {
        "ttl": 8
      },
      "motion": {
        "type": "home",
        "target": "player",
        "speed": 2.4,
        "turnRate": 140
      },
      "contact": {
        "damage": 1,
        "destroySelf": true
      },
      "on": {
        "destroy": [
          {
            "spawn": {
              "ref": "shard",
              "count": 6,
              "pattern": "ring",
              "speed": 3
            }
          },
          {
            "signal": "missileDestroyed"
          }
        ]
      }
    }
  },

  "root": {
    "id": "core",
    "tags": ["boss"],
    "visual": {
      "shape": "ellipse",
      "size": [2.8, 1.4]
    },
    "body": {
      "shape": "box",
      "size": [2.4, 1.1],
      "gravity": 0
    },
    "health": {
      "max": 100
    },

    "children": [
      {
        "id": "leftWing",
        "tags": ["bossPart", "wing"],
        "at": [-1.7, 0],
        "visual": {
          "shape": "diamond",
          "size": [1.8, 0.8]
        },
        "health": {
          "max": 20
        },
        "emitters": {
          "missiles": {
            "at": [-0.5, 0],
            "ref": "seeker"
          }
        },
        "on": {
          "destroy": [
            {
              "signal": "wingDestroyed"
            }
          ]
        }
      },

      {
        "id": "rightWing",
        "tags": ["bossPart", "wing"],
        "at": [1.7, 0],
        "visual": {
          "shape": "diamond",
          "size": [1.8, 0.8]
        },
        "health": {
          "max": 20
        },
        "emitters": {
          "missiles": {
            "at": [0.5, 0],
            "ref": "seeker"
          }
        },
        "on": {
          "destroy": [
            {
              "signal": "wingDestroyed"
            }
          ]
        }
      }
    ]
  },

  "brain": {
    "start": "phase1",

    "states": {
      "phase1": {
        "tracks": [
          {
            "id": "airMovement",
            "loop": true,
            "steps": [
              {
                "moveTo": {
                  "target": "arena.randomAir",
                  "speed": 3
                }
              },
              {
                "wait": {
                  "range": [0.3, 0.7]
                }
              }
            ]
          },

          {
            "id": "leftMissileTrack",
            "loop": true,
            "steps": [
              {
                "id": "leftMissileWarning",
                "telegraph": {
                  "part": "leftWing",
                  "time": 0.5,
                  "style": "flash"
                }
              },
              {
                "id": "leftMissileBurst",
                "if": {
                  "when": "alive('leftWing')",
                  "then": [
                    {
                      "fire": {
                        "emitter": "leftWing.missiles",
                        "count": 2,
                        "spread": 15
                      }
                    }
                  ]
                }
              },
              {
                "wait": 1.5
              }
            ]
          }
        ],

        "transitions": [
          {
            "when": "self.hpPct <= 0.5",
            "to": "phase2"
          },
          {
            "when": "countAlive('tag:wing') == 0",
            "to": "grounded"
          }
        ]
      },

      "phase2": {
        "enter": [
          {
            "set": {
              "target": "root.vars.rage",
              "value": 2
            }
          }
        ],

        "tracks": [
          {
            "id": "rageMovement",
            "loop": true,
            "steps": [
              {
                "dash": {
                  "target": "player",
                  "speed": 7,
                  "duration": 0.6
                }
              },
              {
                "wait": 0.7
              }
            ]
          }
        ]
      },

      "grounded": {
        "enter": [
          {
            "setMotion": {
              "target": "root",
              "type": "gravity"
            }
          }
        ],

        "tracks": [
          {
            "id": "groundAttack",
            "loop": true,
            "steps": [
              {
                "telegraph": {
                  "part": "core",
                  "time": 0.8,
                  "style": "pulse"
                }
              },
              {
                "spawn": {
                  "ref": "seeker",
                  "count": 5,
                  "pattern": "fan",
                  "spread": 90
                }
              },
              {
                "wait": 2
              }
            ]
          }
        ]
      }
    }
  }
}
```

The source representation should remain sparse. The engine should normalize it by filling in defaults before gameplay.

Possible defaults include:

- Zero rotation
- Standard collision layers
- Default sprite scale
- Default parent-death behavior
- Standard damage faction
- Empty event tables
- Default lifetime behavior
- Standard render ordering

The runtime should consume the normalized representation rather than the sparse LLM output.

---

# 10. Validation and Runtime Safety

The LLM should not be solely responsible for correctness. Its output should be treated like source code that must compile.

## 10.1 Schema Validation

Check:

- Required fields
- Property types
- Allowed properties
- Enum values
- Numeric ranges
- Unique IDs
- Maximum nesting depth

## 10.2 Reference Validation

Confirm that:

- Every entity reference exists
- Every emitter reference exists
- Every state transition points to a real state
- Every patch target points to a valid ID
- Every referenced asset exists
- No entity has conflicting parents
- Every socket reference exists
- Every signal listener uses a valid event format

## 10.3 Behavior Validation

Check for:

- Empty infinite loops
- Loops with no delay or blocking action
- States with no possible exit when one is required
- Unreachable states
- Attacks using unavailable emitters
- Invalid expression syntax
- Negative cooldowns
- Negative lifetimes
- Zero-duration repeated attacks
- Impossible health conditions
- Invalid transformation chains

## 10.4 Spawn Analysis

Prevent:

- An entity recursively spawning itself without a limit
- Recursive death effects
- Excessive spawn rates
- Excessive living-entity counts
- Excessive entity nesting
- Spawn chains that grow exponentially

Every boss should have global safety limits.

```json
{
  "limits": {
    "maxAlive": 80,
    "maxSpawnsPerSecond": 20,
    "maxSpawnDepth": 4
  }
}
```

The engine should enforce these limits even if the definition passes validation.

## 10.5 Dry-Run Instantiation

Before replacing the active boss:

1. Parse the new definition.
2. Normalize it.
3. Instantiate it in a hidden test arena.
4. Simulate several seconds with a dummy player.
5. Detect runtime errors.
6. Confirm that the boss can take damage and act.
7. Confirm that entity limits are respected.

## 10.6 Rollback

Always preserve the last known working boss.

If a new patch fails:

1. Reject it.
2. Keep the previous boss active.
3. Generate a validation-error summary.
4. Attempt a deterministic repair or request a corrected patch.
5. Never leave the game without a valid boss.

---

# 11. Adaptation Input

Do not send raw gameplay logs to the LLM. Convert gameplay into a compact round summary.

```json
{
  "result": "loss",
  "duration": 41.8,
  "bossHpPct": 0.17,
  "phaseReached": "phase2",
  "partsDestroyed": ["leftWing"],
  "player": {
    "shots": 72,
    "hitRate": 0.31,
    "damageTaken": 5
  },
  "damageTakenBy": {
    "seeker": 4,
    "contact": 1
  },
  "feedback": "The missiles were fun to shoot, but once there were four at once I could not find a safe opening."
}
```

Useful telemetry may include:

- Win or loss
- Round duration
- Boss health remaining
- Player health remaining
- Phase reached
- Parts destroyed
- Player accuracy
- Player damage output
- Damage sources
- Number of dodges
- Time spent airborne
- Time spent near or far from boss
- Number of projectiles destroyed
- Number of attacks encountered
- Number of unavoidable-looking damage sequences
- Longest period without a safe attack opportunity

The LLM should also receive a change budget.

```json
{
  "maxOps": 5,
  "maxNumericChange": 0.3,
  "structuralChangesAllowed": true,
  "preserveIdentity": true
}
```

The model should interpret feedback semantically.

For example, from:

> The missiles were fun to shoot, but once there were four at once I could not find a safe opening.

The LLM might infer:

- Preserve destructible missiles.
- Reduce simultaneous missile count.
- Increase warning time.
- Preserve the tactical choice of shooting them.
- Potentially increase individual missile durability slightly.

This is preferable to applying a generic global difficulty reduction.

---

# 12. Preventing Adaptation Oscillation

The system should retain a small history of recent modifications.

```json
{
  "recentChanges": [
    "Round 3: seeker speed reduced from 3.0 to 2.4",
    "Round 4: burst count increased from 2 to 4",
    "Round 5: player reported screen overcrowding"
  ]
}
```

This helps prevent cycles such as:

1. Attack is too hard.
2. Attack is weakened.
3. Player wins easily.
4. Attack is restored to its original strength.
5. Player reports it is too hard again.

The model should distinguish between:

- One-round anomalies
- Repeated feedback
- Skill improvement
- Mechanical frustration
- Desired difficulty
- Desired complexity
- Desired spectacle
- Perceived unfairness

A simple confidence system could categorize feedback as:

- `tentative`
- `supported`
- `strong`

Structural changes should generally require stronger evidence than small numeric changes.

---

# 13. Benchmark Bosses

Each benchmark boss should stress a different part of the schema.

## 13.1 The Iron Moth

A flying mechanical creature with two destructible wings.

Features:

- Each wing independently fires targetable homing missiles.
- Losing one wing makes movement lopsided.
- Losing both wings causes the boss to crash.
- The grounded phase uses different attacks.
- Destroyed missiles produce fragments.
- Shooting down missiles may briefly reduce the boss's shield.

Tests:

- Attachments
- Independent health
- Conditional emitters
- Targetable projectiles
- Event signals
- Phase changes
- Movement changes caused by component loss

## 13.2 The Ossuary Serpent

A skeletal serpent assembled from a head and multiple vertebrae.

Features:

- Every segment follows the segment ahead of it.
- Individual segments can be destroyed.
- Breaking the middle divides the serpent.
- Detached tail sections become autonomous crawling enemies.
- The head becomes faster as the body becomes shorter.
- Some segments may contain special weapons.

Tests:

- Deep entity nesting
- Follow relationships
- Detachment
- Runtime restructuring
- Child-death events
- Independent sub-entities

This is likely the most technically difficult benchmark.

## 13.3 The Garden of Bombs

A stationary plant-like boss that launches slow seeds.

Features:

- Seeds can be shot while airborne.
- Seeds that reach the ground begin growing.
- Seeds transform into turrets.
- Turrets produce flowers that fire spores.
- Destroying a flower may damage the root network.
- The boss can accelerate the growth of existing plants.

Tests:

- Projectile-to-entity transformation
- Timers
- Nested spawning
- Lifecycle stages
- Spawn-budget safeguards
- Delayed battlefield control

## 13.4 The Choir Engine

A central invulnerable core surrounded by three orbiting masks.

Features:

- One mask fires horizontal waves.
- One summons falling projectiles.
- One creates a rotating laser.
- Destroying a mask permanently removes its attack.
- Remaining masks orbit faster.
- Remaining masks inherit portions of destroyed-mask behaviors.
- The core becomes vulnerable after all masks are destroyed.

Tests:

- Concurrent brains
- Orbit motion
- Shield dependencies
- Conditional attacks
- Ability inheritance
- Difficulty tradeoffs

This is a strong fun-design benchmark because destroying a component makes the encounter simultaneously simpler and more intense.

## 13.5 The Cowardly Duelist

A small, highly mobile humanoid boss.

Features:

- Maintains a preferred range.
- Jumps between platforms.
- Dodges projectiles when its cooldown is ready.
- Fires predictive shots.
- Occasionally commits to a long, punishable attack.
- Changes tactics based on player aggression.
- May fake attacks or retreat after taking damage.

Tests:

- Player-state sensors
- Platform navigation
- Prediction
- Weighted decisions
- Readable openings
- Behavior that appears intelligent rather than purely patterned

## 13.6 The Hollow Moon

A giant circular boss occupying much of the arena.

Features:

- Craters are independent destructible weapons.
- Some craters create gravity fields.
- Some launch orbiting projectiles.
- Projectiles may orbit the boss or player.
- Destroying craters changes the boss's balance and rotation.
- The shell eventually breaks into independently moving pieces.

Tests:

- Unusual body composition
- Orbit systems
- Destructible nested weapons
- Transformed children
- Multiple coordinate frames
- Large-boss collision design

---

# 14. Recommended Game-Jam Scope

The complete concept can grow indefinitely. The first implementation should focus on the smallest set of systems that demonstrates the core idea.

## Implement First

1. Entity composition with children
2. Independent health for boss parts
3. Projectiles implemented as normal entities
4. Emitters with several firing patterns
5. States with parallel looping tracks
6. Conditions, events, and signals
7. Approximately ten motion controllers
8. Compact patch operations
9. Schema validation
10. Reference validation
11. Entity and spawn limits
12. Dry-run loading
13. Rollback to the last valid boss
14. Compact gameplay telemetry
15. Player feedback input

## Recommended Initial Motion Controllers

- `static`
- `velocity`
- `gravity`
- `moveTo`
- `patrol`
- `chase`
- `home`
- `orbit`
- `hover`
- `dash`

## Recommended Initial Attack Patterns

- `single`
- `burst`
- `fan`
- `ring`
- `aimed`

## Recommended Initial Actions

- `wait`
- `moveTo`
- `setMotion`
- `fire`
- `spawn`
- `telegraph`
- `set`
- `add`
- `mul`
- `signal`
- `destroy`
- `detach`
- `enable`
- `disable`

## Defer Until Later

- Arbitrary scripting
- Runtime creation of new primitive types
- Complex inheritance systems
- Full navigation meshes
- Deep physics constraints
- Sophisticated behavior trees
- LLM-generated engine code
- LLM-generated shaders
- Extremely deep nesting
- Fully dynamic arena modification

---

# 15. Recommended Initial Benchmark Set

The best initial benchmark trio is:

1. **The Iron Moth**
2. **The Garden of Bombs**
3. **The Choir Engine**

Together, these bosses test:

- Destructible parts
- Nested entities
- Targetable projectiles
- Spawning
- Entity transformation
- Phase changes
- Parallel attack tracks
- Shield dependencies
- Signals
- Adaptive difficulty

They avoid the hardest runtime restructuring problem introduced by the Ossuary Serpent while still demonstrating the flexibility of the schema.

---

# 16. Core Architecture Summary

The complete runtime pipeline should be:

```text
Player completes round
        ↓
Game summarizes telemetry
        ↓
Player feedback is added
        ↓
LLM receives current boss summary, telemetry, feedback, and change budget
        ↓
LLM returns BossPatch
        ↓
Patch is applied to a copy of the current BossSpec
        ↓
Schema and references are validated
        ↓
Boss is normalized
        ↓
Boss is instantiated in a dry-run environment
        ↓
If valid: activate and save
If invalid: reject and retain previous boss
```

The system should maximize creativity through composition rather than unrestricted code generation.

The most important design decisions are:

- Keep JSON.
- Use sparse complete definitions.
- Use compact patches for normal iteration.
- Treat every gameplay object as an entity.
- Use stable IDs everywhere.
- Combine finite states with parallel behavior tracks.
- Provide a small but expressive primitive vocabulary.
- Validate and simulate all generated changes.
- Always preserve the last working boss.
