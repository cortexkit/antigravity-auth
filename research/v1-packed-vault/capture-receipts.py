#!/usr/bin/env python3
"""Copy original AFT command/exit/output records and decode this gate's receipts."""
import base64
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sys

recorder = Path(sys.argv[1])
output = Path(__file__).resolve().parent / "receipts"
output.mkdir(exist_ok=True)
records = []
for task in sorted(recorder.iterdir(), key=lambda path: path.stat().st_mtime):
    metadata_path = task / "control/metadata.json"
    if not metadata_path.exists():
        continue
    metadata = json.loads(metadata_path.read_text())
    if not metadata.get("remote"):
        continue
    command = metadata["command"]
    if "v1-packed-vault" not in command and "opencode-ga-harness.test.ts" not in command:
        continue
    destination = output / "original-aft" / task.name
    hashes = {}
    # Environment snapshots and retry requests are intentionally not part of the packet.
    for name in ["control/command.sh", "control/metadata.json", "io/stdout", "io/stderr"]:
        source = task / name
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        assert hashlib.sha256(target.read_bytes()).hexdigest() == digest
        hashes[name] = digest
    stdout = (task / "io/stdout").read_text()
    stderr = (task / "io/stderr").read_text()
    entry = {
        "task_id": task.name,
        "original_path": str(task),
        "copied_path": str(destination.relative_to(output.parent)),
        "command": command,
        "outer_exit": metadata["exit_code"],
        "remote_terminal": metadata["remote"]["terminal"],
        "sha256": hashes,
        "test_summary": [line for line in stderr.splitlines() if line.startswith(("(pass)", "(fail)", "Ran ")) or line.strip().endswith((" pass", " fail", " expect() calls", " filtered out"))],
    }
    if "PACKED_V1_RECEIPT_GZIP_BASE64=" in stdout:
        encoded = stdout.split("PACKED_V1_RECEIPT_GZIP_BASE64=", 1)[1].splitlines()[0]
    elif "PACKED_V1_RECEIPT_GZIP_BASE64_BEGIN" in stdout:
        encoded = "".join(stdout.split("PACKED_V1_RECEIPT_GZIP_BASE64_BEGIN", 1)[1].split("PACKED_V1_RECEIPT_GZIP_BASE64_END", 1)[0].split())
    else:
        encoded = None
    if encoded:
        decoded = gzip.decompress(base64.b64decode(encoded))
        decoded_path = output / (task.name + ".json")
        decoded_path.write_bytes(decoded)
        receipt = json.loads(decoded)
        entry["decoded_sha256"] = hashlib.sha256(decoded).hexdigest()
        entry["decoded_path"] = str(decoded_path.relative_to(output.parent))
        entry["native_exits"] = [{key: child[key] for key in ["name", "exitCode", "signal", "timedOut", "reaped"]} for child in receipt["processes"]]
        entry["archive"] = receipt["archive"]
        entry["binary"] = receipt["binary"]
        entry["packs"] = receipt["packs"]
        entry["installed"] = receipt["installed"]
        entry["source_hashes"] = receipt["sourceHashes"]
        entry["wire_hashes"] = receipt.get("wireHashes", [])
        entry["error"] = receipt.get("error")
        entry["server_arm_control"] = receipt.get("serverArmControl")
        entry["slot_controls"] = [{key: control[key] for key in ["name", "requests", "exitCode", "marker"]} | {key: control[key] for key in ["nonce", "wireHashes"] if key in control} for control in receipt["controls"]]
        entry["primary_requests"] = len(receipt["requests"])
        evidence = output / "decoded" / task.name
        evidence.mkdir(parents=True, exist_ok=True)
        for child in receipt["processes"]:
            for channel in ["stdout", "stderr"]:
                (evidence / (child["name"] + "." + channel)).write_text(child[channel])
        for name, trace in receipt["traces"].items():
            (evidence / (name + ".syscalls")).write_text(trace)
        (evidence / "primary-wire.json").write_text(json.dumps(receipt["requests"], indent=2) + "\n")
        (evidence / "vault-calls.json").write_text(json.dumps(receipt["vaultCalls"], indent=2) + "\n")
        for control in receipt["controls"]:
            (evidence / (control["name"] + ".json")).write_text(json.dumps(control, indent=2) + "\n")
    records.append(entry)
(output / "recorder-bindings.json").write_text(json.dumps(records, indent=2) + "\n")
print(f"Preserved {len(records)} remote tasks with byte-verified original command/metadata/stdout/stderr copies")
for record in records:
    print(record["task_id"], record["outer_exit"], record["remote_terminal"]["tree_hash"], record.get("primary_requests"), record.get("server_arm_control") is not None)
