import os
import signal
import sys


def bind_to_parent():
    parent = int(os.environ.get('BOOKORBIT_PARENT_PID', os.getppid()))
    if sys.platform == 'linux':
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        # PR_SET_PDEATHSIG is cleared at fork. Arm it in the actual worker.
        if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'Could not bind story worker lifetime')
    else:
        import threading
        import time

        def watch():
            while os.getppid() == parent:
                time.sleep(0.5)
            os._exit(1)

        threading.Thread(target=watch, daemon=True).start()
    # Also handles a parent dying before prctl or the watcher was installed.
    if os.getppid() != parent:
        os._exit(1)
