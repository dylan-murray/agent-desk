(() => {
  const button = document.createElement('button');
  button.id = 'desk-send-notes'; button.className = 'btn'; button.type = 'button';
  button.textContent = 'Send to agent'; button.disabled = true;
  const status = document.createElement('span');
  status.id = 'desk-send-status'; status.setAttribute('role', 'status');
  status.textContent = 'Connecting to coordinator…';
  document.querySelector('#themebtn').before(button);
  document.querySelector('#top').append(status);
  const style = document.createElement('style');
  style.textContent = '#desk-send-status{font-size:12px;color:var(--fg-muted);white-space:normal}#desk-send-status.error{color:var(--danger)}#top{flex-wrap:wrap}#side{top:var(--desk-top,45px);height:calc(100vh - var(--desk-top,45px))}#desk-send-notes:disabled{opacity:.55;cursor:default}@media(max-width:700px){#top .file{flex-basis:100%;min-width:0}#top .path{display:none}#desk-send-status{flex-basis:100%}#wrap{flex-direction:column}#main{width:100%;box-sizing:border-box;padding-bottom:24px}#side{width:100%;box-sizing:border-box;position:static;height:auto;border-top:1px solid var(--border)}}';
  document.head.append(style);
  new ResizeObserver(() => document.documentElement.style.setProperty('--desk-top', document.querySelector('#top').getBoundingClientRect().height+'px')).observe(document.querySelector('#top'));
  let destination = null, token = null, sending = false, sentIds = new Set();
  const dirty = new Map();
  let saves = Promise.resolve(), saving = 0;
  const originalRefresh = refresh, originalDraw = draw;
  function badges() {
    document.querySelectorAll('.desk-sent').forEach(node => node.remove());
    for (const id of sentIds) {
      const note = document.getElementById('n'+id);
      if (!note || note.classList.contains('done')) continue;
      const badge = document.createElement('span'); badge.className = 'badge desk-sent';
      badge.textContent = destination?.startsWith('coordinator-') ? 'Sent to coordinator' : 'Sent to agent';
      note.querySelector('.meta > span')?.append(badge);
    }
  }
  draw = () => { originalDraw(); badges(); };
  refresh = async () => { if (!dirty.size && !saving && !sending) await originalRefresh(); };
  async function api(path, payload) {
    const response = await fetch('/desk-feedback/'+path, {
      method: payload ? 'POST' : 'GET',
      headers: payload ? {'Content-Type':'application/json', 'X-Readme-Feedback':token} : {},
      ...(payload ? {body:JSON.stringify(payload)} : {}),
      signal:AbortSignal.timeout(45000)
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Feedback request failed. Try again.');
    return result;
  }
  async function config() {
    if (sending) return;
    try {
      const result = await api('config');
      const changed = destination !== result.target_id;
      destination = result.target_id; token = result.token;
      button.textContent = result.label; button.disabled = !destination;
      sentIds = new Set(result.sent_ids); badges();
      if (changed || !destination || status.textContent === 'Connecting to coordinator…') {
        status.classList.remove('error');
        status.textContent = destination ? 'Sends open notes to the launching session' : 'No launching session linked';
      }
    } catch (error) {
      button.disabled = true; status.classList.add('error');
      status.textContent = 'Could not connect to feedback delivery. Retrying…';
    }
  }
  function persist(id, comment) {
    saving++;
    const task = saves.then(async () => {
      const response = await fetch('/update', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id, comment})});
      if (!response.ok) throw Error('Could not save your latest comment. Try again.');
      if (dirty.get(id) === comment) dirty.delete(id);
    });
    saves = task.catch(() => {});
    return task.finally(() => { saving--; });
  }
  edit = (id, comment) => {
    clearTimeout(timers[id]); dirty.set(id, comment); sentIds.delete(id); badges();
    const note = ann.find(n => n.id === id); if (note) note.comment = comment;
    timers[id] = setTimeout(() => persist(id, comment).catch(error => {
      status.textContent = error.message; status.classList.add('error');
    }), 450);
  };
  status.textContent = 'Connecting to coordinator…';
  config();
  const discovery = setInterval(config, 2000);
  button.onclick = async () => {
    if (sending || !destination) return;
    sending = true; button.disabled = true; status.classList.remove('error'); status.textContent = 'Sending…';
    try {
      const pending = [...dirty];
      for (const [id] of pending) clearTimeout(timers[id]);
      await Promise.all(pending.map(([id, comment]) => persist(id, comment)));
      await saves;
      const response = await fetch('/state');
      if (!response.ok) throw Error('Could not read saved notes. Try again.');
      const notes = (await response.json()).annotations.filter(note => note.status !== 'addressed');
      if (!notes.length) throw Error('Add an open note before sending.');
      const result = await api('submit', {target_id:destination, notes});
      if (!result.sent) throw Error('Delivery not confirmed. Retry to check the same submission.');
      status.textContent = 'Sent. The coordinator will mark implemented changes done.';
    } catch (error) {
      status.classList.add('error');
      status.textContent = error.name === 'TimeoutError' ? 'Delivery not confirmed. Retry to check the same submission.' : error.message;
    } finally {
      sending = false; button.disabled = !destination; await config();
    }
  };
  window.addEventListener('pagehide', () => clearInterval(discovery));
})();
