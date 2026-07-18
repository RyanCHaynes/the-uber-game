# Coin Rush gothic pixel-art specification v1

- **Status:** Normative for the vNext placeholder and generated-art pipeline
- **TD task:** `td-ac4b.5.1`
- **Architecture:** [ADR 0001](../architecture/0001-vnext-engine-and-designer-boundary.md)
- **Machine-readable profile:** [`gothic-pixel-v1.palette.json`](gothic-pixel-v1.palette.json)

## Intent

Coin Rush uses original 2D gothic-medieval pixel art with the dramatic silhouettes, limited palettes, castle atmosphere, and readable action associated with classic 16-bit side-scrolling action games. “Castlevania-inspired” describes mood and gameplay-era readability only. Assets must not reproduce protected characters, sprites, maps, logos, props, compositions, audio, or branding.

The rejected painterly brick-floor candidate is reference-only and must not be integrated. Model output is a source candidate, never a game-ready asset.

## Normative pixel grid

- One world tile is exactly **32×32 native pixels**.
- A standard enemy pose uses an exact **64×64 RGBA8 canvas** and visually occupies approximately one tile wide by one-and-a-half tiles tall.
- Enemy poses share a bottom-center baseline anchor at native coordinate **(32, 60)**. This is an inter-pixel rendering pivot on the boundary between rows 59 and 60, not an opaque foot pixel.
- Opaque foot pixels may extend through row **59**; rows **60–63** are always transparent. At least **2 transparent pixels** remain between opaque enemy pixels and the top, left, and right canvas edges. This exact bottom baseline and padding let every pose share one anchor without conflicting with transparent-edge validation.
- The default visible enemy height is **40–56 pixels**. Oversized bosses are outside the v1 generated pack and require a later, versioned art profile.
- The image-generation adapter requests one **1024×1024** square source image for each pose or tile candidate. If a provider returns another size, the adapter records the original dimensions and deterministically fits it to the canonical source canvas before raster normalization.
- The engine loads only the normalized 32×32 tile or 64×64 pose PNG. It never loads the model’s source image.
- Runtime display uses nearest-neighbor sampling. Integer display scales are preferred; filtering must not add blur or antialiasing.

These are presentation dimensions, not authoritative collision dimensions. Collision and hit boxes come from validated gameplay data.

## Palette and pixel treatment

The machine-readable profile defines one 32-entry sRGB master palette, including transparency.

- A pose may use at most **24 visible palette entries**.
- A tile may use at most **16 visible palette entries**.
- Pose alpha is binary: every pixel is either `0` or `255` alpha.
- Tiles are fully opaque.
- No smooth gradients, soft brushes, vector edges, antialiasing, subpixel detail, JPEG artifacts, or photoreal texture are allowed.
- Forms use intentional pixel clusters rather than isolated noise. A one-pixel dark outline or controlled shared-color edge separates important silhouettes from the background.
- Shading uses two to four discrete values per material. Ordered 2×2 dithering is permitted only when it remains legible at 1× scale; random speckle is prohibited.
- Single stray pixels are prohibited unless they are structurally connected to the silhouette. Particles, glows, shadows, and trails belong to runtime VFX, not pose PNGs.
- Color ramps should favor cold stone/navy shadows, burgundy and violet accents, muted metal/bone/skin, and sparse gold or cold-glow highlights.

Adding colors requires a new reviewed profile version. Individual generated enemies may select a subset but cannot expand the palette.

## Camera, perspective, and composition

### Enemy poses

- Strict orthographic side view; no perspective convergence, three-quarter camera, fisheye, camera tilt, or isometric view.
- The canonical enemy faces **right**. The renderer mirrors the normalized pose for left-facing movement.
- The body’s ground-contact baseline remains at shared pivot `(32, 60)` in all five poses; the lowest opaque sole pixel is on row 59.
- The silhouette must remain identifiable as the same creature in every pose when viewed at native 1× scale and as a solid black shape.
- Head, torso, primary weapon/limb, and ground-contact shape must remain consistent across the pack. Costume accents cannot jump sides between poses.
- Pose files contain one creature only, centered on transparent background, without scenery, floor, UI, border, frame, shadow, or caption.
- Weapons and limbs must fit inside the canvas and padding. Attack reach is authoritative data and must not be inferred from visible pixels.

### Tiles

- Strict front/side orthographic projection aligned to the 32-pixel grid.
- Surface lighting comes from the upper left, but it may not create a strong left-to-right brightness ramp that exposes repetition.
- Repeatable fill tiles must wrap on both axes without a directional seam. Features crossing an edge continue coherently on the opposite edge.
- Platform tops, undersides, corners, caps, and decorations use explicit tile roles. The runtime must not rotate a lit tile to fake another direction.
- A tile contains no baked character, coin, enemy, text, UI, camera vignette, or large unique landmark that becomes obvious when repeated.

## Lighting and material language

- One stable key light from upper left; restrained cool ambient fill.
- Value groups are clear at 1×: deep outline/shadow, local midtone, lit plane, and rare highlight.
- Highlights are short pixel clusters, never soft bloom baked into the PNG.
- Stone is blocky and worn; metal has narrow hard highlights; cloth and leather have broader stepped shading; bone has pale warm mids against cool shadows.
- Runtime VFX may add flashes, particles, color overlays, trails, and camera response. Those effects do not change the normalized source palette or authoritative simulation.

