#!/usr/bin/env bash
set -u
label="$1"
shift
directory="research/remaining-node20-cancellation/receipts/$label"
mkdir -p "$directory"
printf '%q ' "$@" > "$directory/command.sh"
printf '\n' >> "$directory/command.sh"
"$@" > "$directory/stdout.txt" 2> "$directory/stderr.txt"
code=$?
printf '%s\n' "$code" > "$directory/exit-code.txt"
python3 - "$directory" <<'PY'
import base64, json, pathlib, sys, textwrap, zlib
directory = pathlib.Path(sys.argv[1])
for name in ('stdout.txt', 'stderr.txt', 'exit-code.txt'):
    print(f'--- {directory / name} ---', flush=True)
    sys.stdout.buffer.write((directory / name).read_bytes())
    sys.stdout.flush()
files = {str(path): path.read_bytes().decode('latin1')
         for path in directory.iterdir() if path.is_file()}
payload = base64.b64encode(zlib.compress(json.dumps(files).encode())).decode()
print('RECEIPT_BASE64:')
print('\n'.join(textwrap.wrap(payload, 120)))
PY
exit "$code"
