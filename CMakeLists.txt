cmake_minimum_required(VERSION 3.20)

project(CoinRush VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(COINRUSH_FETCH_SFML "Download SFML 2.6.2 when it is not installed" ON)

find_package(SFML 2.5 COMPONENTS graphics window network system QUIET)

if(NOT SFML_FOUND)
    if(NOT COINRUSH_FETCH_SFML)
        message(FATAL_ERROR "SFML 2.5+ was not found. Install it or configure with COINRUSH_FETCH_SFML=ON.")
    endif()

    include(FetchContent)
    set(SFML_BUILD_AUDIO OFF CACHE BOOL "" FORCE)
    set(SFML_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(SFML_BUILD_DOC OFF CACHE BOOL "" FORCE)
    set(SFML_BUILD_NETWORK ON CACHE BOOL "" FORCE)
    FetchContent_Declare(
        SFML
        GIT_REPOSITORY https://github.com/SFML/SFML.git
        GIT_TAG 2.6.2
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(SFML)

    if(APPLE)
        set(SFML_CG_CONVERSION_FILE
            "${sfml_SOURCE_DIR}/src/SFML/Window/OSX/cg_sf_conversion.mm")
        include(cmake/PatchSFMLMacOS.cmake)
    endif()
endif()

add_executable(CoinRush
    src/main.cpp
    src/GameServer.cpp
    src/ClientApp.cpp
    src/TileMap.cpp
)

target_include_directories(CoinRush PRIVATE include)
target_link_libraries(CoinRush PRIVATE sfml-graphics sfml-window sfml-network sfml-system)
target_compile_definitions(CoinRush PRIVATE COINRUSH_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")

add_custom_command(TARGET CoinRush POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        ${CMAKE_CURRENT_SOURCE_DIR}/assets
        $<TARGET_FILE_DIR:CoinRush>/assets
)

if(MSVC)
    target_compile_options(CoinRush PRIVATE /W4 /permissive-)
else()
    target_compile_options(CoinRush PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(WIN32 AND BUILD_SHARED_LIBS)
    add_custom_command(TARGET CoinRush POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            $<TARGET_FILE:sfml-graphics>
            $<TARGET_FILE:sfml-window>
            $<TARGET_FILE:sfml-network>
            $<TARGET_FILE:sfml-system>
            $<TARGET_FILE_DIR:CoinRush>
        COMMAND_EXPAND_LISTS
    )
endif()

include(CTest)
if(BUILD_TESTING)
    add_test(NAME network_smoke COMMAND CoinRush --smoke-test)
    set_tests_properties(network_smoke PROPERTIES TIMEOUT 15)
    add_test(NAME level_smoke COMMAND CoinRush --level-test)
endif()
