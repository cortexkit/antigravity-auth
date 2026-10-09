# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.14-debian AS bun
FROM node:24-bookworm-slim
ARG SOURCE_REVISION
ENV GA_SOURCE_REVISION="${SOURCE_REVISION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssl util-linux \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile \
  && bun run build

# Bootstrap validates the tracked manifest, SRI before decoding the archive,
# executable digest/ELF before any host use, and installs the actual packed
# package/dependency closure outside /workspace. It runs no OpenCode process.
RUN bun packages/e2e-tests/src/opencode-ga-harness.ts --prepare-image /opt/ga-consumer
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"

# Network and pinned-name loopback mappings are supplied only by the runner.
# No production trust store is modified; each child gets its owned startup CA.
CMD ["bash", "-c", "test -n \"${GA_HOST_INPUT_MODULE:?approved integration input module is required}\" && exec bun packages/e2e-tests/src/opencode-ga-harness.ts \"${GA_HOST_TEST_MODE:---run}\" /results --inputs \"$GA_HOST_INPUT_MODULE\""]
