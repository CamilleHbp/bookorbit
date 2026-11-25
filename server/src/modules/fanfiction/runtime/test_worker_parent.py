import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest


class WorkerParentTest(unittest.TestCase):
    def test_killing_the_launcher_terminates_the_worker(self):
        worker = "from worker_parent import bind_to_parent; import time; bind_to_parent(); print('ready',flush=True); time.sleep(15)"
        launcher = """
import os, subprocess, sys, time
subprocess.Popen([sys.executable, '-c', sys.argv[1]], env=dict(os.environ, BOOKORBIT_PARENT_PID=str(os.getpid())))
time.sleep(15)
"""
        parent = subprocess.Popen([sys.executable, '-c', launcher, worker], stdout=subprocess.PIPE,
                                  cwd=Path(__file__).parent, start_new_session=True)
        try:
            self.assertEqual(parent.stdout.readline(), b'ready\n')
            parent.kill()
            # communicate waits for the worker's inherited stdout to close as well.
            parent.communicate(timeout=4)
        finally:
            try:
                os.killpg(parent.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            parent.wait()
