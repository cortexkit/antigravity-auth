bun --version && bun node_modules/typescript/bin/tsc --version && ./node_modules/.bin/biome --version && bun run --cwd packages/core build && bun node_modules/typescript/bin/tsc -p tsconfig.scripts.json && bun node_modules/typescript/bin/tsc -p research/native-v1-vault-activation/tsconfig.json && ./node_modules/.bin/biome check packages/e2e-tests/src/v1-vault-activation-harness.ts packages/e2e-tests/src/v1-vault-activation.e2e.test.ts --error-on-warnings && bun -e "import {resolve} from 'node:path'; console.log('NORMAL PUBLIC MODULE', Bun.resolveSync('@cortexkit/subc-client',resolve('packages/e2e-tests/src')));" && python3 - <<'PY'
import subprocess,json,base64,gzip
p=subprocess.run(['bun','test','--isolate','./packages/e2e-tests/src/v1-vault-activation.e2e.test.ts'],capture_output=True,text=True)
print('NORMAL ROOT JOIN TEST EXIT',p.returncode)
print(p.stderr)
for line in p.stdout.splitlines():
 if line.startswith('NATIVE_V1_RECEIPT_GZIP_BASE64 '):
  r=json.loads(gzip.decompress(base64.b64decode(line.split(' ',1)[1])))
  print('ROOT JOIN SOURCE',json.dumps(r['snapshot']))
  print('ROOT JOIN OBSERVATIONS',json.dumps({'error':r.get('error'),'runtime':r['runtime'],'binary':r['binary'],'authAbsentBefore':r['authAbsentBefore'],'marker':r.get('marker'),'requests':r['requests'],'localFileSyscalls':r['localFileSyscalls']}))
  print('ROOT JOIN OWNERSHIP',json.dumps([{k:c[k] for k in ['name','exitCode','signal','reaped','ownership','signals','signalFailures']} for c in r['processes']]))
  print('ROOT JOIN CLI RAW',json.dumps(next(c for c in r['processes'] if c['name']=='first-request')))
 else: print(line)
raise SystemExit(p.returncode)
PY