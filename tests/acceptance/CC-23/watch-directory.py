"""Observe real Linux directory reads while the unmodified importer runs."""
import ctypes
import json
import os
import select
import struct
import subprocess
import sys

outside, probe, case_folder = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
libc.inotify_init1.argtypes = [ctypes.c_int]
libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
fd = libc.inotify_init1(os.O_NONBLOCK)
if fd < 0:
    raise OSError(ctypes.get_errno(), "inotify_init1")
try:
    if libc.inotify_add_watch(fd, os.fsencode(outside), 0x1 | 0x20 | 0x10) < 0:
        raise OSError(ctypes.get_errno(), "inotify_add_watch")
    child = subprocess.run(["bun", probe, case_folder], capture_output=True, text=True, timeout=15)
    if child.returncode:
        raise RuntimeError(child.stderr)
    directory_reads = []
    while select.select([fd], [], [], 0)[0]:
        buf = os.read(fd, 65536)
        pos = 0
        while pos < len(buf):
            _, mask, _, length = struct.unpack_from("iIII", buf, pos)
            pos += 16 + length
            if mask & 0x40000000 and mask & (0x1 | 0x20):
                directory_reads.append(hex(mask))
    print(json.dumps({"result": json.loads(child.stdout), "outsideDirectoryReads": directory_reads}))
finally:
    os.close(fd)
