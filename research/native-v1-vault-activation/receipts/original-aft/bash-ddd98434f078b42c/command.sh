bun --version && bun run --cwd packages/core build && python3 - <<'PY'
import subprocess,pathlib,json,base64,gzip
root=pathlib.Path('research/native-v1-vault-activation/receipts')
p=subprocess.run(['bun','test','--isolate','./packages/e2e-tests/src/v1-vault-activation.e2e.test.ts'],capture_output=True,text=True)
print('MUTATION TEST EXIT',p.returncode)
print(p.stderr)
for line in p.stdout.splitlines():
    if line.startswith('NATIVE_V1_RECEIPT_GZIP_BASE64 '):
        r=json.loads(gzip.decompress(base64.b64decode(line.split(' ',1)[1])))
        print('MUTATION LOCAL FILE SYSCALLS',json.dumps(r['localFileSyscalls']))
        print('MUTATION OTHER PROPERTIES',json.dumps({'error':r.get('error'),'authAbsentBefore':r['authAbsentBefore'],'requestCount':len(r['requests']),'allReaped':all(c['reaped'] for c in r['processes']),'stdout':next(c['stdout'] for c in r['processes'] if c['name']=='first-request')}))
    else: print(line)
assert p.returncode==1
assert '1 fail' in p.stderr and '0 pass' in p.stderr
assert 'localFileSyscalls' in p.stderr
PY