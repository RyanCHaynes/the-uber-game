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

        const float elapsed = std::min(updateClock.restart().asSeconds(), 0.05f);
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
        const float x = slot == 0 ? 210.f : WindowWidth - 210.f;
        players_.push_back({peer->id, {x, (ArenaTop + WindowHeight) / 2.f}, 0});
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

        sf::Vector2f direction(
            static_cast<float>(peer->input.right) - static_cast<float>(peer->input.left),
            static_cast<float>(peer->input.down) - static_cast<float>(peer->input.up));
        const float length = std::sqrt(direction.x * direction.x + direction.y * direction.y);
        if (length > 0.f) {
            direction /= length;
            state->position += direction * PlayerSpeed * seconds;
        }

        state->position.x = std::clamp(state->position.x, PlayerRadius, WindowWidth - PlayerRadius);
        state->position.y = std::clamp(state->position.y, ArenaTop + PlayerRadius, WindowHeight - PlayerRadius);

        const sf::Vector2f delta = state->position - coin_;
        const float collectDistance = PlayerRadius + CoinRadius;
        if (delta.x * delta.x + delta.y * delta.y <= collectDistance * collectDistance) {
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

void GameServer::resetToLobby() {
    gameRunning_ = false;
    gameOver_ = false;
    winner_ = -1;
    players_.clear();
    for (auto& peer : peers_) {
        peer->ready = false;
        peer->input = {};
    }
}

void GameServer::moveCoin() {
    std::uniform_real_distribution<float> x(PlayerRadius + 35.f, WindowWidth - PlayerRadius - 35.f);
    std::uniform_real_distribution<float> y(ArenaTop + PlayerRadius + 35.f, WindowHeight - PlayerRadius - 35.f);
    coin_ = {x(random_), y(random_)};
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
