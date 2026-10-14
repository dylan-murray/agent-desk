"""Bounded asynchronous screen mirror independent of terminal replay history."""
import json
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time

TURN_SETTLE=1.5


class WorkerNotReady(ValueError):
    """No input was written and no mailbox reservation was made; safe to defer."""


class WorkerScreen:
    def __init__(self,harness):
        self.harness=harness;self.lock=threading.RLock();self.revision=0;self.snapshot={}
        self.ack=threading.Condition(self.lock)
        self.failed=False;self.stopped=False;self.last_input=0;self.output_after_input=True
        self.stable_since=time.monotonic();self.events=queue.Queue(maxsize=256)
        # A turn ends when the prompt settles back to idle after the agent was working.
        self.worked=False;self.pending_turn_end=None;self.last_turn_end=None
        node=shutil.which('node')
        self.process=None
        if not node:self.failed=True;return
        try:self.process=subprocess.Popen([node,str(Path(__file__).resolve().parents[1]/'scripts'/'worker_screen.cjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,bufsize=0)
        except OSError:self.failed=True;return
        self.writer=threading.Thread(target=self.write,daemon=True);self.reader=threading.Thread(target=self.read,daemon=True)
        self.writer.start();self.reader.start()

    def observe(self,op,**fields):
        with self.lock:
            if self.failed or self.stopped:return
            self.revision+=1
            if op=='input':self.last_input=time.monotonic();self.output_after_input=False
            if op=='output':self.output_after_input=True
            if op=='resize':self.stable_since=time.monotonic()
            event=dict(fields,op=op,revision=self.revision,harness=self.harness)
            try:self.events.put_nowait(event)
            except queue.Full:self.failed=True

    def write(self):
        try:
            while not self.stopped:
                try:event=self.events.get(timeout=.2)
                except queue.Empty:continue
                data=json.dumps(event).encode()+b'\n'
                while data:
                    written=self.process.stdin.write(data)
                    if not written:raise OSError('Observer closed')
                    data=data[written:]
                # Keep only one event in Node; its promise chain must not become
                # an unbounded second queue during a burst of worker output.
                with self.ack:
                    while not self.stopped and not self.failed and self.snapshot.get('revision',0)<event['revision']:
                        self.ack.wait(.2)
                    if self.failed:return
        except (OSError,ValueError):
            with self.lock:self.failed=True

    def read(self):
        try:
            for line in self.process.stdout:
                state=json.loads(line)
                with self.lock:
                    self.settle_turn()
                    if (state.get('ready'),state.get('state'))!=(self.snapshot.get('ready'),self.snapshot.get('state')):self.stable_since=time.monotonic()
                    if state.get('state')=='working':self.worked=True;self.pending_turn_end=None
                    elif state.get('state')=='idle' and self.worked:self.worked=False;self.pending_turn_end=time.time()
                    self.snapshot=state
                    self.ack.notify_all()
        except (OSError,ValueError):pass
        finally:
            with self.lock:self.failed=True

    def settle_turn(self):
        # An idle prompt only ends the turn once it has held, so a frame between tool calls is not a finish.
        if self.pending_turn_end and self.snapshot.get('state')=='idle' and time.monotonic()-self.stable_since>=TURN_SETTLE:
            self.last_turn_end=self.pending_turn_end;self.pending_turn_end=None

    def turn_ended(self):
        """Wall time the agent last finished a turn and returned to an empty prompt, or None."""
        with self.lock:
            self.settle_turn()
            return self.last_turn_end

    def check(self):
        with self.lock:
            if self.failed:raise ValueError('Worker screen observer is unavailable. Inspect or resume the worker before automatic delivery')
            state=self.snapshot.get('state','unknown')
            if state=='shell':raise ValueError('The agent exited to a shell. Open a new agent terminal for automatic task delivery')
            if (not self.output_after_input or self.snapshot.get('revision')!=self.revision or
                not self.snapshot.get('ready') or time.monotonic()-self.last_input<1 or time.monotonic()-self.stable_since<.25):
                raise WorkerNotReady('Waiting to deliver: worker is '+state+'; an empty stable prompt is required (drafts and approvals are preserved)')

    def close(self):
        self.stopped=True
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                try:self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=2)
            self.writer.join(1);self.reader.join(1)
            self.process.stdin.close();self.process.stdout.close()