## Required key poses

Every generated enemy pack contains exactly these five semantic poses:

| Pose | Required read | Stable constraints |
| --- | --- | --- |
| `idle` | Alert neutral stance and clearest identity silhouette | Soles end on row 59 above the baseline anchor; weapon/limb in resting location |
| `move` | Strong contact or passing pose indicating rightward travel | Same scale and body proportions; no implied extra limb |
| `attack` | Unambiguous anticipation or contact silhouette for the primary attack | Direction is right; visible action supports but does not define hit timing |
| `hit` | Readable recoil away from an incoming hit | Identity, equipment, and anchor remain coherent |
| `death` | Collapsed or dissolving terminal silhouette | Fits canvas; no detached particles or baked floor |

Motion comes from deterministic runtime timing, tweening, recoil, squash/stretch, flashes, particles, and trails. Full generated sprite sheets and generated in-between frames are not part of this profile.

## Naming and output contract

The pose manifest schema is defined later by `td-ac4b.3.5`; this specification reserves the following normalized filenames:

```text
<enemy-id>/idle.png
<enemy-id>/move.png
<enemy-id>/attack.png
<enemy-id>/hit.png
<enemy-id>/death.png
```

`<enemy-id>` is a lower-case ASCII slug supplied by validated content data. Paths may not contain whitespace, `..`, separators inside the ID, URL syntax, control characters, or Unicode confusables.

Normalized PNGs contain no executable metadata, animation chunks, external references, text chunks, ICC profiles, or unknown ancillary chunks. Exact digest, byte-budget, manifest, and immutable packaging rules are defined by later TD tasks.

## Prohibited content and defects

Reject any source or normalized candidate containing:

- copied or recognizably traced protected game characters, sprites, logos, maps, UI, or branding;
- text, signatures, captions, labels, speech bubbles, logos, or watermarks;
- photoreal, painterly, airbrushed, smooth-vector, 3D-rendered, or soft-antialiased final treatment;
- perspective, isometric, three-quarter, top-down, or front-facing enemy views;
- backgrounds, scenery, floors, drop shadows, borders, card frames, or multiple creatures in a pose file;
- inconsistent facing, scale, palette, light direction, anatomy, costume, weapon, anchor, or padding across poses;
- extra or missing limbs caused by generation artifacts;
- cropped silhouettes, opaque edge pixels, disconnected debris, random noise, or color fringing;
- directional seams, edge-darkening, baked vignettes, or obvious unique landmarks in repeatable tiles;
- sexual content, graphic gore, hate symbols, or modern real-world brand marks;
- any file that fails normalization, validation, provenance, digest, or safety checks.

## Generation prompt contract

Prompts describe an **original gothic-medieval 16-bit-era pixel-art enemy or tile** and repeat the native-pixel requirements. Prompts must name the subject, materials, silhouette, canonical right-facing side view when applicable, five-pose semantic target, upper-left light, transparent or tile background requirement, and prohibited defects.

Prompts must not ask a model to copy a named artist, protected sprite, character, map, or exact franchise composition. “Castlevania-inspired” is translated into generic attributes—gothic castle, dramatic readable silhouette, restrained 16-bit palette, and side-view action presentation—rather than used as a copying instruction.

One request produces one pose or one tile source. A model is never asked to generate an entire sprite sheet between levels.

## Machine-checkable acceptance surface

Later validators must be able to enforce at least:

- PNG signature, RGBA8 format, exact normalized dimensions, and allowed chunk set;
- binary pose alpha and fully opaque tile alpha;
- membership in the versioned master palette;
- per-pose and per-tile palette-entry limits;
- transparent pose edge and minimum-padding rules;
- required five filenames with no extras, duplicates, unsafe paths, or case drift;
- identical canvas, anchor metadata, facing, profile version, and palette version across a pose pack;
- bounded file bytes and decompressed pixels from the runtime-budget contract;
- digest and provenance presence from the immutable pose-pack contract;
- opposite-edge wrap analysis for repeatable tiles;
- rejection codes rather than silent repair for malformed normalized output.

Human review remains required for originality, silhouette readability, anatomy, pose identity, palette coherence, lighting coherence, and whether a technically valid asset still looks painterly or off-style.

## Visual acceptance checklist

A pack passes art review only when all answers are yes:

1. Does every asset read as intentional pixel art at native 1× scale?
2. Is the creature immediately recognizable as the same original design in all five poses?
3. Are facing, anchor, proportions, equipment, palette, and light direction stable?
4. Are the five pose meanings readable without relying on text or animation?
5. Are tiles seamless and non-directional when repeated in an 8×8 preview?
6. Is the result original rather than copied or recognizably traced?
7. Are there no text, logos, watermarks, perspective errors, soft edges, stray pixels, or generator artifacts?
8. Does the normalized output pass every machine check without heuristic repair?

Failure preserves the prior approved placeholder or last-known-good pose pack byte-for-byte.
