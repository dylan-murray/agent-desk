'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {reconnect, retryable} = require('../src/reconnect.cjs');

function fixture() {
  const timers = new Map();let serial = 0, attempts = 0, allowed = true;
  const retry = reconnect({attempt: () => {attempts++;}, allowed: () => allowed,
    setTimer: (run, delay) => {timers.set(++serial, {run, delay});return serial;},
    clearTimer: id => timers.delete(id)});
  return {retry, timers, get attempts() {return attempts;}, block() {allowed = false;},
    fire() {const [id, timer] = timers.entries().next().value;timers.delete(id);timer.run();}};
}

test('connection retries back off, coalesce repeated failures, and reset after recovery', () => {
  const f = fixture();
  for (const delay of [1000, 2000, 5000, 10000, 30000, 30000]) {
    f.retry.schedule();f.retry.schedule();
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].delay, delay);
    f.fire();
  }
  assert.equal(f.attempts, 6);
  f.retry.reset();f.retry.schedule();
  assert.equal([...f.timers.values()][0].delay, 1000);
});

test('manual or wake retries skip the delay; shutdown and permanent failures block queued attempts', () => {
  const f = fixture();
  f.retry.schedule();f.retry.now();
  assert.equal(f.attempts, 1);assert.equal(f.timers.size, 0);
  f.retry.schedule();f.block();f.fire();
  f.retry.schedule();f.retry.now();
  assert.equal(f.attempts, 1);assert.equal(f.timers.size, 0);
  const cancelled = fixture();cancelled.retry.schedule();cancelled.retry.clear();
  assert.equal(cancelled.timers.size, 0);assert.equal(cancelled.attempts, 0);
});

test('only known connection failures retry; authentication, identity and setup failures require intervention', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOENT']) assert.equal(retryable({code}), true);
  assert.equal(retryable({retryable: true}), true);
  assert.equal(retryable({code: 'ENOENT', retryable: false}), false);
  for (const error of [new Error('Invalid runtime'), new SyntaxError('Invalid metadata'), {code: 'EACCES'}, {retryable: false}]) {
    assert.equal(retryable(error), false);
  }
});
