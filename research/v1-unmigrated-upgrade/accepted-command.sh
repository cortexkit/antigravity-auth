python3 - <<'PY'
from pathlib import Path
import hashlib, json
paths = ['packages/core/src/credential-redaction.ts', 'packages/core/src/index.ts', 'packages/opencode/src/plugin/shared/request-services.ts', 'packages/e2e-tests/src/v1-packed-vault-harness.ts', 'packages/e2e-tests/src/v1-packed-vault.e2e.test.ts', 'packages/e2e-tests/src/opencode-ga-harness.ts', 'packages/e2e-tests/src/opencode-ga-host-inputs.ts', 'packages/e2e-tests/src/v1-vault-activation-harness.ts', 'packages/opencode/src/server.ts', 'packages/opencode/src/plugin/index.ts', 'packages/core/src/common-auth-embedded/source-output.json', '.motor/hosts', 'packages/e2e-tests/src/fixtures/opencode-ga-host/package.json', 'packages/e2e-tests/src/fixtures/opencode-ga-host/bun.lock']
print('FINAL_SOURCE_SHA256_BEGIN')
print(json.dumps({p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in paths}, sort_keys=True))
print('FINAL_SOURCE_SHA256_END')
PY
rc=$?; if [ "$rc" -ne 0 ]; then exit "$rc"; fi
bun --version && GA_SOURCE_TREE=fb060a5a9bc82f15d746b9b09326514201ab867a bun test --isolate ./packages/e2e-tests/src/v1-packed-vault.e2e.test.ts && bun node_modules/typescript/bin/tsc --version && bun node_modules/typescript/bin/tsc -p tsconfig.scripts.json && bun node_modules/typescript/bin/tsc -p research/v1-packed-vault/tsconfig.json && ./node_modules/.bin/biome --version && ./node_modules/.bin/biome check packages/e2e-tests/src/v1-packed-vault-harness.ts packages/e2e-tests/src/v1-packed-vault.e2e.test.ts packages/e2e-tests/src/opencode-ga-host-inputs.ts packages/e2e-tests/src/opencode-ga-harness.ts packages/e2e-tests/src/v1-vault-activation-harness.ts --error-on-warnings