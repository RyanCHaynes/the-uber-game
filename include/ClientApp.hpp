#pragma once

#include "GameServer.hpp"
#include "Protocol.hpp"

#include <SFML/Graphics.hpp>
#include <SFML/Network.hpp>

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace coinrush {

class ClientApp {
public:
    int run();

private:
    enum class Screen { Setup, Connecting, Lobby, Game, Error };
    enum class Field { Name, Address, Port };

    struct LobbyPlayer {
        std::uint32_t id = 0;
        std::string name;
        bool ready = false;
    };

    struct RemotePlayer {
        sf::Vector2f position;
        std::uint32_t score = 0;
    };

    bool loadFont();
    void handleEvent(const sf::Event& event);
    void handleSetupEvent(const sf::Event& event);
    void update();
    void pollNetwork();
    void handlePacket(sf::Packet& packet);
    void sendInput();

    void hostLobby();
    void joinLobby();
    void connectTo(const std::string& address, bool hosting);
    void disconnectToSetup();
    void fail(const std::string& message);
    unsigned short enteredPort() const;

    void draw();
    void drawSetup();
    void drawConnecting();
    void drawLobby();
    void drawGame();
    void drawError();
    void drawText(const std::string& value, unsigned int size, float x, float y,
                  sf::Color color = sf::Color::White, bool centered = false);
    void drawPanel(const sf::FloatRect& bounds, sf::Color fill, sf::Color outline = sf::Color::Transparent);
    bool mouseIn(const sf::FloatRect& bounds) const;
    std::string playerName(std::uint32_t id) const;
    sf::Color playerColor(std::uint32_t id) const;

    sf::RenderWindow window_;
    sf::Font font_;
    Screen screen_{Screen::Setup};
    Field activeField_{Field::Name};
    std::string name_{"Player"};
    std::string address_{"127.0.0.1"};
    std::string portText_{std::to_string(DefaultPort)};
    std::string error_;
    std::string notice_;
    sf::Clock noticeClock_;

    GameServer embeddedServer_;
    sf::TcpSocket socket_;
    bool connected_{false};
    bool hosting_{false};
    std::uint32_t myId_{0};
    std::vector<LobbyPlayer> lobbyPlayers_;
    std::map<std::uint32_t, RemotePlayer> remotePlayers_;
    sf::Vector2f coin_;
    sf::Int32 winner_{-1};
    sf::Clock inputClock_;

    const sf::FloatRect nameBox_{390.f, 225.f, 500.f, 54.f};
    const sf::FloatRect addressBox_{390.f, 320.f, 500.f, 54.f};
    const sf::FloatRect portBox_{390.f, 415.f, 500.f, 54.f};
    const sf::FloatRect hostButton_{390.f, 515.f, 235.f, 62.f};
    const sf::FloatRect joinButton_{655.f, 515.f, 235.f, 62.f};
};

} // namespace coinrush

