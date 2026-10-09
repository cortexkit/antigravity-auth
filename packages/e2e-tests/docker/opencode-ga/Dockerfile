# ECR serves the same official Node image index as Docker Hub, without a Hub pull.
FROM public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG SOURCE_REVISION
ENV GA_SOURCE_REVISION="${SOURCE_REVISION}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssl unzip util-linux \
  && rm -rf /var/lib/apt/lists/*

# Verify the publisher's checksum manifest before it authorizes archive extraction.
RUN curl --fail --location --max-time 120 \
      https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/SHASUMS256.txt \
      --output /tmp/SHASUMS256.txt \
  && echo '99ebf3e6afe003b57eae3f257abce7e9aa851452429e84ef16b1b401e9d7cff1  /tmp/SHASUMS256.txt' | sha256sum --check - \
  && curl --fail --location --max-time 120 \
      https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip \
      --output /tmp/bun-linux-x64.zip \
  && (cd /tmp && sha256sum --check --ignore-missing SHASUMS256.txt) \
  && unzip -q /tmp/bun-linux-x64.zip -d /tmp/bun-release \
  && install -m 0755 /tmp/bun-release/bun-linux-x64/bun /usr/local/bin/bun \
  && test "$(bun --version)" = 1.4.2 \
  && rm -rf /tmp/bun-release /tmp/bun-linux-x64.zip /tmp/SHASUMS256.txt
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile \
  && bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts \
  && bun run build

# Bootstrap validates the tracked manifest, SRI before decoding the archive,
# executable digest/ELF before any host use, and installs the actual packed
# package/dependency closure outside /workspace. It runs no OpenCode process.
RUN bun packages/e2e-tests/src/opencode-ga-harness.ts --prepare-image /opt/ga-consumer
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"

# Network and pinned-name loopback mappings are supplied only by the runner.
# No production trust store is modified; each child gets its owned startup CA.
CMD ["bash", "-c", "test -n \"${GA_HOST_INPUT_MODULE:?approved integration input module is required}\" && exec bun packages/e2e-tests/src/opencode-ga-harness.ts \"${GA_HOST_TEST_MODE:---run}\" /results --inputs \"$GA_HOST_INPUT_MODULE\""]
