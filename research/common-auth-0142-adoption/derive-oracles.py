#!/usr/bin/env python3
"""Derive file identities and import reachability from pinned common-auth 0.14.2 archive bytes, not generated embeddings."""
import argparse
import base64
import gzip
import hashlib
import io
import json
import pathlib
import posixpath
import re
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
ARCHIVE = ROOT / 'tools/common-auth-build/inputs/cortexkit-common-auth-0.14.2.tgz'
PIN = 'bf0f0828d155183dec1c29e5277ededd6cbd46e6b839ca696434e477f081216b'
TAR_PIN = '8e7844ad61e2161a3110c9146e4da5e1f508261ce897603457f8056cf7274661'
PUBLIC_ROOTS = (
    './rpc', './rpc/client', './logger', './tui', './store', './fs',
    './claustrum', './commands', './auth-menu', './routing', './quota',
    './opencode2', './pi-slot',
)
CORE_ROOTS = ('./store', './fs', './claustrum', './commands', './auth-menu',
              './routing', './quota', './pi-slot')
EDGE = re.compile(r"^(?:import|export)\s[^\n]*?\bfrom\s+['\"]([^'\"\n]+)['\"];?\s*$", re.M)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def specifiers(data):
    return sorted(set(EDGE.findall(data.decode())))


def reach(entries, starts):
    pending = list(starts)
    files, external = set(), set()
    while pending:
        path = pending.pop()
        if path in files:
            continue
        data = entries['package/dist/' + path]
        files.add(path)
        for edge in specifiers(data):
            if not edge.startswith('.'):
                external.add(edge)
                continue
            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), edge))
            assert not target.startswith('../')
            if path.endswith('.d.ts'):
                target = re.sub(r'\.js$', '.d.ts', target)
            pending.append(target)
    return sorted(files), sorted(external)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true', help='replace active frozen test oracles')
    args = parser.parse_args()
    archive = ARCHIVE.read_bytes()
    assert len(archive) == 251088 and digest(archive) == PIN
    tar = gzip.decompress(archive)
    assert digest(tar) == TAR_PIN
    with tarfile.open(fileobj=io.BytesIO(tar)) as package:
        members = package.getmembers()
        assert all(member.isfile() for member in members)
        entries = {member.name: package.extractfile(member).read() for member in members}
        assert len(entries) == len(members) == 189
    assert sum(map(len, entries.values())) == 930861
    manifest = json.loads(entries['package/package.json'])
    assert manifest['name'] == '@cortexkit/common-auth' and manifest['version'] == '0.14.2'
    public = {name: manifest['exports'][name] for name in PUBLIC_ROOTS}
    starts = [path.removeprefix('./dist/') for targets in public.values() for path in targets.values()]
    files, external = reach(entries, starts)
    records = [[path, len(entries['package/dist/' + path]), digest(entries['package/dist/' + path])]
               for path in files]
    publication = {
        'version': manifest['version'], 'artifactStatus': 'released',
        'archiveBytes': len(archive), 'sha256': PIN,
        'sri': 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode(),
        'manifestSha256': digest(entries['package/package.json']),
        'inventorySha256': digest(('\n'.join(sorted(entries)) + '\n').encode()),
        'licenseSha256': digest(entries['package/LICENSE']),
        'canonicalFiles': len(files), 'canonicalBytes': sum(record[1] for record in records),
        'publicRoots': public, 'files': records,
    }
    closure = {
        'schema': 1, 'fileIdentityOracle': 'test/common-auth-0113-producer/publication.json',
        'resolution': 'Resolve relative .js specifiers from declarations to .d.ts; runtime edges retain .js. Lists are deduplicated. Files absent from imports have no static import/re-export edges.',
        'nonlocalStaticImports': external,
        'dynamicImports': {'tui/index.js': {
            'loader': 'import(entry) through the caller-supplied/default importModule',
            'runtimeProbe': 'opentui:runtime-module:%40opentui%2Fsolid',
            'entries': ['caller rawEntry', 'caller runtimeEntry'], 'localStaticTargets': [],
        }},
        'slimRuntimeFiles': reach(entries, ['rpc/client.js', 'tui/index.js'])[0],
        'routingFiles': [path for path in files if path.startswith('routing/')],
        'imports': {path: specifiers(entries['package/dist/' + path]) for path in files
                    if specifiers(entries['package/dist/' + path])},
    }
    core_starts = [path.removeprefix('./dist/') for name in CORE_ROOTS
                   for path in public[name].values()]
    core_files, core_external = reach(entries, core_starts)
    assert core_files == [path for path in files if not re.match(r'^(?:rpc|tui|opencode2)/', path)]
    report = {
        'archiveBytes': len(archive), 'archiveSha256': PIN, 'tarSha256': TAR_PIN,
        'archiveFiles': len(entries), 'archivePayloadBytes': sum(map(len, entries.values())),
        'publishedExports': list(manifest['exports']),
        'selectedPublicRoots': list(public), 'canonicalFiles': len(files),
        'canonicalBytes': publication['canonicalBytes'], 'coreFiles': len(core_files),
        'coreBytes': sum(len(entries['package/dist/' + path]) for path in core_files),
        'coreNonlocalStaticImports': core_external,
        'slimRuntimeFiles': closure['slimRuntimeFiles'],
        'manifestSha256': publication['manifestSha256'],
        'inventorySha256': publication['inventorySha256'],
        'utilityFiles': [path for path in files if path.startswith('util/')],
        'cachekeepFiles': [path for path in files if path.startswith('cachekeep/')],
    }
    if args.write:
        target = ROOT / 'test/common-auth-0113-producer'
        for name, value in [('publication', publication), ('closure', closure)]:
            (target / (name + '.json')).write_text(json.dumps(value, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
