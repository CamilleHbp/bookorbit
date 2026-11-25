"""Run the pinned BookOrbit browser helper and reclaim abandoned browser processes."""
import os
from datetime import datetime
import re
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import threading
import time
import uuid


BROWSER_NAMES = {'chrome', 'chromium', 'chrome_crashpad', 'chromedriver'}
GRACE_SECONDS = 120
browser_tokens = {}


def tree_token(pid):
    try:
        with open(f'/proc/{pid}/environ', 'rb') as env:
            return next((value for value in env.read().split(b'\0') if value.startswith(b'BOOKORBIT_BROWSER_TREE=')), None)
    except (FileNotFoundError, ProcessLookupError):
        return None


def processes():
    rows = {}
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            name, fields = (path / 'stat').read_text().rsplit(') ', 1)
            state, parent, *rest = fields.split()
            if state != 'Z':
                rows[int(path.name)] = (name.split(' (', 1)[1], int(parent), int(rest[17]))
        except (FileNotFoundError, ProcessLookupError):
            continue
    return rows


def unowned(rows, roots):
    result = {}
    tokens = {token for pid, token in browser_tokens.copy().items() if pid in roots}
    for pid, (name, parent, started) in rows.items():
        if name not in BROWSER_NAMES:
            continue
        ancestor = pid
        while ancestor in rows and ancestor not in roots:
            ancestor = rows[ancestor][1]
        if ancestor not in roots and tree_token(pid) not in tokens:
            result[pid] = started
    return result


def supervise(storage):
    missing_since = {}
    while True:
        try:
            rows = processes()
            roots = set()
            for session in storage.sessions.copy().values():
                # This is a dedicated BookOrbit helper. Bound ad hoc sessions too.
                limit = 7500 if re.fullmatch(r'bookorbit-\d{10}-[0-9a-f]{32}', session.session_id) else GRACE_SECONDS
                if (datetime.now() - session.created_at).total_seconds() > limit:
                    storage.destroy(session.session_id)
                    continue
                driver = session.driver
                roots.add(driver.browser_pid)
                service = driver.service.process
                if service is not None and service.poll() is None:
                    roots.add(service.pid)
            candidates = unowned(rows, roots)
            now = time.monotonic()
            missing_since = {(pid, start): missing_since.get((pid, start), now)
                             for pid, start in candidates.items()}
            retired = 0
            for (pid, started), since in missing_since.items():
                if now - since < GRACE_SECONDS:
                    continue
                # A pidfd binds the signal to this process even if its PID is recycled.
                try:
                    fd = os.pidfd_open(pid)
                except ProcessLookupError:
                    continue
                try:
                    if processes().get(pid) == rows[pid]:
                        signal.pidfd_send_signal(fd, signal.SIGKILL)
                        retired += 1
                except ProcessLookupError:
                    pass
                finally:
                    os.close(fd)
            if retired:
                print(f'Reclaimed {retired} unowned browser processes', flush=True)
        except Exception as error:
            # Fail closed. Docker tears down this private PID namespace and restarts it.
            print(f'Browser supervisor failed: {type(error).__name__}', file=sys.stderr, flush=True)
            os._exit(1)
        time.sleep(10)


def launch_browser(executable, *args):
    # The bundled launcher double-forks. Keep Chrome parented to the helper.
    token = uuid.uuid4().hex
    process = subprocess.Popen([executable, *args], env=dict(os.environ, BOOKORBIT_BROWSER_TREE=token), stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    browser_tokens[process.pid] = ('BOOKORBIT_BROWSER_TREE=' + token).encode()

    def reap():
        process.wait()
        browser_tokens.pop(process.pid, None)

    threading.Thread(target=reap, daemon=True).start()
    return process.pid


if __name__ == '__main__':
    if Path('/proc/1/comm').read_text().strip() != 'dumb-init':
        raise SystemExit('Browser supervision requires its dedicated container')
    sys.path.insert(0, '/app')
    import flaresolverr_service
    import undetected_chromedriver

    undetected_chromedriver.start_detached = launch_browser
    threading.Thread(target=supervise, args=(flaresolverr_service.SESSIONS_STORAGE,), daemon=True).start()
    runpy.run_path('/app/flaresolverr.py', run_name='__main__')
