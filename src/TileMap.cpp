#include "TileMap.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>

#ifndef COINRUSH_SOURCE_DIR
#define COINRUSH_SOURCE_DIR "."
#endif

namespace coinrush {
namespace {

std::string trim(std::string value) {
    const auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char character) {
        return std::isspace(character);
    });
    const auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char character) {
        return std::isspace(character);
    }).base();
    if (first >= last) {
        return {};
    }
    return std::string(first, last);
}

sf::Vector2f tileCenter(unsigned int x, unsigned int y) {
    return {(static_cast<float>(x) + 0.5f) * TileMap::TileSize,
            (static_cast<float>(y) + 0.5f) * TileMap::TileSize};
}

} // namespace

bool TileMap::loadBundledCastle(std::string& error) {
    const std::vector<std::string> candidates = {
        "assets/levels/castle.csv",
        "../assets/levels/castle.csv",
        bundledPath("assets/levels/castle.csv")
    };
    for (const std::string& path : candidates) {
        std::ifstream input(path);
        if (input.good()) {
            input.close();
            return loadCsv(path, error);
        }
    }
    error = "Could not find assets/levels/castle.csv.";
    return false;
}

bool TileMap::loadCsv(const std::string& path, std::string& error) {
    std::ifstream input(path);
    if (!input) {
        error = "Could not open level file: " + path;
        return false;
    }

    std::vector<std::vector<std::uint16_t>> rows;
    std::string line;
    std::size_t lineNumber = 0;
    while (std::getline(input, line)) {
        ++lineNumber;
        line = trim(line);
        if (line.empty() || line.front() == '#') {
            continue;
        }

        std::vector<std::uint16_t> row;
        std::stringstream stream(line);
        std::string cell;
        while (std::getline(stream, cell, ',')) {
            cell = trim(cell);
            if (cell.empty()) {
                continue;
            }
            try {
                const unsigned long value = std::stoul(cell);
                if (value > 65535) {
                    throw std::out_of_range("tile id");
                }
                row.push_back(static_cast<std::uint16_t>(value));
            } catch (...) {
                error = "Invalid tile ID on line " + std::to_string(lineNumber) + " of " + path + ".";
                return false;
            }
        }

        if (!row.empty()) {
            if (!rows.empty() && row.size() != rows.front().size()) {
                error = "Level rows have different widths on line " + std::to_string(lineNumber) + ".";
                return false;
            }
            rows.push_back(std::move(row));
        }
    }

    if (rows.empty() || rows.front().empty()) {
        error = "The level contains no tile rows: " + path;
        return false;
    }

    width_ = static_cast<unsigned int>(rows.front().size());
    height_ = static_cast<unsigned int>(rows.size());
    tiles_.clear();
    tiles_.reserve(static_cast<std::size_t>(width_) * height_);
    playerSpawns_.clear();
    coinSpawns_.clear();

    for (unsigned int y = 0; y < height_; ++y) {
        for (unsigned int x = 0; x < width_; ++x) {
            const std::uint16_t tile = rows[y][x];
            tiles_.push_back(tile);
            if (tile == PlayerOneSpawn || tile == PlayerTwoSpawn) {
                const std::size_t slot = tile == PlayerOneSpawn ? 0 : 1;
                if (playerSpawns_.size() <= slot) {
                    playerSpawns_.resize(slot + 1);
                }
                playerSpawns_[slot] = tileCenter(x, y);
            } else if (tile == CoinSpawn) {
                coinSpawns_.push_back(tileCenter(x, y));
            }
        }
    }

    if (playerSpawns_.size() < 2 || coinSpawns_.empty()) {
        error = "The level needs tile IDs 5 and 6 for player spawns and at least one tile ID 7 for coins.";
        return false;
    }

    rebuildGeometry();
    return true;
}

bool TileMap::loadTileset(const std::string& path) {
    auto texture = std::make_unique<sf::Texture>();
    hasTexture_ = texture->loadFromFile(path);
    if (hasTexture_) {
        texture->setSmooth(false);
        tileset_ = std::move(texture);
        rebuildGeometry();
    } else {
        tileset_.reset();
    }
    return hasTexture_;
}

bool TileMap::loadBundledTileset() {
    const std::vector<std::string> candidates = {
        "assets/tileset.png",
        "../assets/tileset.png",
        bundledPath("assets/tileset.png")
    };
    for (const std::string& path : candidates) {
        std::ifstream input(path, std::ios::binary);
        if (input.good()) {
            input.close();
            return loadTileset(path);
        }
    }
    return false;
}

