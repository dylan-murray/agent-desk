'use strict';
const transientCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOENT']);
function retryable(error) {
  return error?.retryable === true || error?.retryable !== false && transientCodes.has(error?.code);
}

// Only connection establishment is retried; requests and terminal input are not.
function reconnect({attempt, allowed, setTimer = setTimeout, clearTimer = clearTimeout}) {
  const delays = [1000, 2000, 5000, 10000, 30000];
  let timer = null, failures = 0;
  function clear() {if (timer !== null) clearTimer(timer);timer = null;}
  function schedule() {
    if (timer !== null || !allowed()) return;
    timer = setTimer(() => {timer = null;if (allowed()) void attempt();}, delays[Math.min(failures++, delays.length - 1)]);
  }
  function now() {if (allowed()) {clear();void attempt();}}
  return {schedule, now, clear, reset() {clear();failures = 0;}};
}

module.exports = {reconnect, retryable};
