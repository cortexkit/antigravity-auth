"""Standalone CLI controls for bounded receipt decoding and no-write rejection."""
import base64
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import zlib

IMPORTER = pathlib.Path(__file__).with_name('import-receipt.py').resolve()
PREFIX = 'research/remaining-node20-cancellation/receipts'


def payload(files):
    return base64.b64encode(zlib.compress(json.dumps(files).encode()))


def snapshot(root):
    result = {}
    for path in root.rglob('*'):
        name = str(path.relative_to(root))
        if path.is_symlink():
            result[name] = ('symlink', str(path.readlink()))
        elif path.is_dir():
            result[name] = ('directory',)
        else:
            result[name] = ('file', path.read_bytes())
    return result


class ReceiptImportControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)

    def run_import(self, encoded):
        return subprocess.run([sys.executable, str(IMPORTER)], input=encoded,
                              cwd=self.root, capture_output=True, timeout=10)

    def assert_no_write(self, encoded):
        before = snapshot(self.root)
        result = self.run_import(encoded)
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertEqual(snapshot(self.root), before)

    def test_valid_import_preserves_all_raw_bytes(self):
        raw = bytes(range(256)) + b'\r\n\x00\xff'
        files = {
            f'{PREFIX}/valid/stdout.txt': raw.decode('latin1'),
            f'{PREFIX}/valid/stderr.txt': 'error\r\n',
            f'{PREFIX}/valid/exit-code.txt': '1\n',
        }
        encoded = payload(files)
        wrapped = b'\n'.join(encoded[index:index + 120] for index in range(0, len(encoded), 120))
        result = self.run_import(wrapped)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / f'{PREFIX}/valid/stdout.txt').read_bytes(), raw)
        self.assertEqual((self.root / f'{PREFIX}/valid/stderr.txt').read_bytes(), b'error\r\n')
        self.assertEqual((self.root / f'{PREFIX}/valid/exit-code.txt').read_bytes(), b'1\n')

    def test_rejects_parent_traversal_before_any_writes(self):
        self.assert_no_write(payload({
            f'{PREFIX}/valid/stdout.txt': 'must not be written',
            f'{PREFIX}/../../escape.txt': 'must not escape',
        }))

    def test_rejects_absolute_paths_before_any_writes(self):
        outside = self.root / 'outside.txt'
        outside.write_bytes(b'original')
        self.assert_no_write(payload({
            f'{PREFIX}/valid/stdout.txt': 'must not be written',
            str(outside): 'must not replace',
        }))

    def test_rejects_symlink_ancestors_and_targets_before_any_writes(self):
        outside = self.root / 'outside'
        outside.mkdir()
        target = outside / 'target.txt'
        target.write_bytes(b'original')
        owned = self.root / PREFIX / 'links'
        owned.mkdir(parents=True)
        (owned / 'directory').symlink_to(outside, target_is_directory=True)
        (owned / 'file.txt').symlink_to(target)
        (owned / 'dangling.txt').symlink_to(outside / 'absent.txt')
        for path in ['directory/target.txt', 'file.txt', 'dangling.txt']:
            with self.subTest(path=path):
                self.assert_no_write(payload({
                    f'{PREFIX}/valid/{path.replace("/", "_")}.txt': 'must not be written',
                    f'{PREFIX}/links/{path}': 'must not follow symlink',
                }))

    def test_rejects_a_symlink_owned_root_before_any_writes(self):
        outside = self.root / 'outside'
        outside.mkdir()
        parent = self.root / 'research/remaining-node20-cancellation'
        parent.mkdir(parents=True)
        (parent / 'receipts').symlink_to(outside, target_is_directory=True)
        self.assert_no_write(payload({f'{PREFIX}/valid/stdout.txt': 'must not follow root'}))

    def test_rejects_invalid_maps_and_compression_before_any_writes(self):
        valid_path = f'{PREFIX}/valid/stdout.txt'
        duplicate = ('{"' + valid_path + '":"first","' + valid_path + '":"second"}').encode()
        cases = [
            b'not-base64!',
            base64.b64encode(zlib.compress(b'{')),
            base64.b64encode(zlib.compress(duplicate)),
            base64.b64encode(zlib.compress(b'{}') + b'trailing'),
            payload({valid_path: 'valid', f'{PREFIX}/bad/value.txt': 1}),
            payload({valid_path: 'valid', f'{PREFIX}/bad/value.txt': '\u2603'}),
            payload({f'{PREFIX}/conflict': 'file', f'{PREFIX}/conflict/child.txt': 'child'}),
            payload({valid_path: 'first', f'{PREFIX}/valid/./stdout.txt': 'duplicate'}),
        ]
        for encoded in cases:
            with self.subTest(encoded_size=len(encoded)):
                self.assert_no_write(encoded)

    def test_rejects_oversized_encoded_and_expanded_payloads_before_any_writes(self):
        self.assert_no_write(b'A' * (2 * 1024 * 1024 + 1))
        self.assert_no_write(payload({
            f'{PREFIX}/valid/stdout.txt': 'must not be written',
            f'{PREFIX}/oversized/stderr.txt': 'x' * (8 * 1024 * 1024 + 1),
        }))

    def test_rejects_too_many_files_before_any_writes(self):
        self.assert_no_write(payload({f'{PREFIX}/many/{index}.txt': 'x' for index in range(65)}))


if __name__ == '__main__':
    unittest.main()
