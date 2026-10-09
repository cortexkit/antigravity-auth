#!/usr/bin/env bash
set -euo pipefail

# Runs the 102-case OpenCode 2.0.22 GA suite in a network-less container.
# This is the GA runner; run-opencode-v2-test.sh and its Dockerfile and
# harness exercise the earlier 2.0 beta adapter and are expected to be
# removed together when the package switches to GA, not kept as an alias.
# --inputs names the committed module exporting createGaHostIntegrationInputs
# (packages/e2e-tests/src/opencode-ga-inputs.ts).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IMAGE="antigravity-auth-e2e-ga"
[[ "$#" == 2 && "$1" == --inputs && "$2" == packages/* && "$2" != *..* ]] || {
  echo 'usage: run-opencode-ga-test.sh --inputs <committed packages/... input module>' >&2
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
trap 'rm -rf "$CONTEXT"' EXIT
# Only committed files enter the build context, so an ignored or untracked
# local file cannot supply a pin, fixture or measurement.
git -C "$REPO_ROOT" archive "$REVISION" | tar -x -C "$CONTEXT"
for input in \
  packages/e2e-tests/docker/ga-binary-pin.json \
  packages/opencode/docs/opencode2-ga-2.0.22-contract.md \
  packages/e2e-tests/docker/ga-proxy-env-matrix.json \
  packages/e2e-tests/docker/ga-proxy-env-matrix.provenance.json; do
  [[ -s "$CONTEXT/$input" ]] || { echo "Missing GA join input: $input" >&2; exit 2; }
done

command -v timeout >/dev/null 2>&1 || { echo 'GNU timeout is required on the native measuring host' >&2; exit 2; }
RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/agy-ga-results.XXXXXXXX")"
printf 'GA evidence output: %s\n' "$RESULTS"
timeout --signal=TERM --kill-after=10s 1200s docker build --platform linux/amd64 \
  --build-arg "SOURCE_REVISION=$REVISION" \
  --file "$CONTEXT/packages/e2e-tests/docker/opencode-ga/Dockerfile" \
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
  --env ANTIGRAVITY_GA_HOST_EXECUTION=1 \
  "$IMAGE"
