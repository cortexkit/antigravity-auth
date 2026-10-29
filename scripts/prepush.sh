#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
phase=preflight
step=arguments
started=$SECONDS

fail() {
  echo "PREPUSH_FAILED phase=$phase step=$step: $*" >&2
  exit 1
}

run_step() {
  step=$1
  shift
  local code=0
  echo "PREPUSH_STEP phase=$phase step=$step command=$*"
  "$@" || code=$?
  echo "PREPUSH_EXIT phase=$phase step=$step exit=$code"
  if (( code != 0 )); then
    fail "exit=$code elapsed=$((SECONDS - started))s"
  fi
}

clean_tree() {
  local dirty
  dirty=$(git status --porcelain --untracked-files=no)
  [[ -z "$dirty" ]] || fail "dirty tracked tree; commit or restore changes first:
$dirty"
}

same_commit() {
  clean_tree
  [[ $(git rev-parse HEAD) == "$commit" ]] || fail 'HEAD changed during the gate'
}

ci_only() {
  echo 'Covered by GitHub CI only: OpenCode 2 Docker smoke (MOTOR has no Docker).'
  echo 'Covered by GitHub CI only: four-runtime RPC matrix (Node 20.0.0, Node 24.16.0, Bun 1.3.14, Bun 1.4.2 are not provisioned together by this job).'
  echo 'Covered by GitHub CI only: Windows vault, account migration and Pi privacy jobs (windows-latest and windows-2022).'
}

mode=${1:-}
case "$mode" in
  ''|--fast) [[ $# -le 1 ]] || fail 'usage: bun run prepush [--fast]' ;;
  --full-here) [[ $# -le 2 ]] || fail 'usage: bash scripts/prepush.sh --full-here [commit]' ;;
  *) fail 'usage: bun run prepush [--fast] or bash scripts/prepush.sh --full-here' ;;
esac

step=clean-tree
clean_tree
commit=$(git rev-parse HEAD)
step=bun-version
[[ $(bun --version) == 1.4.2 ]] || fail 'requires Bun 1.4.2 exactly'

ci_only
if [[ "$mode" == --full-here ]]; then
  phase=full
  step=linux-identity
  [[ $(uname -s) == Linux ]] || fail 'full phase requires MOTOR Linux'
  [[ "$commit" == "${2:-$commit}" ]] || fail 'MOTOR checkout does not match submitted commit'
  run_step install bun install --frozen-lockfile
  run_step embed-input bun packages/opencode/scripts/embed-common-auth.ts --check
  run_step tui-compiler bun install --cwd tools/common-auth-build --frozen-lockfile --ignore-scripts
  run_step embed bun run embed:check
  # The core build deletes dist; keep every dependent step sequential.
  run_step core-build bun run --cwd packages/core build
  run_step typecheck bun run typecheck
  run_step build bun run build
  run_step tui-smoke bun run --cwd packages/opencode smoke:tui
  run_step test bun run test
  run_step test-e2e bun run test:e2e
  step=final-identity
  same_commit
  echo "PREPUSH_FULL_OK $commit elapsed=$((SECONDS - started))s"
  echo "PREPUSH_OK $commit"
  exit 0
fi

phase=fast
step=cortexkit-tracking
tracked_ignored=$(git ls-files -ci --exclude-standard -- .cortexkit)
[[ -z "$tracked_ignored" ]] || fail "ignored .cortexkit files are tracked:
$tracked_ignored"
echo 'PREPUSH_EXIT phase=fast step=cortexkit-tracking exit=0'
run_step lockfile bun install --frozen-lockfile --dry-run
run_step compiler-lockfile bun install --cwd tools/common-auth-build --frozen-lockfile --dry-run --ignore-scripts
run_step embed bun run embed:check
run_step format bun run format:check
# Both root scripts already include lint:native-inert.
run_step lint bun run lint
run_step disk-test-list bun test --isolate ./test/test-root.test.ts
run_step import-graph bun test --isolate ./packages/opencode/src/plugin/shared/import-graph.test.ts
run_step sync-spawn bun test --isolate ./test/sync-spawn-guard.test.ts
step=final-identity
same_commit
echo "PREPUSH_FAST_OK $commit elapsed=$((SECONDS - started))s"
if [[ "$mode" == --fast ]]; then
  echo 'Full Linux phase not run (--fast); this is not a complete pre-push pass.'
  exit 0
fi

phase=motor
step=submit
command -v ck >/dev/null || fail 'ck is required to submit the MOTOR Linux job'
# Use the same qualified 16-vCPU MOTOR placement as test:native-inert.
# Network access is needed for the frozen installs, not for a different runner.
run_step linux-job ck motor run --vcpus 16 --net --cwd "$PWD" -- bash scripts/prepush.sh --full-here "$commit"
step=final-identity
same_commit
echo "PREPUSH_OK $commit elapsed=$((SECONDS - started))s"
