# Coin Rush shell commands

Run commands from the repository:

```sh
cd /Users/ryan/Developer/coin-rush-sfml-source
```

## Build

Configure and build a release version:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
```

Rebuild after editing source code:

```sh
cmake --build build --parallel
```

Make a clean build:

```sh
cmake -E remove_directory build
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
```

## Start the graphical game

```sh
./build/CoinRush
```

On macOS, you can also run or double-click the included launcher:

```sh
./run-game.command
```

In the setup screen:

- **Host Lobby** or `F1` starts an embedded server and joins it automatically.
- **Join Lobby**, `F2`, or Enter connects to an existing server.
- Space toggles ready in the lobby.
- A/D or Left/Right moves; W or Up jumps during a match.
- Esc disconnects or returns to setup.

## Host from the graphical game

```sh
./build/CoinRush
```

Enter your name, keep port `53000`, and click **Host Lobby**. Keep the game open for the whole match. Your partner joins your address on the same port.

Do not also run a dedicated server on port `53000`; only one server can own the port.

## Run a dedicated server

```sh
./build/CoinRush --server 53000
```

Leave that terminal open. A dedicated server is not a player, so both players must start the graphical game separately and click **Join Lobby**.

The player using the server Mac joins `127.0.0.1`. A second computer joins the server's LAN or public IP address.

Stop the foreground server with `Ctrl+C`.

## Run the server in the background

Start it and save its process ID:

```sh
./build/CoinRush --server 53000 > coinrush-server.log 2>&1 &
echo $! > coinrush-server.pid
```

Follow its log:

```sh
tail -f coinrush-server.log
```

Stop following the log with `Ctrl+C`. Stop the server itself with:

```sh
kill "$(cat coinrush-server.pid)"
rm coinrush-server.pid
```

## Join a lobby

```sh
./build/CoinRush
```

Enter one of these server addresses:

- Server on the same Mac: `127.0.0.1`
- Server on the same network: the server Mac's LAN IPv4 address
- Server over the internet: the server network's public IPv4 address

Use the same TCP port as the server, normally `53000`, then click **Join Lobby**.

## Test two clients on one Mac

In Terminal 1:

```sh
./build/CoinRush --server 53000
```

In Terminals 2 and 3:

```sh
./build/CoinRush
```

Both clients join `127.0.0.1:53000` with different player names.

Alternatively, start two graphical clients, host from the first, and join `127.0.0.1` from the second. Do not run the dedicated server for this alternative.

## Find the Mac's LAN address

For Wi-Fi, this is normally:

```sh
ipconfig getifaddr en0
```

If that prints nothing, find the active interface:

```sh
networksetup -listallhardwareports
```

Then query its device name, for example:

```sh
ipconfig getifaddr en1
```

## Allow Coin Rush through the macOS firewall

```sh
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$PWD/build/CoinRush"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$PWD/build/CoinRush"
```

Check firewall state and application rules:

```sh
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --listapps
```

Click **Allow** if macOS displays an incoming-connections prompt. Rebuilding the executable may require allowing it again.

## Make the server reachable over the internet

Configure the router to forward the following rule to the server Mac's LAN IPv4 address:

```text
Protocol:       TCP
External port:  53000
Internal port:  53000
Destination:    server Mac's LAN IPv4 address
```

Router forwarding is configured in the router's web interface or app, not in the Mac shell. If you use a different port, use it everywhere: server command, both clients, firewall, and router rule.

If the internet connection uses carrier-grade NAT, normal port forwarding will not work. Use an overlay VPN or a publicly reachable dedicated server instead.

## Check whether the server is listening

```sh
lsof -nP -iTCP:53000 -sTCP:LISTEN
```

Successful output contains `CoinRush` and `TCP *:53000 (LISTEN)`.

Test the port locally:

```sh
nc -vz 127.0.0.1 53000
```

Test it from another computer on the LAN:

```sh
nc -vz SERVER_LAN_IP 53000
```

## Fix “Failed to bind listener socket to port 53000”

The port is already owned by another server. Find its process ID:

```sh
lsof -nP -iTCP:53000 -sTCP:LISTEN
```

If it is the dedicated Coin Rush server you meant to use, leave it running and select **Join Lobby**, not **Host Lobby**.

To stop a stale server, replace `PROCESS_ID` with the PID shown by `lsof`:

```sh
kill PROCESS_ID
```

Check that the port is free:

```sh
lsof -nP -iTCP:53000 -sTCP:LISTEN
```

As an alternative, use another port consistently:

```sh
./build/CoinRush --server 53001
```

## Run tests

Run the direct network smoke test:

```sh
./build/CoinRush --smoke-test
```

Or run it through CTest:

```sh
ctest --test-dir build --output-on-failure
```

The test covers server startup, two connections, lobby entry, ready state, and match start.

Validate the CSV dimensions, collision IDs, player markers, and coin markers directly:

```sh
./build/CoinRush --level-test
```

Level and tileset authoring instructions are in `assets/README.md`.

## Show command-line help

```sh
./build/CoinRush --help
```
