import json
import os
import sys
import time

mode, nonce = sys.argv[1:]
child = os.fork()
if child == 0:
    if mode == "separate-first":
        os.setpgid(0, 0)
    elif mode == "changed-after":
        time.sleep(1.3)
        os.setpgid(0, 0)
    elif mode == "foreign-session":
        time.sleep(1.3)
        os.setsid()
    print(json.dumps({"witnessChild": os.getpid(), "ppid": os.getppid(),
                      "pgid": os.getpgrp(), "sid": os.getsid(0),
                      "mode": mode, "nonce": nonce}), flush=True)
    time.sleep(2)
    os._exit(0)
print(json.dumps({"witnessLeader": os.getpid(), "child": child,
                  "mode": mode, "nonce": nonce}), flush=True)
time.sleep(1.7)
os._exit(0)
