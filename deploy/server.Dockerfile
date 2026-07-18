# syntax=docker/dockerfile:1

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS build

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      cmake \
      g++ \
      libsfml-dev \
      make \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt ./
COPY include ./include
COPY src ./src
COPY assets ./assets
RUN cmake -S . -B build \
      -DBUILD_TESTING=OFF \
      -DCMAKE_BUILD_TYPE=Release \
      -DCOINRUSH_FETCH_SFML=OFF \
 && cmake --build build --parallel

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS runtime

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libsfml-graphics2.5 \
      libsfml-network2.5 \
      libsfml-system2.5 \
      libsfml-window2.5 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/build/CoinRush /app/CoinRush
COPY --from=build /src/assets /app/assets
RUN chmod -R a+rX /app

USER 65532:65532
EXPOSE 53000/tcp
ENTRYPOINT ["/app/CoinRush"]
CMD ["--server", "53000"]
