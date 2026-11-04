#!/usr/bin/env bash
set -euo pipefail

# Runs the OpenCode 2.0.22 single-request smoke or extended suite with no network.
# --inputs names the committed module exporting createGaHostIntegrationInputs
# (packages/e2e-tests/src/opencode-ga-inputs.ts).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IMAGE="antigravity-auth-e2e-ga"
BASE_IMAGE_DIGEST="sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
ECR_BASE_IMAGE="public.ecr.aws/docker/library/node:24-bookworm-slim@${BASE_IMAGE_DIGEST}"
MIRROR_BASE_IMAGE="mirror.gcr.io/library/node@${BASE_IMAGE_DIGEST}"
HOST_TEST_MODE="--run"
if [[ "${1:-}" == --smoke ]]; then
  HOST_TEST_MODE="--smoke"
  shift
fi
[[ "$#" == 2 && "$1" == --inputs && "$2" == packages/* && "$2" != *..* ]] || {
  echo 'usage: run-opencode-ga-test.sh [--smoke] --inputs <committed packages/... input module>' >&2
  exit 2
}
HOST_INPUT_MODULE="$2"
git -C "$REPO_ROOT" ls-files --error-unmatch "$HOST_INPUT_MODULE" >/dev/null

if [[ "${NODE_TLS_REJECT_UNAUTHORIZED+x}" == x ]]; then
  echo 'NODE_TLS_REJECT_UNAUTHORIZED presence forbids host launch' >&2
  exit 2
fi
command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 2; }
HOST_UNAME="$(uname -m)"
DAEMON_ARCH="$(docker info --format '{{.Architecture}}')"
if [[ "$HOST_UNAME" != x86_64 || ( "$DAEMON_ARCH" != x86_64 && "$DAEMON_ARCH" != amd64 ) ]]; then
  echo "not native x86_64: host=$HOST_UNAME daemon=$DAEMON_ARCH; platform flags cannot exclude QEMU" >&2
  exit 2
fi
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  echo 'GA clean-room runner requires a clean committed checkout' >&2
  exit 2
fi
REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid checkout revision' >&2; exit 2; }
CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/agy-ga-context.XXXXXXXX")"
# macOS /bin/bash 3.2 runs an EXIT trap with status 0 when `set -u` stops the
# script, so a run that never reached the end would report success. The trap
# keeps any failing status and turns a 0 without `finished=1` into exit 1.
finished=0
cleanup() {
  local status=$?
  rm -rf "$CONTEXT"
  if [[ "$status" -eq 0 && "$finished" -ne 1 ]]; then
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
# Only committed files enter the build context, so an ignored or untracked
# local file cannot supply a pin, fixture or measurement.
git -C "$REPO_ROOT" archive "$REVISION" | tar -x -C "$CONTEXT"
DOCKERFILE="$CONTEXT/packages/e2e-tests/docker/opencode-ga/Dockerfile"
if ! grep -Fqx "ARG BASE_IMAGE=$ECR_BASE_IMAGE" \
  "$DOCKERFILE"; then
  echo 'Dockerfile base image default does not match the runner digest' >&2
  exit 2
fi
INPUTS=(
  packages/e2e-tests/docker/ga-binary-pin.json
  packages/opencode/docs/opencode2-ga-2.0.22-contract.md
)
if [[ "$HOST_TEST_MODE" == --run ]]; then
  INPUTS+=(
    packages/e2e-tests/docker/ga-proxy-env-matrix.json
    packages/e2e-tests/docker/ga-proxy-env-matrix.provenance.json
  )
fi
for input in "${INPUTS[@]}"; do
  [[ -s "$CONTEXT/$input" ]] || { echo "Missing GA join input: $input" >&2; exit 2; }
done

command -v timeout >/dev/null 2>&1 || { echo 'GNU timeout is required on the native measuring host' >&2; exit 2; }
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/agy-ga-results.XXXXXXXX")"
printf 'GA evidence output: %s\n' "$RESULTS"
LAST_PULL_ERROR=""
pull_base_image() {
  local image_ref="$1"
  local attempt output exit_code
  local -a backoff_seconds=(10 30)
  for attempt in 1 2 3; do
    printf 'Pulling GA base image %s (attempt %s/3)\n' "$image_ref" "$attempt" >&2
    if output="$(timeout --signal=TERM --kill-after=10s 300s docker pull --platform linux/amd64 "$image_ref" 2>&1)"; then
      printf '%s\n' "$output"
      LAST_PULL_ERROR=""
      return 0
    else
      exit_code=$?
      printf '%s\n' "$output" >&2
      LAST_PULL_ERROR="${output##*$'\n'}"
      [[ -n "$LAST_PULL_ERROR" ]] || LAST_PULL_ERROR="docker pull exited with status $exit_code"
    fi
    if (( attempt < 3 )); then
      sleep "${backoff_seconds[$((attempt - 1))]}"
    fi
  done
  return 1
}
BASE_IMAGE_REF=""
if pull_base_image "$ECR_BASE_IMAGE"; then
  BASE_IMAGE_REF="$ECR_BASE_IMAGE"
elif pull_base_image "$MIRROR_BASE_IMAGE"; then
  BASE_IMAGE_REF="$MIRROR_BASE_IMAGE"
else
  printf 'Unable to pull GA base image from %s or %s. Last error: %s\n' \
    "$ECR_BASE_IMAGE" "$MIRROR_BASE_IMAGE" "$LAST_PULL_ERROR" >&2
  exit 1
fi
timeout --signal=TERM --kill-after=10s 1200s docker build --pull=false --platform linux/amd64 \
  --build-arg "BASE_IMAGE=$BASE_IMAGE_REF" \
  --build-arg "SOURCE_REVISION=$REVISION" \
  --file "$DOCKERFILE" \
  --tag "$IMAGE" "$CONTEXT"
# Provenance is measured here, outside the container. An arm64 controller must
# invoke this runner on the independent native machine, not label QEMU as native.
timeout --signal=TERM --kill-after=10s 1800s docker run --rm --network none --platform linux/amd64 \
  --mount "type=bind,source=$RESULTS,target=/results" \
  --add-host daily-cloudcode-pa.googleapis.com:127.0.0.1 \
  --add-host cloudcode-pa.googleapis.com:127.0.0.1 \
  --env "GA_HOST_UNAME=$HOST_UNAME" \
  --env "GA_DAEMON_ARCH=$DAEMON_ARCH" \
  --env "GA_SOURCE_REVISION=$REVISION" \
  --env "GA_HOST_INPUT_MODULE=$HOST_INPUT_MODULE" \
  --env "GA_HOST_TEST_MODE=$HOST_TEST_MODE" \
  --env ANTIGRAVITY_GA_HOST_EXECUTION=1 \
  "$IMAGE"

finished=1
