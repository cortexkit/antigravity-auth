bun --version && bun run --cwd packages/core build && python3 - <<'PY'
import subprocess,json,base64,gzip
p=subprocess.run(['bun','test','--isolate','./packages/e2e-tests/src/v1-vault-activation.e2e.test.ts'],capture_output=True,text=True)
print('NETWORK MUTATION TEST EXIT',p.returncode)
print(p.stderr)
for line in p.stdout.splitlines():
 if line.startswith('NATIVE_V1_RECEIPT_GZIP_BASE64 '):
  r=json.loads(gzip.decompress(base64.b64decode(line.split(' ',1)[1])))
  print('NETWORK MUTATION OBSERVATIONS',json.dumps([e for e in r['observations'] if e['kind']=='forbidden-network']))
  print('NETWORK MUTATION OTHER PROPERTIES',json.dumps({'error':r.get('error'),'requestCount':len(r['requests']),'allReaped':all(c['reaped'] for c in r['processes']),'localFileSyscalls':r['localFileSyscalls']}))
 else: print(line)
assert p.returncode==1 and '1 fail' in p.stderr and '0 pass' in p.stderr
assert 'forbidden-network' in p.stderr
PY