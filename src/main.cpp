#include "ClientApp.hpp"
#include "GameServer.hpp"
#include "Protocol.hpp"

#include <SFML/Network.hpp>

#include <atomic>
#include <chrono>
#include <csignal>
#include <iostream>
#include <string>
#include <thread>

namespace {

std::atomic<bool> keepRunning{true};

void stopSignal(int) {
    keepRunning = false;
}

bool receiveMessage(sf::TcpSocket& socket, coinrush::Message expected,
                    std::chrono::milliseconds timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        sf::Packet packet;
        const sf::Socket::Status status = socket.receive(packet);
        if (status == sf::Socket::Done) {
            sf::Uint8 rawType = 0;
            if ((packet >> rawType) && static_cast<coinrush::Message>(rawType) == expected) {
                return true;
            }
        } else if (status == sf::Socket::Disconnected || status == sf::Socket::Error) {
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return false;
}

int runSmokeTest() {
    coinrush::GameServer server;
    std::string error;
    if (!server.start(0, error)) {
        std::cerr << "Smoke test: server start failed: " << error << '\n';
        return 1;
    }

    sf::TcpSocket first;
    sf::TcpSocket second;
    if (first.connect(sf::IpAddress::LocalHost, server.port(), sf::seconds(2.f)) != sf::Socket::Done ||
        second.connect(sf::IpAddress::LocalHost, server.port(), sf::seconds(2.f)) != sf::Socket::Done) {
        std::cerr << "Smoke test: loopback connection failed.\n";
        return 1;
    }

    sf::Packet firstHello = coinrush::helloPacket("Smoke One");
    sf::Packet secondHello = coinrush::helloPacket("Smoke Two");
    if (first.send(firstHello) != sf::Socket::Done || second.send(secondHello) != sf::Socket::Done) {
        std::cerr << "Smoke test: hello packet failed.\n";
        return 1;
    }
    first.setBlocking(false);
    second.setBlocking(false);

    if (!receiveMessage(first, coinrush::Message::Welcome, std::chrono::seconds(2)) ||
        !receiveMessage(second, coinrush::Message::Welcome, std::chrono::seconds(2))) {
        std::cerr << "Smoke test: clients did not receive a welcome packet.\n";
        return 1;
    }

    sf::Packet firstReady = coinrush::readyPacket(true);
    sf::Packet secondReady = coinrush::readyPacket(true);
    first.send(firstReady);
    second.send(secondReady);

    if (!receiveMessage(first, coinrush::Message::GameStart, std::chrono::seconds(3)) ||
        !receiveMessage(second, coinrush::Message::GameStart, std::chrono::seconds(3))) {
        std::cerr << "Smoke test: ready players did not enter the match.\n";
        return 1;
    }

    first.disconnect();
    second.disconnect();
    server.stop();
    std::cout << "Network smoke test passed: host, join, lobby, ready, and game start.\n";
    return 0;
}

unsigned short parsePort(const char* text) {
    try {
        const unsigned long parsed = std::stoul(text);
        if (parsed <= 65535 && parsed > 0) {
            return static_cast<unsigned short>(parsed);
        }
    } catch (...) {
    }
    return 0;
}

int runDedicatedServer(unsigned short port) {
    coinrush::GameServer server;
    std::string error;
    if (!server.start(port, error)) {
        std::cerr << error << '\n';
        return 1;
    }

    std::signal(SIGINT, stopSignal);
    std::signal(SIGTERM, stopSignal);
    std::cout << "Coin Rush server listening on 0.0.0.0:" << server.port() << " (TCP)\n"
              << "Press Ctrl+C to stop.\n";
    while (keepRunning) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    server.stop();
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    if (argc >= 2 && std::string(argv[1]) == "--smoke-test") {
        return runSmokeTest();
    }
    if (argc >= 2 && std::string(argv[1]) == "--server") {
        const unsigned short port = argc >= 3 ? parsePort(argv[2]) : coinrush::DefaultPort;
        if (port == 0) {
            std::cerr << "Usage: CoinRush --server [port from 1 to 65535]\n";
            return 2;
        }
        return runDedicatedServer(port);
    }
    if (argc >= 2 && (std::string(argv[1]) == "--help" || std::string(argv[1]) == "-h")) {
        std::cout << "Coin Rush\n"
                  << "  CoinRush                 Start the graphical client\n"
                  << "  CoinRush --server PORT   Start a headless dedicated server\n"
                  << "  CoinRush --smoke-test    Test the loopback lobby flow\n";
        return 0;
    }

    coinrush::ClientApp app;
    return app.run();
}

