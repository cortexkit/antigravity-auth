"""Decode a bounded base64/zlib JSON map of exact stdout/stderr/exit bytes from an isolated test job."""
import base64
import json
import os
import pathlib
import stat
import sys
import zlib

OUTPUT = pathlib.Path('research/remaining-node20-cancellation/receipts')
MAX_ENCODED_BYTES = 2 * 1024 * 1024
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_FILES = 64
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def decode_receipt(encoded):
    if len(encoded) > MAX_ENCODED_BYTES:
        raise ValueError('encoded receipt exceeds the size limit')
    compact = b''.join(encoded.split())
    compressed = base64.b64decode(compact, validate=True)
    inflater = zlib.decompressobj()
    decoded = inflater.decompress(compressed, MAX_JSON_BYTES + 1)
    if len(decoded) > MAX_JSON_BYTES or inflater.unconsumed_tail:
        raise ValueError('decoded receipt exceeds the size limit')
    if not inflater.eof or inflater.unused_data:
        raise ValueError('incomplete or trailing compressed data')
    files = json.loads(decoded, object_pairs_hook=unique_object)
    if not isinstance(files, dict) or not files or len(files) > MAX_FILES:
        raise ValueError('receipt must be a nonempty bounded file map')
    prepared = []
    targets = set()
    for name, value in files.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise ValueError('receipt paths and byte strings must be strings')
        path = pathlib.Path(name)
        if path.is_absolute() or '..' in path.parts or '\x00' in name:
            raise ValueError('absolute, parent-traversal, or NUL paths are forbidden')
        if not path.is_relative_to(OUTPUT) or path == OUTPUT:
            raise ValueError('path is outside the owned receipt directory')
        if len(path.parts) > 32 or any(len(os.fsencode(part)) > 255 for part in path.parts):
            raise ValueError('receipt path exceeds filesystem limits')
        if path in targets:
            raise ValueError('duplicate normalized receipt path')
        targets.add(path)
        prepared.append((path, value.encode('latin1')))
    for path, _ in prepared:
        if any(parent in targets for parent in path.parents):
            raise ValueError('receipt file/directory path conflict')
        check_existing_path(path)
    return prepared


def check_existing_path(path):
    current = pathlib.Path('.')
    for index, part in enumerate(path.parts):
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode):
            raise ValueError('symlink traversal or targets are forbidden')
        if index < len(path.parts) - 1 and not stat.S_ISDIR(mode):
            raise ValueError('receipt ancestor is not a directory')
        if index == len(path.parts) - 1 and not stat.S_ISREG(mode):
            raise ValueError('receipt target is not a regular file')


def write_receipt(path, data):
    directory = os.open('.', DIRECTORY_FLAGS)
    try:
        for part in path.parts[:-1]:
            try:
                child = os.open(part, DIRECTORY_FLAGS, dir_fd=directory)
            except FileNotFoundError:
                os.mkdir(part, dir_fd=directory)
                child = os.open(part, DIRECTORY_FLAGS, dir_fd=directory)
            os.close(directory)
            directory = child
        # No-follow descriptors keep a newly introduced symlink from redirecting writes.
        target = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
                         0o644, dir_fd=directory)
        with os.fdopen(target, 'wb') as output:
            output.write(data)
    finally:
        os.close(directory)


def main():
    encoded = sys.stdin.buffer.read(MAX_ENCODED_BYTES + 1)
    prepared = decode_receipt(encoded)
    for path, data in prepared:
        write_receipt(path, data)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, zlib.error, RecursionError) as error:
        raise SystemExit(f'receipt import rejected: {error}')
