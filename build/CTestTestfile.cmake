# CMake generated Testfile for 
# Source directory: /mnt/c/Users/jeffr/OneDrive/Documents/my-games/uber-game
# Build directory: /mnt/c/Users/jeffr/OneDrive/Documents/my-games/uber-game/build
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test([=[network_smoke]=] "/mnt/c/Users/jeffr/OneDrive/Documents/my-games/uber-game/build/CoinRush" "--smoke-test")
set_tests_properties([=[network_smoke]=] PROPERTIES  TIMEOUT "15" _BACKTRACE_TRIPLES "/mnt/c/Users/jeffr/OneDrive/Documents/my-games/uber-game/CMakeLists.txt;75;add_test;/mnt/c/Users/jeffr/OneDrive/Documents/my-games/uber-game/CMakeLists.txt;0;")
add_test([=[level_smoke]=] "/mnt/c/Users/jeffr/OneDrive/Documents/my-games/uber-game/build/CoinRush" "--level-test")
set_tests_properties([=[level_smoke]=] PROPERTIES  _BACKTRACE_TRIPLES "/mnt/c/Users/jeffr/OneDrive/Documents/my-games/uber-game/CMakeLists.txt;77;add_test;/mnt/c/Users/jeffr/OneDrive/Documents/my-games/uber-game/CMakeLists.txt;0;")
