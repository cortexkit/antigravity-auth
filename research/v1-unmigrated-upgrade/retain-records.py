import base64
import gzip
import hashlib
import json
import shutil
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parent
source = Path('/Users/ufukaltinok/.local/share/cortexkit/aft/runner/bash-tasks/c1cd4f2098959f91')
manifest = {}
for task in sorted(source.iterdir()):
    metadata_path = task / 'control/metadata.json'
    if not metadata_path.is_file():
        continue
    metadata = json.loads(metadata_path.read_bytes())
    if metadata.get('status') not in ('completed', 'failed') or metadata.get('exit_code') is None:
        continue
    destination = root / 'original-aft/c1cd4f2098959f91' / task.name
    for part in ['control/command.sh', 'control/metadata.json', 'io/stdout', 'io/stderr', 'io/exit', 'io/pipeline-status']:
        original = task / part
        if not original.is_file():
            continue
        copied = destination / part
        copied.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, copied)
        manifest[str(copied.relative_to(root))] = {
            'bytes': copied.stat().st_size,
            'sha256': hashlib.sha256(copied.read_bytes()).hexdigest(),
        }
    stdout = (task / 'io/stdout').read_text()
    marker = 'UNMIGRATED_UPGRADE_RECEIPT_GZIP_BASE64_BEGIN\n'
    if marker in stdout and '\nUNMIGRATED_UPGRADE_RECEIPT_GZIP_BASE64_END' in stdout:
        encoded = stdout.split(marker, 1)[1].split('\nUNMIGRATED_UPGRADE_RECEIPT_GZIP_BASE64_END', 1)[0]
        compressed = base64.b64decode(encoded, validate=True)
        receipt = gzip.decompress(compressed)
        decoded = root / 'decoded' / task.name
        decoded.mkdir(parents=True, exist_ok=True)
        (decoded / 'receipt.json.gz').write_bytes(compressed)
        (decoded / 'receipt.json').write_bytes(receipt)
    print(task.name, metadata['exit_code'], metadata.get('remote', {}).get('job_id'))
(root / 'original-record-hashes.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Retained and hashed {len(manifest)} original record files')
with tarfile.open(root / 'original-aft.tar.gz', 'w:gz') as archive:
    for name in sorted(manifest):
        archive.add(root / name, arcname=name, recursive=False)
archive_path = root / 'original-aft.tar.gz'
(root / 'original-archive.json').write_text(json.dumps({
    'path': archive_path.name,
    'bytes': archive_path.stat().st_size,
    'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
    'files': len(manifest),
    'contents': 'Byte-identical original-aft/c1cd4f2098959f91 TerminalRecord tree; unpack within this evidence directory',
}, indent=2) + '\n')
