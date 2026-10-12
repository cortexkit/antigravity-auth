bun --version && bun node_modules/typescript/bin/tsc --version && ./node_modules/.bin/biome --version && bun run --cwd packages/core build && bun node_modules/typescript/bin/tsc -p research/native-v1-vault-activation/tsconfig.json && ./node_modules/.bin/biome check packages/e2e-tests/src/v1-vault-activation-harness.ts packages/e2e-tests/src/v1-vault-activation.e2e.test.ts --error-on-warnings && python3 - <<'PY'
import subprocess,json,base64,gzip
p=subprocess.run(['bun','test','--isolate','./packages/e2e-tests/src/v1-vault-activation.e2e.test.ts'],capture_output=True,text=True)
print('FINAL NATIVE TEST EXIT',p.returncode)
print(p.stderr)
for line in p.stdout.splitlines():
 if line.startswith('NATIVE_V1_RECEIPT_GZIP_BASE64 '):
  r=json.loads(gzip.decompress(base64.b64decode(line.split(' ',1)[1])))
  print('FINAL SUMMARY',json.dumps({k:r[k] for k in ['snapshot','runtime','binary','profile','authAbsentBefore','localArtifactsAbsentBefore','marker','requests','observations','vaultCalls','localFileSyscalls','syscallRecords','streamBytes']}))
  print('FINAL NATIVE PROCESSES',json.dumps([{k:c[k] for k in ['name','pid','exitCode','signal','timedOut','reaped']} for c in r['processes']]))
  print('FINAL FIRST REQUEST RAW',json.dumps(next(c for c in r['processes'] if c['name']=='first-request')))
 else: print(line)
raise SystemExit(p.returncode)
PY