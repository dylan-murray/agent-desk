// Desktop notifications mark the same moments as the alert sounds, but only while Agent Desk is in
// the background, so they reach you in another app. The desktop app shows them natively; a browser
// tab uses the Notification API, which needs the browser's permission. Saved in this browser.
(() => {
  const KEY = 'agent-desk-notifications', FOCUS_KEY = 'agent-desk-focused-tab', EVENTS = ['needs-you', 'needs-you-and-done'];
  const native = window.agentDeskDesktop?.notify ? window.agentDeskDesktop : null;
  const tab = Math.random().toString(36).slice(2);
  let prefs = {on: false, events: 'needs-you-and-done'};
  function load(raw) {
    try { prefs = {on: false, events: 'needs-you-and-done', ...JSON.parse(raw || '{}')}; } catch {}
    if (!EVENTS.includes(prefs.events)) prefs.events = 'needs-you-and-done';
  }
  try { load(localStorage.getItem(KEY)); } catch {}
  const permission = () => native ? 'granted' : 'Notification' in window ? Notification.permission : 'unsupported';
  const changed = () => document.dispatchEvent(new CustomEvent('desk-notifications-change'));
  function save() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} changed(); }
  async function allowed() {
    if (permission() === 'default') { try { await Notification.requestPermission(); } catch {} }
    return permission() === 'granted';
  }
  async function setEnabled(on) {
    prefs.on = on && await allowed();
    save();
  }
  function setEvents(value) { if (EVENTS.includes(value)) { prefs.events = value; save(); } }
  // With several tabs open, one of them may have your attention while this one is in the background.
  // The focused tab names itself and refreshes the claim, so a tab that closed without blurring stops counting.
  function claimFocus() {
    try {
      const focused = !document.hidden && document.hasFocus(), saved = JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null');
      if (focused) localStorage.setItem(FOCUS_KEY, JSON.stringify({tab, at: Date.now()}));
      else if (saved?.tab === tab) localStorage.removeItem(FOCUS_KEY);
    } catch {}
  }
  for (const event of ['focus', 'blur']) window.addEventListener(event, claimFocus);
  document.addEventListener('visibilitychange', claimFocus);
  window.addEventListener('pagehide', () => { try { if (JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null')?.tab === tab) localStorage.removeItem(FOCUS_KEY); } catch {} });
  setInterval(claimFocus, 20000);claimFocus();
  function away() {
    if (!document.hidden && document.hasFocus()) return false;
    try { const saved = JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null'); return !(saved && saved.tab !== tab && Date.now() - saved.at < 60000); } catch { return true; }
  }
  function open(id) {
    window.focus();
    if (id && everyAgent().some(agent => agent.id === id)) selectPane(id);
  }
  native?.onNotificationClick?.(open);
  // The tab's own chime already sounds for this event when alert sounds are on, so the pop-up stays quiet.
  function quiet(kind) {
    const alerts = window.deskAlerts;
    return !!alerts?.enabled() && (kind === 'needs-you' || alerts.events() === 'needs-you-and-done');
  }
  // One notification per session and kind: a newer one replaces the older instead of stacking up.
  function show(kind, id, title, body) {
    const tag = 'agent-desk-' + kind + '-' + (id || 'preview'), silent = quiet(kind);
    if (native) return native.notify({tag, id, title, body, silent});
    if (permission() !== 'granted') return;
    const shown = new Notification(title, {body, tag, silent});
    shown.onclick = () => { shown.close(); open(id); };
  }
  const line = text => String(text || '').split('\n').map(part => part.trim()).find(Boolean)?.slice(0, 160) || '';
  function notify(kind, items) {
    if (!prefs.on || demo || !away() || (kind === 'done' && prefs.events !== 'needs-you-and-done')) return;
    for (const item of items) show(kind, item.id, item.title, item.body);
  }
  window.deskNotifications = {
    enabled: () => prefs.on && permission() === 'granted', events: () => prefs.events, permission, setEnabled, setEvents,
    needsYou: agents => notify('needs-you', agents.map(agent => ({id: agent.id, title: sessionTitle(agent) + ' needs you', body: line(agent.question) || 'Open the session to answer it.'}))),
    done: agents => notify('done', agents.map(agent => ({id: agent.id, title: sessionTitle(agent) + ' is done', body: 'Finished its turn and is waiting at the prompt.'}))),
    workerDone: tasks => notify('done', tasks.map(task => {
      const worker = everyAgent().find(agent => agent.id === task.worker);
      return {id: task.worker, title: (worker ? sessionTitle(worker) : 'A worker') + ' finished its task', body: line(task.result) || 'Ready for your review.'};
    })),
    async preview(kind) {
      if (!(await allowed())) { toast(permission() === 'unsupported' ? "This browser can't show notifications for this page." : 'Notifications are blocked for this page in the browser\'s site settings.'); changed(); return; }
      show(kind, '', kind === 'needs-you' ? 'Fixture session needs you' : 'Fixture session is done', kind === 'needs-you' ? 'This is how a question or approval will look.' : 'This is how a finished turn will look.');
      changed();
    },
  };
  window.addEventListener('storage', event => { if (event.key === KEY) { load(event.newValue); changed(); } });
  // A browser can revoke the permission while the page is open; the Settings switch follows it.
  navigator.permissions?.query({name: 'notifications'}).then(status => { status.onchange = changed; }).catch(() => {});
})();
