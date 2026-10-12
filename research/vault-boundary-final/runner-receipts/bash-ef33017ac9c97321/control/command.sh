git checkout -- packages/pi/src/stream.ts && touch packages/pi/src/stream.ts; git diff --stat; python3 - <<'PY'
import hashlib,json,pathlib,shutil
source=pathlib.Path('.cortexkit/parent-inputs/vault-boundary-original-r1');m=json.loads((source/'MANIFEST.json').read_text());dst=pathlib.Path('research/vault-boundary-final/original-receipts');dst.mkdir(parents=True,exist_ok=True)
for t in m['tasks']:
 for f in t['files']:
  p=source/t['task']/f['path'];b=p.read_bytes();assert len(b)==f['bytes'] and hashlib.sha256(b).hexdigest()==f['sha256'];q=dst/t['task']/f['path'];q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b)
shutil.copyfile(source/'MANIFEST.json',dst/'MANIFEST.json')
print('Verified and copied 6 original task groups unchanged')
ns='782486840065a51d';rt=pathlib.Path('/Users/ufukaltinok/.local/share/cortexkit/aft/runner/bash-tasks')/ns;rd=pathlib.Path('research/vault-boundary-final/runner-receipts')
for task in rt.iterdir():
 if not task.is_dir():continue
 stdout=task/'io/stdout';stderr=task/'io/stderr'
 if not stdout.exists() or not stderr.exists():continue
 if 'bun test v1.4.2' not in stdout.read_text(errors='replace'):continue
 target=rd/task.name;target.mkdir(parents=True,exist_ok=True)
 for f in [stdout,stderr]:shutil.copyfile(f,target/f.name)
 print(ns+'/'+task.name)
PY