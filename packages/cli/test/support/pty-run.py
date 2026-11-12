"""Usage: pty-run.py <prompt> <keys> <command...>. See output.test.ts.

Several questions in a row: join the prompts, and the keys, with "|||". Each keys part is typed
once its prompt shows after the part before was typed (keys typed ahead of a prompt are lost).
"""
import fcntl, os, pty, select, struct, sys, termios, time
prompts = [p.encode() for p in sys.argv[1].split("|||")]
keys = [k.encode().decode("unicode_escape").encode() for k in sys.argv[2].split("|||")]
argv = sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
    os.execvp(argv[0], argv)
seen, step, start, deadline = b"", 0, 0, time.time() + 30
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
    if step < len(prompts) and prompts[step] in seen[start:]:
        os.write(fd, keys[step])
        step, start = step + 1, len(seen)
else:
    os.kill(pid, 9)
sys.stdout.buffer.write(seen)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
