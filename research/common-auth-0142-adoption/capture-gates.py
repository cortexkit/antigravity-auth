#!/usr/bin/env python3
"""Record build, type and embedding tests with raw stdout/stderr and exit statuses."""
import argparse
import base64
import json
import pathlib
import subprocess
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('selection', choices=['narrow', 'strict', 'fixtures', 'boundary'])
parser.add_argument('--packed-output', action='store_true')
args = parser.parse_args()
commands = {
    'boundary': [
        ['bun', '--version'],
        ['node_modules/.bin/tsc', '--version'],
        ['node_modules/.bin/tsc', '-p', 'test/common-auth-0113-producer/tsconfig.source.json'],
        ['bun', 'run', '--cwd', 'packages/core', 'build'],
        ['bun', 'test', '--isolate', 'packages/opencode/scripts/build-tui.test.ts'],
    ],
    'narrow': [
        ['bun', '--version'],
        ['node', '--version'],
        ['node_modules/.bin/tsc', '--version'],
        ['bun', 'run', 'embed:check'],
        ['node_modules/.bin/tsc', '-p', 'test/common-auth-0113-producer/tsconfig.source.json'],
        ['node_modules/.bin/tsc', '-p', 'test/common-auth-094-adoption/embed-build/tsconfig.declarations.json'],
        ['bun', 'packages/opencode/scripts/build-tui.ts', '--types'],
        ['bun', 'test', '--config=test/common-auth-0113-producer/bunfig.toml', '--isolate',
         'test/common-auth-0113-producer/closure.test.ts',
         'packages/core/src/__fixtures__/common-auth-public-consumer-admission.test.ts'],
    ],
    'strict': [
        ['bun', '--version'],
        ['node_modules/.bin/tsc', '--version'],
        ['bun', 'run', 'build'],
        ['bun', 'run', 'typecheck'],
    ],
    'fixtures': [
        ['bun', '--version'],
        ['docker', 'version'],
        ['bun', 'test', '--isolate', 'test/common-auth-094-adoption/embed-build/'],
    ],
}
results = []
for command in commands[args.selection]:
    try:
        result = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=600)
        record = {'command': command, 'exitStatus': result.returncode,
                  'stdout': result.stdout.decode(), 'stderr': result.stderr.decode()}
    except FileNotFoundError as error:
        record = {'command': command, 'exitStatus': 127, 'stdout': '', 'stderr': str(error)}
    except subprocess.TimeoutExpired as error:
        record = {'command': command, 'exitStatus': 124,
                  'stdout': (error.stdout or b'').decode(), 'stderr': (error.stderr or b'').decode()}
    results.append(record)
    if args.packed_output:
        print(json.dumps({'command': command, 'exitStatus': record['exitStatus'],
                          'zlibBase64': base64.b64encode(zlib.compress(json.dumps(record).encode())).decode()}), flush=True)
    else:
        print(json.dumps(record), flush=True)
    if record['exitStatus'] and args.selection != 'fixtures':
        break
path = ROOT / 'research/common-auth-0142-adoption/evidence' / (args.selection + '.json')
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(results, indent=2) + '\n')
raise SystemExit(1 if any(record['exitStatus'] for record in results) else 0)
