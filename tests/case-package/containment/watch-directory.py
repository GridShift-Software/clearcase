"""Run the probe under a Linux inotify watch of one directory and report every directory open or
access event on it. Adapted from the CC-23 / GRS-11 gate's watch-directory.py.

Usage: watch-directory.py OUTSIDE PROBE CASE_FOLDER [INDEXED_PATH]
"""
import ctypes
import json
import os
import select
import struct
import subprocess
import sys

IN_ACCESS, IN_OPEN, IN_CLOSE_NOWRITE, IN_ISDIR = 0x1, 0x20, 0x10, 0x40000000

outside, probe, *probe_args = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
libc.inotify_init1.argtypes = [ctypes.c_int]
libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
fd = libc.inotify_init1(os.O_NONBLOCK)
if fd < 0:
    raise OSError(ctypes.get_errno(), "inotify_init1")
try:
    if libc.inotify_add_watch(fd, os.fsencode(outside), IN_ACCESS | IN_OPEN | IN_CLOSE_NOWRITE) < 0:
        raise OSError(ctypes.get_errno(), "inotify_add_watch")
    child = subprocess.run(["bun", probe, *probe_args], capture_output=True, text=True, timeout=15)
    if child.returncode:
        raise RuntimeError(child.stderr)
    directory_reads = []
    while select.select([fd], [], [], 0)[0]:
        buf = os.read(fd, 65536)
        pos = 0
        while pos < len(buf):
            _, mask, _, length = struct.unpack_from("iIII", buf, pos)
            pos += 16 + length
            if mask & IN_ISDIR and mask & (IN_ACCESS | IN_OPEN):
                directory_reads.append(hex(mask))
    print(json.dumps({"result": json.loads(child.stdout), "outsideDirectoryReads": directory_reads}))
finally:
    os.close(fd)