void TileMap::draw(sf::RenderTarget& target) const {
    if (hasTexture_) {
        target.draw(geometry_, sf::RenderStates(tileset_.get()));
    } else {
        drawProcedural(target);
    }
}

bool TileMap::isSolid(int tileX, int tileY) const {
    if (tileX < 0 || tileX >= static_cast<int>(width_) || tileY >= static_cast<int>(height_)) {
        return true;
    }
    if (tileY < 0) {
        return false;
    }
    const std::uint16_t tile = tileAt(tileX, tileY);
    return tile == Stone || tile == Brick || tile == Platform;
}

std::uint16_t TileMap::tileAt(int tileX, int tileY) const {
    if (tileX < 0 || tileY < 0 || tileX >= static_cast<int>(width_) || tileY >= static_cast<int>(height_)) {
        return Empty;
    }
    return tiles_[static_cast<std::size_t>(tileY) * width_ + static_cast<std::size_t>(tileX)];
}

unsigned int TileMap::width() const { return width_; }
unsigned int TileMap::height() const { return height_; }

sf::Vector2f TileMap::worldSize() const {
    return {static_cast<float>(width_ * TileSize), static_cast<float>(height_ * TileSize)};
}

sf::Vector2f TileMap::playerSpawn(std::size_t slot) const {
    return slot < playerSpawns_.size() ? playerSpawns_[slot] : sf::Vector2f(64.f, 64.f);
}

const std::vector<sf::Vector2f>& TileMap::coinSpawns() const { return coinSpawns_; }
bool TileMap::usingTexture() const { return hasTexture_; }

void TileMap::rebuildGeometry() {
    geometry_.clear();
    if (!hasTexture_ || width_ == 0 || height_ == 0) {
        return;
    }

    const unsigned int columns = std::max(1u, tileset_->getSize().x / TileSize);
    for (unsigned int y = 0; y < height_; ++y) {
        for (unsigned int x = 0; x < width_; ++x) {
            const std::uint16_t tile = tileAt(static_cast<int>(x), static_cast<int>(y));
            if (tile < Stone || tile > Window) {
                continue;
            }
            const unsigned int textureIndex = tile - 1;
            const float textureX = static_cast<float>((textureIndex % columns) * TileSize);
            const float textureY = static_cast<float>((textureIndex / columns) * TileSize);
            const float worldX = static_cast<float>(x * TileSize);
            const float worldY = static_cast<float>(y * TileSize);

            geometry_.append({{worldX, worldY}, {textureX, textureY}});
            geometry_.append({{worldX + TileSize, worldY}, {textureX + TileSize, textureY}});
            geometry_.append({{worldX + TileSize, worldY + TileSize}, {textureX + TileSize, textureY + TileSize}});
            geometry_.append({{worldX, worldY + TileSize}, {textureX, textureY + TileSize}});
        }
    }
}

void TileMap::drawProcedural(sf::RenderTarget& target) const {
    for (unsigned int y = 0; y < height_; ++y) {
        for (unsigned int x = 0; x < width_; ++x) {
            const std::uint16_t tile = tileAt(static_cast<int>(x), static_cast<int>(y));
            if (tile < Stone || tile > Window) {
                continue;
            }

            sf::RectangleShape shape({static_cast<float>(TileSize), static_cast<float>(TileSize)});
            shape.setPosition(static_cast<float>(x * TileSize), static_cast<float>(y * TileSize));
            shape.setOutlineThickness(-1.f);
            if (tile == Stone) {
                shape.setFillColor(sf::Color(58, 57, 76));
                shape.setOutlineColor(sf::Color(85, 81, 102));
            } else if (tile == Brick) {
                shape.setFillColor(sf::Color(91, 51, 61));
                shape.setOutlineColor(sf::Color(137, 75, 79));
            } else if (tile == Platform) {
                shape.setFillColor(sf::Color(119, 92, 69));
                shape.setOutlineColor(sf::Color(183, 146, 98));
            } else {
                shape.setFillColor(sf::Color(30, 39, 69));
                shape.setOutlineColor(sf::Color(64, 70, 104));
            }
            target.draw(shape);

            if (tile == Brick && (x + y) % 2 == 0) {
                sf::RectangleShape mortar({static_cast<float>(TileSize) / 2.f, 2.f});
                mortar.setPosition(static_cast<float>(x * TileSize), static_cast<float>(y * TileSize + TileSize / 2));
                mortar.setFillColor(sf::Color(55, 37, 49));
                target.draw(mortar);
            }
        }
    }
}

std::string TileMap::bundledPath(const std::string& relative) {
    return std::string(COINRUSH_SOURCE_DIR) + "/" + relative;
}

} // namespace coinrush
