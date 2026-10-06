#!/usr/bin/env python3
"""CodeLesson AI — Python sandbox.

Runs untrusted lesson code. Isolation is layered:
  container (docker-compose): no network, read-only root filesystem, small tmpfs, memory/CPU/pids caps,
                              all capabilities dropped except SETUID/SETGID/KILL, no-new-privileges,
                              no secrets or environment from the app.
  per run (this file):        fresh temp directory, empty environment, unprivileged uid, own process group,
                              CPU-seconds / address-space / process-count / file-size / open-file limits,
                              wall-clock timeout with SIGKILL of the whole group, output cap.

Protocol: one JSON line {"code": "..."} in, one JSON line out:
  {"ok": bool, "stdout": str, "stderr": str, "exit_code": int|null, "timed_out": bool, "truncated": bool, "ms": int}

Usage:  server.py            serve on $SANDBOX_SOCKET (default /sock/sandbox.sock)
        server.py --once     read one request from stdin, print the result (development)
"""
import json, os, signal, socketserver, subprocess, sys, tempfile, threading, time

SOCKET = os.environ.get("SANDBOX_SOCKET", "/sock/sandbox.sock")
RUN_UID = int(os.environ.get("SANDBOX_RUN_UID", "10001"))
CPU_SECONDS = 2
WALL_SECONDS = 5
MEMORY_BYTES = 256 * 1024 * 1024
MAX_PROCS = 16
MAX_FILE_BYTES = 1 * 1024 * 1024
MAX_OUTPUT = 64 * 1024
MAX_CODE = 20000
CONCURRENCY = threading.BoundedSemaphore(int(os.environ.get("SANDBOX_CONCURRENCY", "4")))


def _limits(drop_privileges):
    import resource
    def apply():
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_BYTES, MAX_FILE_BYTES))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if drop_privileges:
            resource.setrlimit(resource.RLIMIT_NPROC, (MAX_PROCS, MAX_PROCS))
            os.setgroups([])
            os.setgid(RUN_UID)
            os.setuid(RUN_UID)
    return apply


def run(code):
    if not isinstance(code, str) or not code.strip():
        return {"ok": False, "stdout": "", "stderr": "No code to run.", "exit_code": None, "timed_out": False, "truncated": False, "ms": 0}
    if len(code) > MAX_CODE:
        return {"ok": False, "stdout": "", "stderr": "Code is too long.", "exit_code": None, "timed_out": False, "truncated": False, "ms": 0}
    drop = os.geteuid() == 0
    start = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="run-") as work:
        path = os.path.join(work, "main.py")
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        if drop:
            os.chown(work, RUN_UID, RUN_UID)
            os.chown(path, RUN_UID, RUN_UID)
        proc = subprocess.Popen(
            [sys.executable, "-I", "-B", "main.py"],
            cwd=work,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": work, "PYTHONIOENCODING": "utf-8", "LANG": "C.UTF-8"},
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            preexec_fn=_limits(drop), close_fds=True,
        )
        bufs = {"stdout": bytearray(), "stderr": bytearray()}
        truncated = [False]

        def kill():
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

        def reader(stream, key):
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                room = MAX_OUTPUT - len(bufs[key])
                if room > 0:
                    bufs[key] += chunk[:room]
                if len(chunk) > room:
                    truncated[0] = True
                    kill()
                    break

        threads = [threading.Thread(target=reader, args=(proc.stdout, "stdout"), daemon=True),
                   threading.Thread(target=reader, args=(proc.stderr, "stderr"), daemon=True)]
        for t in threads:
            t.start()
        timed_out = False
        try:
            proc.wait(timeout=WALL_SECONDS)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill()
            proc.wait()
        kill()  # clean up any children left in the group
        for t in threads:
            t.join(timeout=1)

    stderr = bufs["stderr"].decode("utf-8", "replace")
    code_ = proc.returncode
    if timed_out:
        stderr += ("\n" if stderr else "") + f"Time limit exceeded ({WALL_SECONDS} s) — the program was stopped."
    elif code_ is not None and code_ < 0 and -code_ in (signal.SIGXCPU, signal.SIGKILL) and not truncated[0]:
        stderr += ("\n" if stderr else "") + f"CPU limit exceeded ({CPU_SECONDS} s) — the program was stopped."
    if truncated[0]:
        stderr += ("\n" if stderr else "") + "Output limit reached — the program was stopped."
    return {
        "ok": code_ == 0 and not timed_out and not truncated[0],
        "stdout": bufs["stdout"].decode("utf-8", "replace"),
        "stderr": stderr,
        "exit_code": code_,
        "timed_out": timed_out,
        "truncated": truncated[0],
        "ms": int((time.monotonic() - start) * 1000),
    }


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            line = self.rfile.readline(MAX_CODE * 4 + 1024)
            req = json.loads(line or b"{}")
            if not CONCURRENCY.acquire(timeout=10):
                res = {"ok": False, "stdout": "", "stderr": "Sandbox is busy. Try again.", "exit_code": None, "timed_out": False, "truncated": False, "ms": 0}
            else:
                try:
                    res = run(req.get("code"))
                finally:
                    CONCURRENCY.release()
        except Exception as e:  # never crash the server on a bad request
            res = {"ok": False, "stdout": "", "stderr": "Sandbox error: " + type(e).__name__, "exit_code": None, "timed_out": False, "truncated": False, "ms": 0}
        self.wfile.write((json.dumps(res) + "\n").encode())


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    if "--once" in sys.argv:
        req = json.loads(sys.stdin.read() or "{}")
        print(json.dumps(run(req.get("code"))))
        return
    try:
        os.unlink(SOCKET)
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(SOCKET), exist_ok=True)
    srv = Server(SOCKET, Handler)
    os.chmod(SOCKET, 0o666)
    print(f"sandbox listening on {SOCKET} (drop privileges: {os.geteuid() == 0})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
