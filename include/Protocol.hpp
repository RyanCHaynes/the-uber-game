#pragma once

#include <SFML/Network/Packet.hpp>
#include <SFML/System/Vector2.hpp>

#include <cstdint>
#include <string>

namespace coinrush {

constexpr unsigned short DefaultPort = 53000;
constexpr unsigned int WindowWidth = 1280;
constexpr unsigned int WindowHeight = 720;
constexpr float ArenaTop = 92.f;
constexpr float PlayerRadius = 23.f;
constexpr float CoinRadius = 14.f;
constexpr float PlayerSpeed = 280.f;
constexpr std::uint32_t WinningScore = 5;

enum class Message : sf::Uint8 {
    Hello = 1,
    SetReady = 2,
    Input = 3,

    Welcome = 101,
    Lobby = 102,
    GameStart = 103,
    Snapshot = 104,
    Notice = 105
};

struct PlayerInput {
    bool up = false;
    bool down = false;
    bool left = false;
    bool right = false;
};

inline sf::Packet helloPacket(const std::string& name) {
    sf::Packet packet;
    packet << static_cast<sf::Uint8>(Message::Hello) << name;
    return packet;
}

inline sf::Packet readyPacket(bool ready) {
    sf::Packet packet;
    packet << static_cast<sf::Uint8>(Message::SetReady) << static_cast<sf::Uint8>(ready);
    return packet;
}

inline sf::Packet inputPacket(const PlayerInput& input) {
    sf::Packet packet;
    packet << static_cast<sf::Uint8>(Message::Input)
           << static_cast<sf::Uint8>(input.up)
           << static_cast<sf::Uint8>(input.down)
           << static_cast<sf::Uint8>(input.left)
           << static_cast<sf::Uint8>(input.right);
    return packet;
}

} // namespace coinrush

