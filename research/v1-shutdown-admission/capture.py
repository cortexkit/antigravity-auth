"""Record each verification command's exact stdout, stderr, and inner exit."""

import json
from pathlib import Path
import subprocess
import sys

label = sys.argv[1]
commands = json.loads(sys.argv[2])
receipt = Path(__file__).with_name(f"{label}.inner.jsonl")
exit_code = 0
with receipt.open("w") as log:
    for command in commands:
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired as expired:
            def decode(value):
                return value.decode() if isinstance(value, bytes) else (value or "")
            row = json.dumps({
                "command": command,
                "stdout": decode(expired.stdout),
                "stderr": decode(expired.stderr),
                "inner_exit": None,
                "timeout_seconds": 180,
            })
            log.write(row + "\n")
            print(row, flush=True)
            sys.exit(124)
        row = json.dumps({
            "command": command,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "inner_exit": result.returncode,
        })
        log.write(row + "\n")
        log.flush()
        print(row, flush=True)
        if result.returncode:
            exit_code = result.returncode
            if not label.startswith("control-"):
                break
sys.exit(exit_code)
