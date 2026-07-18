#include "GameServer.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cctype>
#include <iostream>

namespace coinrush {

GameServer::GameServer() : random_(std::random_device{}()) {}

GameServer::~GameServer() {
    stop();
}

bool GameServer::start(unsigned short requestedPort, std::string& error) {
    if (running_) {
        error = "The server is already running.";
        return false;
    }

    std::string levelError;
    if (!level_.loadBundledCastle(levelError)) {
        error = "Level load failed: " + levelError;
        return false;
    }

    selector_.clear();
    if (listener_.listen(requestedPort) != sf::Socket::Done) {
        error = "Could not listen on TCP port " + std::to_string(requestedPort) +
                ". It may already be in use or blocked by the OS.";
        return false;
    }

    listener_.setBlocking(false);
    port_ = listener_.getLocalPort();
    selector_.add(listener_);
    running_ = true;
    worker_ = std::thread(&GameServer::run, this);
    return true;
}

void GameServer::stop() {
    if (!running_.exchange(false)) {
        return;
    }

    if (worker_.joinable()) {
        worker_.join();
    }

    selector_.clear();
    listener_.close();
    for (auto& peer : peers_) {
        peer->socket->disconnect();
    }
    peers_.clear();
    players_.clear();
    gameRunning_ = false;
    port_ = 0;
}

bool GameServer::isRunning() const {
    return running_;
}

unsigned short GameServer::port() const {
    return port_;
}

void GameServer::run() {
    sf::Clock updateClock;
    float snapshotTimer = 0.f;

    while (running_) {
        const bool hasActivity = selector_.wait(sf::milliseconds(8));

        if (hasActivity && selector_.isReady(listener_)) {
            acceptPeer();
        }

        for (std::size_t index = 0; index < peers_.size();) {
            Peer& peer = *peers_[index];
            if (hasActivity && selector_.isReady(*peer.socket) && !receiveFrom(peer)) {
                removePeer(index);
            } else {
                ++index;
            }
        }

        // Keep a physics step below one tile so a stalled frame cannot tunnel through a platform.
        const float elapsed = std::min(updateClock.restart().asSeconds(), 0.02f);
        if (gameRunning_) {
            updateGame(elapsed);
            snapshotTimer += elapsed;
            if (snapshotTimer >= 0.05f) {
                snapshotTimer = 0.f;
                broadcastSnapshot();
            }
        }
    }
}

void GameServer::acceptPeer() {
    auto socket = std::make_unique<sf::TcpSocket>();
    if (listener_.accept(*socket) != sf::Socket::Done) {
        return;
    }

    if (peers_.size() >= 2) {
        sf::Packet full;
        full << static_cast<sf::Uint8>(Message::Notice)
             << std::string("This lobby already has two players.");
        socket->send(full);
        socket->disconnect();
        return;
    }

    socket->setBlocking(false);
    auto peer = std::make_unique<Peer>();
    peer->socket = std::move(socket);
    selector_.add(*peer->socket);
    peers_.push_back(std::move(peer));
}

bool GameServer::receiveFrom(Peer& peer) {
    sf::Packet packet;
    const sf::Socket::Status status = peer.socket->receive(packet);
    if (status == sf::Socket::Done) {
        handlePacket(peer, packet);
        return true;
    }
    if (status == sf::Socket::NotReady || status == sf::Socket::Partial) {
        return true;
    }
    return false;
}

void GameServer::handlePacket(Peer& peer, sf::Packet& packet) {
    sf::Uint8 rawType = 0;
    if (!(packet >> rawType)) {
        return;
    }

    const Message type = static_cast<Message>(rawType);
    if (type == Message::Hello && !peer.joined) {
        std::string requestedName;
        if (!(packet >> requestedName)) {
            return;
        }

        peer.id = nextId_++;
        peer.name = uniqueName(requestedName);
        peer.joined = true;

        sf::Packet welcome;
        welcome << static_cast<sf::Uint8>(Message::Welcome) << static_cast<sf::Uint32>(peer.id);
        sendTo(peer, std::move(welcome));
        broadcastNotice(peer.name + " joined the lobby.");
        broadcastLobby();
        return;
    }

    if (!peer.joined) {
        return;
    }

    if (type == Message::SetReady && !gameRunning_) {
        sf::Uint8 ready = 0;
        if (packet >> ready) {
            peer.ready = ready != 0;
            broadcastLobby();
            beginGameIfReady();
        }
    } else if (type == Message::Input && gameRunning_) {
        sf::Uint8 up = 0;
        sf::Uint8 down = 0;
        sf::Uint8 left = 0;
        sf::Uint8 right = 0;
        if (packet >> up >> down >> left >> right) {
            peer.input = {up != 0, down != 0, left != 0, right != 0};
        }
    }
}

void GameServer::removePeer(std::size_t index) {
    const bool hadJoined = peers_[index]->joined;
    const std::string departed = peers_[index]->name;
    selector_.remove(*peers_[index]->socket);
    peers_[index]->socket->disconnect();
    peers_.erase(peers_.begin() + static_cast<std::ptrdiff_t>(index));

    if (!hadJoined) {
        return;
    }

    if (gameRunning_) {
        endGameForDisconnect();
    }
    broadcastNotice(departed + " left the lobby.");
    broadcastLobby();
}

void GameServer::beginGameIfReady() {
    const auto joinedCount = static_cast<std::size_t>(std::count_if(
        peers_.begin(), peers_.end(), [](const auto& peer) { return peer->joined; }));
    if (joinedCount != 2) {
        return;
    }

    const bool everyoneReady = std::all_of(peers_.begin(), peers_.end(), [](const auto& peer) {
        return !peer->joined || peer->ready;
    });
    if (everyoneReady) {
        beginGame();
    }
}

void GameServer::beginGame() {
    players_.clear();
    std::size_t slot = 0;
    for (const auto& peer : peers_) {
        if (!peer->joined) {
            continue;
        }
        sf::Vector2f spawn = level_.playerSpawn(slot);
        spawn.y += TileMap::TileSize / 2.f - PlayerHalfHeight;
        players_.push_back({peer->id, spawn, {}, 0, true});
        peer->jumpWasDown = false;
        ++slot;
    }

    gameRunning_ = true;
    gameOver_ = false;
    winner_ = -1;
    moveCoin();

    sf::Packet start;
    start << static_cast<sf::Uint8>(Message::GameStart);
    broadcast(std::move(start));
    broadcastNotice("Go! First player to five coins wins.");
    broadcastSnapshot();
}

void GameServer::endGameForDisconnect() {
    resetToLobby();
    broadcastNotice("The match ended because a player disconnected.");
}

void GameServer::updateGame(float seconds) {
    if (gameOver_) {
        if (gameOverClock_.getElapsedTime().asSeconds() >= 4.f) {
            resetToLobby();
            broadcastLobby();
        }
        return;
    }

    for (auto& peer : peers_) {
        if (!peer->joined) {
            continue;
        }
        PlayerState* state = stateFor(peer->id);
        if (!state) {
            continue;
        }

        updatePlayer(*peer, *state, seconds);

        const sf::Vector2f delta = state->position - coin_;
        if (std::abs(delta.x) <= PlayerHalfWidth + CoinRadius &&
            std::abs(delta.y) <= PlayerHalfHeight + CoinRadius) {
            ++state->score;
            if (state->score >= WinningScore) {
                winner_ = static_cast<sf::Int32>(state->id);
                gameOver_ = true;
                gameOverClock_.restart();
                for (const auto& winnerPeer : peers_) {
                    if (winnerPeer->id == state->id) {
                        broadcastNotice(winnerPeer->name + " wins! Returning to the lobby...");
                        break;
                    }
                }
            } else {
                moveCoin();
            }
            break;
        }
    }
}

void GameServer::updatePlayer(Peer& peer, PlayerState& state, float seconds) {
    const float horizontal = static_cast<float>(peer.input.right) - static_cast<float>(peer.input.left);
    state.velocity.x = horizontal * PlayerSpeed;

    if (peer.input.up && !peer.jumpWasDown && state.grounded) {
        state.velocity.y = -JumpSpeed;
        state.grounded = false;
    }
    peer.jumpWasDown = peer.input.up;
    state.velocity.y = std::min(state.velocity.y + Gravity * seconds, MaximumFallSpeed);

    const auto tileFor = [](float pixel) {
        return static_cast<int>(std::floor(pixel / static_cast<float>(TileMap::TileSize)));
    };

    state.position.x += state.velocity.x * seconds;
    const int top = tileFor(state.position.y - PlayerHalfHeight + 1.f);
    const int bottom = tileFor(state.position.y + PlayerHalfHeight - 1.f);
    if (state.velocity.x > 0.f) {
        const int right = tileFor(state.position.x + PlayerHalfWidth);
        for (int y = top; y <= bottom; ++y) {
            if (level_.isSolid(right, y)) {
                state.position.x = right * TileMap::TileSize - PlayerHalfWidth - 0.01f;
                state.velocity.x = 0.f;
                break;
            }
        }
    } else if (state.velocity.x < 0.f) {
        const int left = tileFor(state.position.x - PlayerHalfWidth);
        for (int y = top; y <= bottom; ++y) {
            if (level_.isSolid(left, y)) {
                state.position.x = (left + 1) * TileMap::TileSize + PlayerHalfWidth + 0.01f;
                state.velocity.x = 0.f;
                break;
            }
        }
    }

    state.position.y += state.velocity.y * seconds;
    state.grounded = false;
    const int left = tileFor(state.position.x - PlayerHalfWidth + 1.f);
    const int right = tileFor(state.position.x + PlayerHalfWidth - 1.f);
    if (state.velocity.y >= 0.f) {
        const int bottomTile = tileFor(state.position.y + PlayerHalfHeight);
        for (int x = left; x <= right; ++x) {
            if (level_.isSolid(x, bottomTile)) {
                state.position.y = bottomTile * TileMap::TileSize - PlayerHalfHeight - 0.01f;
                state.velocity.y = 0.f;
                state.grounded = true;
                break;
            }
        }
    } else {
        const int topTile = tileFor(state.position.y - PlayerHalfHeight);
        for (int x = left; x <= right; ++x) {
            if (level_.isSolid(x, topTile)) {
                state.position.y = (topTile + 1) * TileMap::TileSize + PlayerHalfHeight + 0.01f;
                state.velocity.y = 0.f;
                break;
            }
        }
    }
}

void GameServer::resetToLobby() {
    gameRunning_ = false;
    gameOver_ = false;
    winner_ = -1;
    players_.clear();
    for (auto& peer : peers_) {
        peer->ready = false;
        peer->jumpWasDown = false;
        peer->input = {};
    }
}

void GameServer::moveCoin() {
    const auto& spawns = level_.coinSpawns();
    if (spawns.empty()) {
        coin_ = {level_.worldSize().x / 2.f, level_.worldSize().y / 2.f};
        return;
    }

    std::uniform_int_distribution<std::size_t> choice(0, spawns.size() - 1);
    std::size_t next = choice(random_);
    if (spawns.size() > 1 && next == coinIndex_) {
        next = (next + 1) % spawns.size();
    }
    coinIndex_ = next;
    coin_ = spawns[coinIndex_];
}

void GameServer::sendTo(Peer& peer, sf::Packet packet) {
    sf::Socket::Status status = peer.socket->send(packet);
    int retries = 0;
    while (status == sf::Socket::Partial && retries++ < 4) {
        status = peer.socket->send(packet);
    }
}

void GameServer::broadcast(sf::Packet packet) {
    for (auto& peer : peers_) {
        if (peer->joined) {
            sendTo(*peer, packet);
        }
    }
}

void GameServer::broadcastLobby() {
    sf::Packet packet;
    packet << static_cast<sf::Uint8>(Message::Lobby);

    const sf::Uint8 count = static_cast<sf::Uint8>(std::count_if(
        peers_.begin(), peers_.end(), [](const auto& peer) { return peer->joined; }));
    packet << count;
    for (const auto& peer : peers_) {
        if (peer->joined) {
            packet << static_cast<sf::Uint32>(peer->id)
                   << peer->name
                   << static_cast<sf::Uint8>(peer->ready);
        }
    }
    broadcast(std::move(packet));
}

void GameServer::broadcastSnapshot() {
    sf::Packet packet;
    packet << static_cast<sf::Uint8>(Message::Snapshot)
           << coin_.x << coin_.y
           << static_cast<sf::Uint8>(players_.size());
    for (const auto& player : players_) {
        packet << static_cast<sf::Uint32>(player.id)
               << player.position.x << player.position.y
               << static_cast<sf::Uint32>(player.score);
    }
    packet << winner_;
    broadcast(std::move(packet));
}

void GameServer::broadcastNotice(const std::string& text) {
    sf::Packet packet;
    packet << static_cast<sf::Uint8>(Message::Notice) << text;
    broadcast(std::move(packet));
}

std::string GameServer::uniqueName(std::string requested) const {
    requested.erase(std::remove_if(requested.begin(), requested.end(), [](unsigned char character) {
        return !std::isprint(character);
    }), requested.end());
    if (requested.size() > 18) {
        requested.resize(18);
    }
    if (requested.empty()) {
        requested = "Player";
    }

    const std::string base = requested;
    int suffix = 2;
    const auto isTaken = [this](const std::string& candidate) {
        return std::any_of(peers_.begin(), peers_.end(), [&candidate](const auto& peer) {
            return peer->joined && peer->name == candidate;
        });
    };
    while (isTaken(requested)) {
        requested = base.substr(0, 14) + " " + std::to_string(suffix++);
    }
    return requested;
}

GameServer::PlayerState* GameServer::stateFor(std::uint32_t id) {
    const auto found = std::find_if(players_.begin(), players_.end(), [id](const PlayerState& player) {
        return player.id == id;
    });
    return found == players_.end() ? nullptr : &*found;
}

} // namespace coinrush
