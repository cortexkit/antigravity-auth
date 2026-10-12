"""Measure the job's network namespace and privilege restrictions before starting an official host."""
import errno
import json
import os
import platform
import socket
import subprocess
import sys


def status():
    fields = dict(line.split(':', 1) for line in open('/proc/self/status') if ':' in line)
    return {key: fields[key].strip() for key in ('NoNewPrivs', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'Seccomp')}


def blocked(family, kind, address):
    with socket.socket(family, kind) as peer:
        peer.settimeout(1)
        try:
            peer.connect(address)
        except OSError as error:
            if error.errno != errno.ENETUNREACH:
                raise
            return error.errno
        raise RuntimeError('External socket unexpectedly connected')


def round_trip(family, address):
    with socket.socket(family, socket.SOCK_STREAM) as listener:
        listener.settimeout(1)
        listener.bind(address)
        listener.listen(1)
        with socket.socket(family, socket.SOCK_STREAM) as client:
            client.settimeout(1)
            client.connect(listener.getsockname())
            with listener.accept()[0] as accepted:
                accepted.settimeout(1)
                client.sendall(b'loopback-proof')
                assert accepted.recv(64) == b'loopback-proof'
                accepted.sendall(b'ack')
                assert client.recv(64) == b'ack'
    return True


observed = status()
interfaces = sorted(os.listdir('/sys/class/net'))
namespace = os.readlink('/proc/self/ns/net')
# Verify lo-only interfaces and process namespace/privilege status before the bounded address probes.
assert platform.machine() == 'x86_64' and interfaces == ['lo']
assert observed['NoNewPrivs'] == '1' and observed['Seccomp'] == '2'
assert all(int(observed[key], 16) == 0 for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'))
controls = []
for family, address in ((socket.AF_INET, ('192.0.2.1', 443)), (socket.AF_INET6, ('2001:db8::1', 443))):
    for kind, name in ((socket.SOCK_STREAM, 'external_tcp'), (socket.SOCK_DGRAM, 'external_udp')):
        controls.append({'control': name, 'family': int(family), 'errno': blocked(family, kind, address)})
# A DNS datagram cannot leave the namespace either; no public resolver is queried.
controls.append({'control': 'external_dns', 'errno': blocked(socket.AF_INET, socket.SOCK_DGRAM, ('192.0.2.53', 53))})
for family, address in ((socket.AF_INET, ('127.0.0.1', 0)), (socket.AF_INET6, ('::1', 0))):
    controls.append({'control': 'loopback_tcp', 'family': int(family), 'roundTrip': round_trip(family, address)})
unix_path = os.path.join(sys.argv[1], 'boundary.sock')
try:
    controls.append({'control': 'unix_round_trip', 'roundTrip': round_trip(socket.AF_UNIX, unix_path)})
finally:
    if os.path.exists(unix_path):
        os.unlink(unix_path)
child = subprocess.run([sys.executable, '-c', "import os,socket,json; s=socket.socket(); e=None\ntry: s.connect(('192.0.2.1',443))\nexcept OSError as x: e=x.errno\nprint(json.dumps({'namespace':os.readlink('/proc/self/ns/net'),'errno':e}))"], check=True, capture_output=True, text=True, timeout=3)
controls.append({'control': 'child_inheritance', **json.loads(child.stdout)})
escape = subprocess.run(['/usr/bin/unshare', '-n', '/usr/bin/true'], capture_output=True, text=True, timeout=3)
assert escape.returncode == 1 and 'Operation not permitted' in escape.stderr
controls.append({'control': 'namespace_escape', 'exit': escape.returncode, 'stderr': escape.stderr})
print(json.dumps({'architecture': platform.machine(), 'interfaces': interfaces, 'namespace': namespace, 'status': observed, 'controls': controls}))
