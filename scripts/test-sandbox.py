#!/usr/bin/env python3
"""Checks the sandbox's resource limits by running hostile programs through `sandbox/server.py --once`.
Network isolation is enforced by the container, so it's covered by scripts/smoke.js against Docker instead."""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, "..", "sandbox", "server.py")
CASES = [
    ("prints output", 'for i in range(3):\n    print("Hello")', lambda r: r["ok"] and r["stdout"] == "Hello\nHello\nHello\n"),
    ("reports errors", "print(1/0)", lambda r: not r["ok"] and "ZeroDivisionError" in r["stderr"]),
    ("stops infinite loops", "while True: pass", lambda r: not r["ok"]),
    ("stops sleepers", "import time; time.sleep(30)", lambda r: r["timed_out"]),
    ("caps memory", "x = bytearray(10**9)", lambda r: not r["ok"] and "MemoryError" in r["stderr"]),
    ("caps output", 'while True: print("spam" * 100)', lambda r: r["truncated"]),
]
failed = 0
for name, code, check in CASES:
    p = subprocess.run([sys.executable, RUNNER, "--once"], input=json.dumps({"code": code}), capture_output=True, text=True, timeout=30)
    try:
        r = json.loads(p.stdout); good = check(r)
    except Exception as e:
        r, good = {"error": str(e), "raw": p.stdout + p.stderr}, False
    print(("PASS " if good else "FAIL ") + name + ("" if good else "  " + json.dumps(r)[:300]))
    failed += not good
sys.exit(1 if failed else 0)
