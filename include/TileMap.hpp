#pragma once

#include <SFML/Graphics.hpp>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace coinrush {

class TileMap {
public:
    static constexpr unsigned int TileSize = 32;
    static constexpr std::uint16_t Empty = 0;
    static constexpr std::uint16_t Stone = 1;
    static constexpr std::uint16_t Brick = 2;
    static constexpr std::uint16_t Platform = 3;
    static constexpr std::uint16_t Window = 4;
    static constexpr std::uint16_t PlayerOneSpawn = 5;
    static constexpr std::uint16_t PlayerTwoSpawn = 6;
    static constexpr std::uint16_t CoinSpawn = 7;

    bool loadBundledCastle(std::string& error);
    bool loadCsv(const std::string& path, std::string& error);
    bool loadTileset(const std::string& path);
    bool loadBundledTileset();

    void draw(sf::RenderTarget& target) const;
    bool isSolid(int tileX, int tileY) const;
    std::uint16_t tileAt(int tileX, int tileY) const;

    unsigned int width() const;
    unsigned int height() const;
    sf::Vector2f worldSize() const;
    sf::Vector2f playerSpawn(std::size_t slot) const;
    const std::vector<sf::Vector2f>& coinSpawns() const;
    bool usingTexture() const;

private:
    void rebuildGeometry();
    void drawProcedural(sf::RenderTarget& target) const;
    static std::string bundledPath(const std::string& relative);

    unsigned int width_{0};
    unsigned int height_{0};
    std::vector<std::uint16_t> tiles_;
    std::vector<sf::Vector2f> playerSpawns_;
    std::vector<sf::Vector2f> coinSpawns_;
    std::unique_ptr<sf::Texture> tileset_;
    sf::VertexArray geometry_{sf::Quads};
    bool hasTexture_{false};
};

} // namespace coinrush
