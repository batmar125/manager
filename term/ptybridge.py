# Ponte de pseudo-terminal para o manager: roda um comando num pty e liga stdin/stdout ao Node.
# Linhas "cols rows" no fd 3 redimensionam o terminal.
import os, pty, sys, select, fcntl, termios, struct, signal

cmd = sys.argv[1:] or [os.environ.get("SHELL", "/bin/bash"), "-l"]
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(cmd[0], cmd)

ctl = 3 if os.path.exists("/proc/self/fd/3") else None
fds = [0, fd] + ([ctl] if ctl else [])
pending = b""
while True:
    try:
        r, _, _ = select.select(fds, [], [])
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            os.kill(pid, signal.SIGHUP)
            break
        os.write(fd, data)
    if ctl and ctl in r:
        data = os.read(ctl, 1024)
        if not data:
            fds.remove(ctl)
            continue
        pending += data
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            try:
                cols, rows = map(int, line.split())
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                os.kill(pid, signal.SIGWINCH)
            except Exception:
                pass
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
