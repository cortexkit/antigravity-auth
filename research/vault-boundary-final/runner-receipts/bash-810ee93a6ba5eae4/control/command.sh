git checkout -- packages/pi/src/stream.ts packages/pi/src/commands.ts packages/opencode/src/plugin/shared/request-services.ts && touch packages/pi/src/stream.ts packages/pi/src/commands.ts packages/opencode/src/plugin/shared/request-services.ts; git diff --stat; python3 - <<'PY'
import pathlib,shutil,json
namespace='782486840065a51d';src=pathlib.Path('/Users/ufukaltinok/.local/share/cortexkit/aft/runner/bash-tasks')/namespace;dst=pathlib.Path('research/vault-boundary-final/runner-receipts');dst.mkdir(parents=True,exist_ok=True)
for task in src.iterdir():
 if not task.is_dir():continue
 stdout=task/'io/stdout';stderr=task/'io/stderr'
 if not stdout.exists() or not stderr.exists():continue
 out=stdout.read_text(errors='replace');err=stderr.read_text(errors='replace')
 if 'bun test v1.4.2' not in out or 'credential' not in err:continue
 target=dst/task.name;target.mkdir(exist_ok=True)
 for f in [stdout,stderr]:shutil.copyfile(f,target/f.name)
 for f in task.iterdir():
  if f.is_file() and f.stat().st_size<100000:shutil.copyfile(f,target/f.name)
 print(json.dumps({'namespace':namespace,'task_id':task.name,'files':[p.name for p in target.iterdir()]}))
PY