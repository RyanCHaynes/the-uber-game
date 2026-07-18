#include "ClientApp.hpp"

#include <array>
#include <cctype>
#include <iostream>
#include <sstream>

namespace coinrush {

int ClientApp::run() {
    if (!loadFont()) {
        std::cerr << "Could not find a usable system font. Install Arial or DejaVu Sans and try again.\n";
        return 1;
    }

    window_.create(sf::VideoMode(WindowWidth, WindowHeight), "Coin Rush - SFML Online Jam Game",
                   sf::Style::Titlebar | sf::Style::Close);
    window_.setFramerateLimit(60);
    socket_.setBlocking(false);

    while (window_.isOpen()) {
        sf::Event event{};
        while (window_.pollEvent(event)) {
            handleEvent(event);
        }
        update();
        draw();
    }

    socket_.disconnect();
    embeddedServer_.stop();
    return 0;
}

bool ClientApp::loadFont() {
    const std::array<const char*, 8> candidates = {
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "assets/DejaVuSans.ttf"
    };
    for (const char* path : candidates) {
        if (font_.loadFromFile(path)) {
            return true;
        }
    }
    return false;
}

void ClientApp::handleEvent(const sf::Event& event) {
    if (event.type == sf::Event::Closed) {
        window_.close();
        return;
    }

    if (screen_ == Screen::Setup) {
        handleSetupEvent(event);
        return;
    }

    if (screen_ == Screen::Lobby) {
        if (event.type == sf::Event::KeyPressed && event.key.code == sf::Keyboard::Space) {
            bool currentlyReady = false;
            for (const LobbyPlayer& player : lobbyPlayers_) {
                if (player.id == myId_) {
                    currentlyReady = player.ready;
                }
            }
            sf::Packet packet = readyPacket(!currentlyReady);
            socket_.send(packet);
        } else if (event.type == sf::Event::MouseButtonPressed &&
                   event.mouseButton.button == sf::Mouse::Left &&
                   mouseIn({470.f, 565.f, 340.f, 64.f})) {
            bool currentlyReady = false;
            for (const LobbyPlayer& player : lobbyPlayers_) {
                if (player.id == myId_) {
                    currentlyReady = player.ready;
                }
            }
            sf::Packet packet = readyPacket(!currentlyReady);
            socket_.send(packet);
        }
    }

    if (event.type == sf::Event::KeyPressed && event.key.code == sf::Keyboard::Escape) {
        disconnectToSetup();
    }
    if (screen_ == Screen::Error && event.type == sf::Event::KeyPressed &&
        event.key.code == sf::Keyboard::Enter) {
        disconnectToSetup();
    }
}

void ClientApp::handleSetupEvent(const sf::Event& event) {
    if (event.type == sf::Event::MouseButtonPressed && event.mouseButton.button == sf::Mouse::Left) {
        if (mouseIn(nameBox_)) {
            activeField_ = Field::Name;
        } else if (mouseIn(addressBox_)) {
            activeField_ = Field::Address;
        } else if (mouseIn(portBox_)) {
            activeField_ = Field::Port;
        } else if (mouseIn(hostButton_)) {
            hostLobby();
        } else if (mouseIn(joinButton_)) {
            joinLobby();
        }
    }

    if (event.type == sf::Event::KeyPressed) {
        if (event.key.code == sf::Keyboard::Tab) {
            activeField_ = activeField_ == Field::Name
                ? Field::Address
                : (activeField_ == Field::Address ? Field::Port : Field::Name);
        } else if (event.key.code == sf::Keyboard::F1) {
            hostLobby();
        } else if (event.key.code == sf::Keyboard::F2 || event.key.code == sf::Keyboard::Enter) {
            joinLobby();
        } else if (event.key.code == sf::Keyboard::Escape) {
            window_.close();
        }
    }

    if (event.type != sf::Event::TextEntered) {
        return;
    }

    std::string* value = activeField_ == Field::Name
        ? &name_
        : (activeField_ == Field::Address ? &address_ : &portText_);
    const std::size_t limit = activeField_ == Field::Name ? 18 : (activeField_ == Field::Address ? 64 : 5);
    if (event.text.unicode == 8) {
        if (!value->empty()) {
            value->pop_back();
        }
    } else if (event.text.unicode >= 32 && event.text.unicode < 127 && value->size() < limit) {
        const char character = static_cast<char>(event.text.unicode);
        if (activeField_ != Field::Port || std::isdigit(static_cast<unsigned char>(character))) {
            value->push_back(character);
        }
    }
}

void ClientApp::update() {
    if (connected_) {
        pollNetwork();
    }
    if (screen_ == Screen::Game && connected_ && inputClock_.getElapsedTime().asMilliseconds() >= 33) {
        inputClock_.restart();
        sendInput();
    }
}

void ClientApp::pollNetwork() {
    while (connected_) {
        sf::Packet packet;
        const sf::Socket::Status status = socket_.receive(packet);
        if (status == sf::Socket::Done) {
            handlePacket(packet);
        } else if (status == sf::Socket::NotReady || status == sf::Socket::Partial) {
            break;
        } else {
            fail(notice_.empty() ? "The server closed the connection." : notice_);
            break;
        }
    }
}

void ClientApp::handlePacket(sf::Packet& packet) {
    sf::Uint8 rawType = 0;
    if (!(packet >> rawType)) {
        return;
    }
    const Message type = static_cast<Message>(rawType);

    if (type == Message::Welcome) {
        sf::Uint32 id = 0;
        if (packet >> id) {
            myId_ = id;
        }
    } else if (type == Message::Lobby) {
        sf::Uint8 count = 0;
        if (!(packet >> count)) {
            return;
        }
        lobbyPlayers_.clear();
        for (sf::Uint8 index = 0; index < count; ++index) {
            sf::Uint32 id = 0;
            std::string name;
            sf::Uint8 ready = 0;
            if (!(packet >> id >> name >> ready)) {
                return;
            }
            lobbyPlayers_.push_back({id, name, ready != 0});
        }
        screen_ = Screen::Lobby;
    } else if (type == Message::GameStart) {
        winner_ = -1;
        remotePlayers_.clear();
        screen_ = Screen::Game;
        inputClock_.restart();
    } else if (type == Message::Snapshot) {
        sf::Uint8 count = 0;
        if (!(packet >> coin_.x >> coin_.y >> count)) {
            return;
        }
        remotePlayers_.clear();
        for (sf::Uint8 index = 0; index < count; ++index) {
            sf::Uint32 id = 0;
            sf::Uint32 score = 0;
            sf::Vector2f position;
            if (!(packet >> id >> position.x >> position.y >> score)) {
                return;
            }
            remotePlayers_[id] = {position, score};
        }
        packet >> winner_;
    } else if (type == Message::Notice) {
        packet >> notice_;
        noticeClock_.restart();
    }
}

void ClientApp::sendInput() {
    PlayerInput input;
    input.up = sf::Keyboard::isKeyPressed(sf::Keyboard::W) ||
               sf::Keyboard::isKeyPressed(sf::Keyboard::Up);
    input.down = sf::Keyboard::isKeyPressed(sf::Keyboard::S) ||
                 sf::Keyboard::isKeyPressed(sf::Keyboard::Down);
    input.left = sf::Keyboard::isKeyPressed(sf::Keyboard::A) ||
                 sf::Keyboard::isKeyPressed(sf::Keyboard::Left);
    input.right = sf::Keyboard::isKeyPressed(sf::Keyboard::D) ||
                  sf::Keyboard::isKeyPressed(sf::Keyboard::Right);
    sf::Packet packet = inputPacket(input);
    socket_.send(packet);
}

void ClientApp::hostLobby() {
    connectTo("127.0.0.1", true);
}

void ClientApp::joinLobby() {
    connectTo(address_, false);
}

void ClientApp::connectTo(const std::string& address, bool hosting) {
    if (name_.empty()) {
        fail("Enter a player name first.");
        return;
    }
    const unsigned short selectedPort = enteredPort();
    if (selectedPort == 0) {
        fail("Enter a port between 1 and 65535.");
        return;
    }

    hosting_ = hosting;
    notice_.clear();
    if (hosting_) {
        std::string serverError;
        if (!embeddedServer_.start(selectedPort, serverError)) {
            fail(serverError);
            return;
        }
    }

    screen_ = Screen::Connecting;
    socket_.setBlocking(true);
    const sf::IpAddress remote(address);
    if (remote == sf::IpAddress::None) {
        fail("That server address could not be resolved.");
        return;
    }
    if (socket_.connect(remote, selectedPort, sf::seconds(4.f)) != sf::Socket::Done) {
        fail("Could not connect to " + address + ":" + std::to_string(selectedPort) + ".");
        return;
    }

    sf::Packet hello = helloPacket(name_);
    if (socket_.send(hello) != sf::Socket::Done) {
        fail("Connected, but could not enter the lobby.");
        return;
    }
    socket_.setBlocking(false);
    connected_ = true;
}

void ClientApp::disconnectToSetup() {
    connected_ = false;
    socket_.disconnect();
    embeddedServer_.stop();
    hosting_ = false;
    myId_ = 0;
    lobbyPlayers_.clear();
    remotePlayers_.clear();
    notice_.clear();
    error_.clear();
    screen_ = Screen::Setup;
}

void ClientApp::fail(const std::string& message) {
    connected_ = false;
    socket_.disconnect();
    embeddedServer_.stop();
    hosting_ = false;
    error_ = message;
    screen_ = Screen::Error;
}

unsigned short ClientApp::enteredPort() const {
    try {
        const unsigned long parsed = std::stoul(portText_);
        if (parsed > 0 && parsed <= 65535) {
            return static_cast<unsigned short>(parsed);
        }
    } catch (...) {
    }
    return 0;
}

void ClientApp::draw() {
    window_.clear(sf::Color(13, 18, 32));
    switch (screen_) {
        case Screen::Setup: drawSetup(); break;
        case Screen::Connecting: drawConnecting(); break;
        case Screen::Lobby: drawLobby(); break;
        case Screen::Game: drawGame(); break;
        case Screen::Error: drawError(); break;
    }
    window_.display();
}

void ClientApp::drawSetup() {
    drawText("COIN RUSH", 54, WindowWidth / 2.f, 74.f, sf::Color(255, 209, 82), true);
    drawText("A tiny two-player, server-authoritative jam game", 20, WindowWidth / 2.f, 128.f,
             sf::Color(154, 166, 196), true);

    const auto field = [this](const sf::FloatRect& box, const std::string& label,
                              const std::string& value, Field fieldType) {
        drawText(label, 17, box.left, box.top - 28.f, sf::Color(171, 183, 213));
        const bool active = activeField_ == fieldType;
        drawPanel(box, sf::Color(25, 33, 54), active ? sf::Color(79, 209, 197) : sf::Color(64, 75, 105));
        drawText(value, 22, box.left + 16.f, box.top + 13.f);
    };
    field(nameBox_, "PLAYER NAME", name_, Field::Name);
    field(addressBox_, "SERVER ADDRESS (for Join)", address_, Field::Address);
    field(portBox_, "TCP PORT", portText_, Field::Port);

    drawPanel(hostButton_, mouseIn(hostButton_) ? sf::Color(38, 183, 157) : sf::Color(28, 149, 129));
    drawText("HOST LOBBY", 20, hostButton_.left + hostButton_.width / 2.f,
             hostButton_.top + hostButton_.height / 2.f, sf::Color::White, true);
    drawPanel(joinButton_, mouseIn(joinButton_) ? sf::Color(102, 112, 235) : sf::Color(78, 87, 204));
    drawText("JOIN LOBBY", 20, joinButton_.left + joinButton_.width / 2.f,
             joinButton_.top + joinButton_.height / 2.f, sf::Color::White, true);

    drawText("Tab changes field  |  F1 hosts  |  F2 or Enter joins", 16,
             WindowWidth / 2.f, 632.f, sf::Color(115, 128, 159), true);
}

void ClientApp::drawConnecting() {
    drawText("CONNECTING...", 42, WindowWidth / 2.f, 300.f, sf::Color(79, 209, 197), true);
    drawText("Contacting the lobby server", 20, WindowWidth / 2.f, 368.f,
             sf::Color(154, 166, 196), true);
    drawText("Esc cancels", 16, WindowWidth / 2.f, 425.f, sf::Color(115, 128, 159), true);
}

void ClientApp::drawLobby() {
    drawText("LOBBY", 46, WindowWidth / 2.f, 64.f, sf::Color(255, 209, 82), true);
    if (hosting_) {
        std::ostringstream address;
        address << "Hosting on TCP port " << enteredPort() << "  |  LAN address: "
                << sf::IpAddress::getLocalAddress().toString();
        drawText(address.str(), 17, WindowWidth / 2.f, 118.f, sf::Color(154, 166, 196), true);
    } else {
        drawText("Connected to " + address_ + ":" + portText_, 17,
                 WindowWidth / 2.f, 118.f, sf::Color(154, 166, 196), true);
    }

    for (std::size_t slot = 0; slot < 2; ++slot) {
        const sf::FloatRect panel(270.f + static_cast<float>(slot) * 385.f, 190.f, 350.f, 245.f);
        drawPanel(panel, sf::Color(24, 31, 51), sf::Color(54, 66, 94));
        if (slot < lobbyPlayers_.size()) {
            const LobbyPlayer& player = lobbyPlayers_[slot];
            sf::CircleShape avatar(38.f);
            avatar.setOrigin(38.f, 38.f);
            avatar.setPosition(panel.left + panel.width / 2.f, panel.top + 78.f);
            avatar.setFillColor(playerColor(player.id));
            window_.draw(avatar);
            drawText(player.name + (player.id == myId_ ? " (you)" : ""), 24,
                     panel.left + panel.width / 2.f, panel.top + 145.f, sf::Color::White, true);
            drawText(player.ready ? "READY" : "NOT READY", 18,
                     panel.left + panel.width / 2.f, panel.top + 195.f,
                     player.ready ? sf::Color(79, 209, 197) : sf::Color(154, 166, 196), true);
        } else {
            drawText("Waiting for player...", 20, panel.left + panel.width / 2.f,
                     panel.top + panel.height / 2.f, sf::Color(115, 128, 159), true);
        }
    }

    bool ready = false;
    for (const LobbyPlayer& player : lobbyPlayers_) {
        if (player.id == myId_) {
            ready = player.ready;
        }
    }
    const sf::FloatRect button(470.f, 565.f, 340.f, 64.f);
    drawPanel(button, ready ? sf::Color(124, 71, 86) : sf::Color(28, 149, 129));
    drawText(ready ? "CANCEL READY" : "READY UP", 21, WindowWidth / 2.f,
             button.top + button.height / 2.f, sf::Color::White, true);
    drawText("Space toggles ready  |  Esc disconnects", 15, WindowWidth / 2.f, 665.f,
             sf::Color(115, 128, 159), true);

    if (!notice_.empty() && noticeClock_.getElapsedTime().asSeconds() < 3.5f) {
        drawText(notice_, 16, WindowWidth / 2.f, 510.f, sf::Color(255, 209, 82), true);
    }
}

void ClientApp::drawGame() {
    drawPanel({0.f, 0.f, static_cast<float>(WindowWidth), ArenaTop}, sf::Color(18, 24, 41));
    drawPanel({0.f, ArenaTop, static_cast<float>(WindowWidth), WindowHeight - ArenaTop}, sf::Color(22, 30, 48));

    for (float x = 40.f; x < WindowWidth; x += 80.f) {
        sf::Vertex line[] = {{{x, ArenaTop}, sf::Color(29, 39, 60)},
                             {{x, static_cast<float>(WindowHeight)}, sf::Color(29, 39, 60)}};
        window_.draw(line, 2, sf::Lines);
    }
    for (float y = ArenaTop + 40.f; y < WindowHeight; y += 80.f) {
        sf::Vertex line[] = {{{0.f, y}, sf::Color(29, 39, 60)},
                             {{static_cast<float>(WindowWidth), y}, sf::Color(29, 39, 60)}};
        window_.draw(line, 2, sf::Lines);
    }

    sf::CircleShape glow(CoinRadius + 9.f);
    glow.setOrigin(CoinRadius + 9.f, CoinRadius + 9.f);
    glow.setPosition(coin_);
    glow.setFillColor(sf::Color(255, 209, 82, 45));
    window_.draw(glow);
    sf::CircleShape coin(CoinRadius);
    coin.setOrigin(CoinRadius, CoinRadius);
    coin.setPosition(coin_);
    coin.setFillColor(sf::Color(255, 209, 82));
    coin.setOutlineThickness(3.f);
    coin.setOutlineColor(sf::Color(255, 236, 157));
    window_.draw(coin);

    for (const auto& entry : remotePlayers_) {
        const std::uint32_t id = entry.first;
        const RemotePlayer& player = entry.second;
        sf::CircleShape body(PlayerRadius);
        body.setOrigin(PlayerRadius, PlayerRadius);
        body.setPosition(player.position);
        body.setFillColor(playerColor(id));
        body.setOutlineThickness(id == myId_ ? 4.f : 2.f);
        body.setOutlineColor(sf::Color::White);
        window_.draw(body);
        drawText(playerName(id), 14, player.position.x, player.position.y - 46.f,
                 sf::Color(220, 226, 241), true);
    }

    float scoreX = 310.f;
    for (const auto& entry : remotePlayers_) {
        drawText(playerName(entry.first) + "  " + std::to_string(entry.second.score), 26,
                 scoreX, 45.f, playerColor(entry.first), true);
        scoreX = WindowWidth - 310.f;
    }
    drawText("FIRST TO " + std::to_string(WinningScore), 15, WindowWidth / 2.f, 30.f,
             sf::Color(154, 166, 196), true);
    drawText("WASD / arrow keys to move", 15, WindowWidth / 2.f, 59.f,
             sf::Color(115, 128, 159), true);

    if (winner_ >= 0) {
        drawPanel({0.f, 0.f, static_cast<float>(WindowWidth), static_cast<float>(WindowHeight)},
                  sf::Color(8, 12, 22, 190));
        drawText(winner_ == static_cast<sf::Int32>(myId_) ? "YOU WIN!" : playerName(winner_) + " WINS!",
                 58, WindowWidth / 2.f, 320.f, sf::Color(255, 209, 82), true);
        drawText("Returning to the lobby...", 20, WindowWidth / 2.f, 390.f,
                 sf::Color(220, 226, 241), true);
    }

    if (!notice_.empty() && noticeClock_.getElapsedTime().asSeconds() < 2.5f && winner_ < 0) {
        drawText(notice_, 18, WindowWidth / 2.f, 120.f, sf::Color(255, 209, 82), true);
    }
}

void ClientApp::drawError() {
    drawText("CONNECTION ERROR", 42, WindowWidth / 2.f, 250.f, sf::Color(246, 112, 128), true);
    drawText(error_, 19, WindowWidth / 2.f, 340.f, sf::Color(220, 226, 241), true);
    drawText("Press Enter or Esc to return", 17, WindowWidth / 2.f, 415.f,
             sf::Color(154, 166, 196), true);
}

void ClientApp::drawText(const std::string& value, unsigned int size, float x, float y,
                         sf::Color color, bool centered) {
    sf::Text text(value, font_, size);
    text.setFillColor(color);
    if (centered) {
        const sf::FloatRect bounds = text.getLocalBounds();
        text.setOrigin(bounds.left + bounds.width / 2.f, bounds.top + bounds.height / 2.f);
    }
    text.setPosition(x, y);
    window_.draw(text);
}

void ClientApp::drawPanel(const sf::FloatRect& bounds, sf::Color fill, sf::Color outline) {
    sf::RectangleShape panel({bounds.width, bounds.height});
    panel.setPosition(bounds.left, bounds.top);
    panel.setFillColor(fill);
    panel.setOutlineThickness(outline == sf::Color::Transparent ? 0.f : 2.f);
    panel.setOutlineColor(outline);
    window_.draw(panel);
}

bool ClientApp::mouseIn(const sf::FloatRect& bounds) const {
    const sf::Vector2i mouse = sf::Mouse::getPosition(window_);
    return bounds.contains(static_cast<float>(mouse.x), static_cast<float>(mouse.y));
}

std::string ClientApp::playerName(std::uint32_t id) const {
    for (const LobbyPlayer& player : lobbyPlayers_) {
        if (player.id == id) {
            return player.name;
        }
    }
    return "Player";
}

sf::Color ClientApp::playerColor(std::uint32_t id) const {
    if (id == myId_) {
        return sf::Color(79, 209, 197);
    }
    return sf::Color(231, 100, 145);
}

} // namespace coinrush

