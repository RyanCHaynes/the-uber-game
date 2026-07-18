# Level and tileset authoring

Coin Rush loads `assets/levels/castle.csv` as a single Tiled-compatible CSV tile layer. The authoritative server uses the same file for collision, spawn points, and coin locations; clients use it for rendering.

## Grid and tile IDs

The grid uses square **32×32 pixel tiles**. CSV values are the same one-based global tile IDs that Tiled exports when the tileset is the map's first tileset.

| ID | Meaning | Solid | Rendered |
|---:|---|:---:|:---:|
| 0 | Empty | No | No |
| 1 | Stone | Yes | Yes |
| 2 | Brick | Yes | Yes |
| 3 | Platform | Yes | Yes |
| 4 | Window/background decoration | No | Yes |
| 5 | Player 1 spawn marker | No | No |
| 6 | Player 2 spawn marker | No | No |
| 7 | Coin spawn marker | No | No |

Every level must contain one ID `5`, one ID `6`, and at least one ID `7`. All CSV rows must have the same number of columns.

## Editing with Tiled

1. Create a map using **CSV** layer data and 32×32 tiles.
2. Add the tileset as the first tileset so its first global ID is 1.
3. Build one tile layer with the IDs above.
4. Export that layer as CSV and replace `assets/levels/castle.csv`.
5. Run `./build/CoinRush --level-test` before hosting.

The loader accepts plain CSV exported by Tiled, not a `.tmx` or `.tmj` container.

## Custom PNG tileset

Place a PNG atlas at `assets/tileset.png`. Tiles are read left-to-right, top-to-bottom in a regular 32×32 grid:

```text
tile 1: stone
tile 2: brick
tile 3: platform
tile 4: window/background decoration
```

Marker IDs 5–7 do not need artwork because they are hidden at runtime. If `tileset.png` is absent, the renderer uses the bundled procedural gothic palette, so level editing and gameplay still work without custom art.
