// Task completion comes only from explicit mailbox results, never PTY silence.
const workerCompletions = new Map();
function withWorkerCompletion(agent) {
  const task = workerCompletions.get(agent.id);
  if (!task || agent.harness_internal || ['needs_input', 'error', 'unknown'].includes(agent.status)) return agent;
  return {...agent, status: 'ready_for_review', activity_description: 'Worker reported task complete · ready for your review', completed_task: task.task};
}
(() => {
  const button = document.getElementById('completion-sound');
  const preference = 'agent-desk-completion-sound', seenKey = 'agent-desk-completion-seen';
  // Which events sound once alerts are on: only sessions that need you, or those and finished work.
  const eventsKey = 'agent-desk-sound-events', EVENTS = ['needs-you', 'needs-you-and-done'];
  let enabled = false, events = 'needs-you-and-done', context, initialized = false;
  const seen = new Set();
  try { enabled = localStorage.getItem(preference) === 'true'; } catch {}
  try { const saved = localStorage.getItem(eventsKey); if (EVENTS.includes(saved)) events = saved; } catch {}
  function readSeen() {
    try { for (const id of JSON.parse(localStorage.getItem(seenKey) || '[]')) seen.add(id); } catch {}
  }
  function updateButton() {
    button.title = 'Alert sounds '+(enabled ? 'on · click to mute.' : 'off · click to enable.')+(events === 'needs-you' ? ' Sessions that need you.' : ' Sessions that need you or are done.')+' Keep Agent Desk open in a browser tab.';
    button.setAttribute('aria-pressed', String(enabled));
    document.dispatchEvent(new CustomEvent('desk-alerts-change'));
  }
  // The audio context must exist and be running before a completion lands, so prime it
  // on any interaction rather than only when sounds are switched on, and resume it
  // whenever the browser has suspended it. A silent chime is the bug being fixed here.
  let warned = false;
  async function ready(force = false) {
    if (!enabled && !force) return false;
    try {
      context ||= new (window.AudioContext || window.webkitAudioContext)();
      if (context.state !== 'running') await context.resume();
      return context.state === 'running';
    } catch { return false; }
  }
  async function unlock() { await ready(); }
  // A rising interval reads as "finished"; a falling one reads as "come back". Both stay
  // quiet and short so the difference is the contour, not the volume.
  const completionTones = [[0, 783.99], [0.12, 1174.66]], attentionTones = [[0, 880], [0.15, 587.33]];
  async function chime(tones = completionTones, force = false) {
    if (!enabled && !force) return false;
    if (!(await ready(force))) {
      if (!warned) { warned = true; toast('Alert audio is blocked until you click the page once.'); }
      return false;
    }
    warned = false;
    for (const [offset, frequency] of tones) {
      const tone = context.createOscillator(), volume = context.createGain(), start = context.currentTime + offset;
      tone.frequency.value = frequency; volume.gain.setValueAtTime(0, start);
      tone.type = 'sine';
      tone.frequency.exponentialRampToValueAtTime(frequency * 0.997, start + 0.55);
      volume.gain.linearRampToValueAtTime(0.045, start + 0.012);
      volume.gain.exponentialRampToValueAtTime(0.001, start + 0.7);
      tone.connect(volume); volume.connect(context.destination); tone.start(start); tone.stop(start + 0.75);
      tone.onended = () => { tone.disconnect(); volume.disconnect(); };
    }
    return true;
  }
  // Worker reports and finished turns are one kind of event: when both land together, one chime.
  let lastCompletion = 0;
  function completion() {
    if (events !== 'needs-you-and-done' || Date.now() - lastCompletion < 1500) return Promise.resolve(false);
    lastCompletion = Date.now();
    return chime(completionTones);
  }
  async function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem(preference, String(enabled)); } catch {}
    updateButton(); await unlock(); chime(events === 'needs-you' ? attentionTones : completionTones);
  }
  function setEvents(value) {
    if (!EVENTS.includes(value)) return;
    events = value;
    try { localStorage.setItem(eventsKey, events); } catch {}
    updateButton();
  }
  // The attention alert shares this one preference and one audio context rather than
  // storing its own mute flag; the header speaker icon and the Settings page gate both.
  window.deskAlerts = {enabled: () => enabled, events: () => events, setEnabled, setEvents, unlock, completion,
    attention: () => chime(attentionTones), preview: kind => chime(kind === 'attention' ? attentionTones : completionTones, true)};
  button.onclick = () => setEnabled(!enabled);
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) unlock(); });
  window.addEventListener('focus', unlock);
  if (enabled) unlock();
  window.addEventListener('storage', event => {
    if (event.key === preference) { enabled = event.newValue === 'true'; updateButton(); }
    if (event.key === eventsKey && EVENTS.includes(event.newValue)) { events = event.newValue; updateButton(); }
    if (event.key === seenKey) readSeen();
  });
  window.updateWorkerCompletions = tasks => {
    const previous = JSON.stringify([...workerCompletions]);
    workerCompletions.clear();
    const byWorker = new Map();
    for (const task of tasks) {
      if (!task.worker) continue;
      if (!byWorker.has(task.worker)) byWorker.set(task.worker, []);
      byWorker.get(task.worker).push(task);
    }
    for (const [id, work] of byWorker) {
      work.sort((a, b) => b.created - a.created);
      if (work.every(task => task.result != null) && work[0].outcome === 'completed' &&
          !work[0].result.startsWith('Automatic turn-end report (task success is not verified):')) workerCompletions.set(id, work[0]);
    }
    readSeen();
    let fresh = false;
    for (const task of tasks) {
      if (task.result == null || task.outcome !== 'completed' || task.result.startsWith('Automatic turn-end report (task success is not verified):')) continue;
      if (initialized && !seen.has(task.id)) fresh = true;
      seen.add(task.id);
    }
    // Baseline existing reports silently; refreshes and repeated polls don't replay them.
    initialized = true;
    try { localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-2000))); } catch {}
    if (fresh && !demo) completion();
    if (previous !== JSON.stringify([...workerCompletions]) && !annotating) render();
  };
  updateButton();
})();
