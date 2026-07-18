# Coin Rush

Coin Rush is a deliberately small two-player network platform game for a game jam. One player hosts a lobby, the other joins by IP address, both ready up, and the first player to collect five gold coins in the gothic castle wins.

The server owns platforming physics, tile collision, coin positions, scoring, and match state. The host button starts that server inside the host's game process. A headless server mode is included for a VPS or spare machine.

## Build

You need CMake 3.20+ and a C++17 compiler. If SFML 2.5/2.6 is not already installed, CMake downloads the pinned SFML 2.6.2 source into the build directory.

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
```

Run it:

```sh
./build/CoinRush
```

On macOS, `run-game.command` is also available as a Terminal/Finder launcher.

On multi-config generators such as Visual Studio, the executable is usually under `build/Release/`.

To require a system-installed SFML instead of downloading it:

```sh
cmake -S . -B build -DCOINRUSH_FETCH_SFML=OFF
```

## Play locally first

1. Start two copies of `CoinRush`.
2. In the first copy, enter a name and click **Host Lobby**.
3. In the second, use `127.0.0.1`, the same port, and click **Join Lobby**.
4. Both players click **Ready Up**. Move with A/D or Left/Right and jump with W or Up.

The default port is **53000/TCP**. The lobby supports exactly two players.

Run the automated host/join/lobby test with:

```sh
ctest --test-dir build --output-on-failure
# or: ./build/CoinRush --smoke-test
# level validation only: ./build/CoinRush --level-test
```

## Build tile-based levels

The authoritative server and every client load `assets/levels/castle.csv`. It is a 32×32 Tiled-compatible CSV layer with solid tiles, decorations, two player markers, and coin-spawn markers.

To use custom tile art, place a regular 32×32-grid PNG atlas at `assets/tileset.png`. The game reads tiles left-to-right and falls back to its procedural gothic palette when the PNG is absent.

See `assets/README.md` for tile IDs, collision semantics, Tiled export instructions, and level validation.

## Let your partner join over the internet

For a direct connection:

1. Keep the host game running.
2. Allow `CoinRush` through the host computer's firewall for incoming TCP connections.
3. In the router, forward **TCP port 53000** (or your chosen port) to the host computer's LAN IPv4 address shown in the lobby.
4. Give your partner the router's public IP address and the port. They enter those in **Server Address** and **TCP Port**, then click **Join Lobby**.

If the host is behind carrier-grade NAT, ordinary port forwarding will not work. The simplest alternatives are an overlay VPN shared by both players, or running the included dedicated server on a public machine:

```sh
./build/CoinRush --server 53000
```

Allow TCP 53000 in that machine's firewall/security group, then both players join its public IP. A dedicated server does not open a graphical window.

## Troubleshooting

- **The host works, but the partner times out:** verify the forward is TCP (not only UDP), the internal destination IP has not changed, and the OS firewall allows the executable.
- **The public IP begins with 10, 172.16–31, 192.168, or 100.64–127:** that is not a publicly routable address. Use the router's actual WAN IP; if its WAN IP is also private/shared, use an overlay VPN or public server.
- **Port already in use:** pick another port in both clients and update the router/firewall rule.
- **macOS asks for incoming-network permission:** choose Allow for the host.
- **No text appears / font error:** install Arial, DejaVu Sans, Liberation Sans, or Segoe UI. The game checks common system font locations.

## Scope and security

This is game-jam networking, intended for play with someone you trust. It has no accounts, encryption, password, NAT punch-through, matchmaking service, or denial-of-service protection. Stop the host or remove the port-forward after playing if you do not want the port left exposed.

## Project layout

```text
CMakeLists.txt           Build configuration and SFML dependency setup
commands.md              Shell command and operations reference
assets/README.md         Tiled CSV and PNG atlas authoring guide
assets/levels/castle.csv Bundled 48x22 castle level
include/Protocol.hpp     Packet types and shared game constants
include/TileMap.hpp      Shared level loading, collision, and rendering
include/GameServer.hpp   Authoritative lobby/game server
include/ClientApp.hpp    SFML client UI and renderer
src/TileMap.cpp
src/GameServer.cpp
src/ClientApp.cpp
src/main.cpp             GUI, dedicated server, and smoke-test entry points
```
