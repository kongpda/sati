"""Usage: pty-run.py <prompt> <keys> <command...>. See output.test.ts.

Several questions in a row: join the prompts, and the keys, with "|||". Each keys part is typed
once its prompt shows after the part before was typed (keys typed ahead of a prompt are lost).
After the first part, the keys also wait until the output has been quiet for 0.2 s, and the last
place the prompt shows must not be an answered question. An answered question is drawn once more
with the mark ◇, and its text can hold the next prompt's words ("Comment on which task?" then
"Comment", or the same menu twice with a slow command between).
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
ANSWERED = "◇".encode()


def waiting(prompt):
    at = seen.rfind(prompt, start)
    return at >= 0 and ANSWERED not in seen[seen.rfind(b"\n", 0, at) + 1 : at]


while time.time() < deadline:
    if not select.select([fd], [], [], 0.2)[0]:
        if 0 < step < len(prompts) and waiting(prompts[step]):
            os.write(fd, keys[step])
            step, start = step + 1, len(seen)
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    seen += chunk
    if step == 0 and prompts[0] in seen:
        os.write(fd, keys[step])
        step, start = step + 1, len(seen)
else:
    os.kill(pid, 9)
sys.stdout.buffer.write(seen)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
