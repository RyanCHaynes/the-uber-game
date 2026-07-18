#pragma once

#include "Protocol.hpp"

#include <SFML/Network.hpp>

#include <atomic>
#include <memory>
#include <random>
#include <string>
#include <thread>
#include <vector>

namespace coinrush {

class GameServer {
public:
    GameServer();
    ~GameServer();

    GameServer(const GameServer&) = delete;
    GameServer& operator=(const GameServer&) = delete;

    bool start(unsigned short port, std::string& error);
    void stop();
    bool isRunning() const;
    unsigned short port() const;

private:
    struct Peer {
        std::unique_ptr<sf::TcpSocket> socket;
        std::uint32_t id = 0;
        std::string name;
        bool joined = false;
        bool ready = false;
        PlayerInput input;
    };

    struct PlayerState {
        std::uint32_t id = 0;
        sf::Vector2f position;
        std::uint32_t score = 0;
    };

    void run();
    void acceptPeer();
    bool receiveFrom(Peer& peer);
    void handlePacket(Peer& peer, sf::Packet& packet);
    void removePeer(std::size_t index);
    void beginGameIfReady();
    void beginGame();
    void endGameForDisconnect();
    void updateGame(float seconds);
    void resetToLobby();
    void moveCoin();

    void sendTo(Peer& peer, sf::Packet packet);
    void broadcast(sf::Packet packet);
    void broadcastLobby();
    void broadcastSnapshot();
    void broadcastNotice(const std::string& text);

    std::string uniqueName(std::string requested) const;
    PlayerState* stateFor(std::uint32_t id);

    std::atomic<bool> running_{false};
    unsigned short port_{0};
    sf::TcpListener listener_;
    sf::SocketSelector selector_;
    std::thread worker_;
    std::vector<std::unique_ptr<Peer>> peers_;
    std::vector<PlayerState> players_;
    std::uint32_t nextId_{1};
    bool gameRunning_{false};
    sf::Vector2f coin_{WindowWidth / 2.f, (ArenaTop + WindowHeight) / 2.f};
    sf::Clock gameOverClock_;
    bool gameOver_{false};
    sf::Int32 winner_{-1};
    std::mt19937 random_;
};

} // namespace coinrush

