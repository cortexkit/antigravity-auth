"""Compare archived stdout/stderr/exit files with original command-runner recordings.

Preserve earlier failures without rerunning tests against code that has since changed.
"""
import base64
import hashlib
import json
import pathlib
import shlex
import zlib

ROOT = pathlib.Path('/Users/ufukaltinok/.local/share/cortexkit/aft/runner/bash-tasks/fee2450c165a28e5')
EVIDENCE = pathlib.Path('research/remaining-node20-cancellation')
CASES = {
    'C0-missing-any-baseline': 'bash-aa8ddf392fe99e16',
    'C0-build-and-missing-any-baseline': 'bash-7abb17dbfdc2bed7',
    'C0-missing-any': 'bash-9763f4e4012b0459',
    'C1-caller-at-headers': 'bash-b3e2c90e83ee291d',
    'C2-deadline-after-headers': 'bash-8268c4b715cfb6af',
    'C3-forwarder-removal': 'bash-9270ab0e42ef5b59',
    'C4-body-completion-removal': 'bash-b388c98e48e56381',
    'C5-pi-final-removal': 'bash-a7e421d9d1a0187c',
    'C6-idle-cleanup-baseline': 'bash-94dcf9b3e93c05da',
    'C7-request-inheritance': 'bash-52d0a368ba76dcd6',
    'P1-targeted-gates': 'bash-e5d7f924fbfe5789',
    'P2-targeted-gates': 'bash-9b1a7431419ad904',
    'P3-targeted-gates': 'bash-dae35e9f84099118',
    'P4-targeted-gates': 'bash-aceb01ed902a0fdb',
    'P7-final-gates': 'bash-0dfffb0485d6a2f3',
    'P8-final-gates': 'bash-685d3b9b5afea962',
    'P10-reviewed-http-tests': 'bash-9abc729afa84179b',
    'P9-reviewed-http-tests': 'bash-52191dd9e6d6e823',
    'P11-import-safety': 'bash-7ffd27ae11065418',
    'P12-final-import-safety': 'bash-4a864cce4ae8a301',
    'C8-import-traversal': 'bash-918aafa290e7049d',
    'C9-import-symlink-preflight': 'bash-b29fab99c8f7ab01',
    'C10-import-symlink-independent': 'bash-7013194700bf7357',
}
DOUBLE_BASE64 = {'C0-missing-any', 'P1-targeted-gates', 'P2-targeted-gates', 'P3-targeted-gates'}
RECOVER = {'C0-missing-any-baseline', 'C0-build-and-missing-any-baseline', 'P2-targeted-gates', 'P3-targeted-gates', 'P9-reviewed-http-tests', 'P10-reviewed-http-tests', 'P11-import-safety', 'P12-final-import-safety', 'C8-import-traversal', 'C9-import-symlink-preflight', 'C10-import-symlink-independent'}
bindings = []
for label, task_id in CASES.items():
    task = ROOT / task_id
    metadata_path = task / 'control/metadata.json'
    metadata = json.loads(metadata_path.read_text())
    recorded = (task / 'io/stdout').read_bytes()
    if b'RECEIPT_BASE64=' in recorded:
        packet = recorded.split(b'RECEIPT_BASE64=', 1)[1]
    elif b'RECEIPT_BASE64:\n' in recorded:
        packet = recorded.split(b'RECEIPT_BASE64:\n', 1)[1]
    else:
        packet = None
    if packet:
        payload = json.loads(zlib.decompress(base64.b64decode(packet)))
        inner = {pathlib.Path(name).name:
                 (base64.b64decode(value) if label in DOUBLE_BASE64 else value.encode('latin1'))
                 for name, value in payload.items()}
    else:
        inner = {}
        prefix = f'research/remaining-node20-cancellation/receipts/{label}'
        for name, next_name in [('stdout.txt', 'stderr.txt'), ('stderr.txt', 'exit-code.txt')]:
            marker = f'--- {prefix}/{name} ---\n'.encode()
            end = f'--- {prefix}/{next_name} ---\n'.encode()
            inner[name] = recorded.split(marker, 1)[1].split(end, 1)[0]
        exit_marker = f'--- {prefix}/exit-code.txt ---\n'.encode()
        inner['exit-code.txt'] = recorded.split(exit_marker, 1)[1]
    inner_exit = int(inner['exit-code.txt'].strip())
    terminal_exit = metadata['remote']['terminal']['outcome']['code']
    assert inner_exit == metadata['exit_code'] == terminal_exit
    directory = EVIDENCE / 'receipts' / label
    if label in RECOVER:
        directory.mkdir(parents=True, exist_ok=True)
        for name, raw in inner.items():
            (directory / name).write_bytes(raw)
        (directory / 'aft-command.txt').write_text(metadata['command'] + '\n')
    comparison = {}
    for name, raw in inner.items():
        path = directory / name
        if path.exists():
            comparison[name] = {
                'original_sha256': hashlib.sha256(raw).hexdigest(),
                'retained_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'byte_identical': path.read_bytes() == raw,
            }
            if name in {'stdout.txt', 'stderr.txt', 'exit-code.txt'}:
                assert comparison[name]['byte_identical']
            if name == 'command.sh':
                comparison[name]['argv_identical'] = shlex.split(path.read_text()) == shlex.split(raw.decode())
                assert comparison[name]['argv_identical']
    binding = {
        'case': label,
        'task_id': task_id,
        'original_metadata': str(metadata_path),
        'original_outer_stdout': str(task / 'io/stdout'),
        'original_outer_stderr': str(task / 'io/stderr'),
        'outer_exit_code': metadata['exit_code'],
        'remote_job_id': metadata['remote']['job_id'],
        'remote_terminal_exit_code': terminal_exit,
        'inner_exit_code': inner_exit,
        'retained_copies': comparison,
    }
    bindings.append(binding)
    print(f'{label}: {task_id}, inner/outer/remote exit {inner_exit}, retained stdout/stderr/exit byte-identical')
(EVIDENCE / 'recorder-bindings.json').write_text(json.dumps(bindings, indent=2) + '\n')
print(f'Bound {len(bindings)} original recorder cases; recovered {len(RECOVER)} original captures; reran no gates.')
