"""Usage: pty-run.py <prompt> <keys> <command...>. See output.test.ts."""
import fcntl, os, pty, select, struct, sys, termios, time
prompt, keys, argv = sys.argv[1].encode(), sys.argv[2].encode().decode("unicode_escape").encode(), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
    os.execvp(argv[0], argv)
seen, sent, deadline = b"", False, time.time() + 30
while time.time() < deadline:
    if not select.select([fd], [], [], 0.2)[0]:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    seen += chunk
    if not sent and prompt in seen:
        os.write(fd, keys)
        sent = True
else:
    os.kill(pid, 9)
sys.stdout.buffer.write(seen)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
