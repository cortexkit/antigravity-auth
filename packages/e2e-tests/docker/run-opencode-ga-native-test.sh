#!/usr/bin/env bash
set -euo pipefail

# Run inside the runner's per-job network namespace, never on the operator's host.
# Preparation uses only trusted frozen fixture dependencies and locally built packs.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
if [[ "${NODE_TLS_REJECT_UNAUTHORIZED+x}" == x || "${ANTIGRAVITY_GA_HOST_EXECUTION:-}" != 1 ]]; then
  echo 'Native GA preparation/execution requires explicit admission and no TLS bypass' >&2
  exit 2
fi
if [[ "$#" == 2 && "$1" == --prepare ]]; then
  MODE=--prepare-native
  PREFIX="$2"
  TARGET="$2"
  ARGS=("$MODE" "$TARGET")
elif [[ "$#" == 5 && "$1" == --run && "$4" == --inputs && "$5" == packages/* && "$5" != *..* ]]; then
  MODE=--run
  PREFIX="$2"
  TARGET="$3"
  git ls-files --error-unmatch "$5" >/dev/null
  ARGS=("$MODE" "$TARGET" --inputs "$5")
else
  echo 'usage: run-opencode-ga-native-test.sh --prepare <fresh-prefix> | --run <installed-prefix> <fresh-output-root> --inputs <tracked packages/... module>' >&2
  exit 2
fi
[[ "$PREFIX" == /* && "$TARGET" == /* && "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Native Linux x64 and absolute owned paths required' >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Native GA requires the clean composed checkout' >&2; exit 2; }
# The build runner reads .motor/hosts from the selected snapshot tree and appends it to
# this job's private read-only hosts file. The clean-tree check makes that input equal to HEAD.
# The harness still checks the actual aliases; a declaration alone proves no resolver behavior.
git ls-files --error-unmatch .motor/hosts >/dev/null
[[ -f .motor/hosts && ! -L .motor/hosts ]] || { echo 'Missing regular committed per-job hosts declaration' >&2; exit 2; }
[[ "$(git hash-object .motor/hosts)" == "$(git rev-parse HEAD:.motor/hosts)" ]] || { echo 'Per-job hosts declaration differs from HEAD' >&2; exit 2; }
REVISION="$(git rev-parse HEAD)"
TREE="$(git rev-parse 'HEAD^{tree}')"
BUN="$(command -v bun)"
command -v timeout >/dev/null
ENV_ROOT="$(mktemp -d /tmp/agy-ga-native-env.XXXXXXXX)"
mkdir -m 700 "$ENV_ROOT/home" "$ENV_ROOT/config" "$ENV_ROOT/data" "$ENV_ROOT/state" "$ENV_ROOT/cache" "$ENV_ROOT/tmp" "$ENV_ROOT/pi-agent" "$ENV_ROOT/pi-coding-agent"
printf 'Selected native source: commit=%s tree=%s\nOwned command profile: %s\n' "$REVISION" "$TREE" "$ENV_ROOT"
# Explicit execution permission is followed by live lo-only interfaces, child-inherited network
# isolation, blocked outbound connections and denied namespace escape before any host starts.
timeout --signal=TERM --kill-after=10s 1800s env -i \
  PATH="$(dirname "$BUN"):/usr/local/bin:/usr/bin:/bin" \
  HOME="$ENV_ROOT/home" USERPROFILE="$ENV_ROOT/home" \
  XDG_CONFIG_HOME="$ENV_ROOT/config" XDG_DATA_HOME="$ENV_ROOT/data" \
  XDG_STATE_HOME="$ENV_ROOT/state" XDG_CACHE_HOME="$ENV_ROOT/cache" TMPDIR="$ENV_ROOT/tmp" \
  PI_AGENT_DIR="$ENV_ROOT/pi-agent" PI_CODING_AGENT_DIR="$ENV_ROOT/pi-coding-agent" \
  OPENCODE_DB="$ENV_ROOT/data/opencode.db" LANG=C.UTF-8 TERM=xterm-256color \
  GA_CONTAINMENT_MODE=native-job ANTIGRAVITY_GA_HOST_EXECUTION=1 \
  GA_CONSUMER_PREFIX="$PREFIX" GA_SOURCE_REVISION="$REVISION" GA_SOURCE_TREE="$TREE" \
  "$BUN" packages/e2e-tests/src/opencode-ga-harness.ts "${ARGS[@]}"
