// What each pane's bottom bar shows, chosen in Settings → Terminal panes or by right-clicking a bar. Saved per browser and
// applied as data-pane-bar-hide on the root, so panes need no redraw; with every part off the bar goes away.
(() => {
  const KEY = 'agent-desk-pane-bar';
  const PARTS = [
    ['folder', 'Folder', 'Where the pane started, and the remote it runs on.'],
    ['branch', 'Branch', 'The Git branch checked out in that folder.'],
    ['time', 'Working or idle time', 'How long the agent has been working, or quiet.'],
    ['cpu', 'CPU', 'For the agent and everything it started.'],
    ['memory', 'Memory', 'For the agent and everything it started.']
  ];
  const known = new Set(PARTS.map(([key]) => key));
  let hidden = new Set();
  const read = text => { try { const saved = JSON.parse(text || '{}').hidden; hidden = new Set(Array.isArray(saved) ? saved.filter(key => known.has(key)) : []); } catch { hidden = new Set(); } };
  try { read(localStorage.getItem(KEY)); } catch {}
  const rows = document.getElementById('settings-pane-bar');
  rows.innerHTML = PARTS.map(([key, label, detail]) => `<div class="settings-row"><div class="settings-label"><strong id="settings-pane-bar-${key}-label">${label}</strong><span>${detail}</span></div><button type="button" class="settings-switch" role="switch" data-part="${key}" aria-labelledby="settings-pane-bar-${key}-label"><span class="menu-switch" aria-hidden="true"></span></button></div>`).join('');
  function apply() {
    const off = [...hidden];
    if (off.length === PARTS.length) off.push('all');
    if (off.length) document.documentElement.dataset.paneBarHide = off.join(' ');
    else delete document.documentElement.dataset.paneBarHide;
    for (const button of rows.querySelectorAll('[data-part]')) button.setAttribute('aria-checked', String(!hidden.has(button.dataset.part)));
    for (const item of document.querySelectorAll('#pane-bar-menu [data-part]')) item.setAttribute('aria-checked', String(!hidden.has(item.dataset.part)));
  }
  function toggle(key) {
    if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
    try { localStorage.setItem(KEY, JSON.stringify({ hidden: [...hidden] })); } catch {}
    apply();
  }
  for (const button of rows.querySelectorAll('[data-part]')) button.onclick = () => toggle(button.dataset.part);
  window.addEventListener('storage', event => { if (event.key === KEY) { read(event.newValue); apply(); } });

  // The bar's own menu keeps open while parts are switched, so several can change at once.
  const check = '<svg class="pane-bar-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';
  function closeMenu(restore) {
    const menu = document.getElementById('pane-bar-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (restore) menu.returnFocus?.focus?.();
  }
  function openMenu(x, y, returnFocus) {
    let menu = document.getElementById('pane-bar-menu');
    if (!menu) {
      menu = document.createElement('div'); menu.id = 'pane-bar-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Show in the bottom bar');
      menu.innerHTML = '<p class="pane-bar-menu-title">Show in the bottom bar</p>' + PARTS.map(([key, label]) => `<button type="button" role="menuitemcheckbox" data-part="${key}">${check}${label}</button>`).join('') + '<hr><button type="button" role="menuitem" data-settings>Terminal pane settings…</button>';
      for (const item of menu.querySelectorAll('[data-part]')) item.onclick = () => toggle(item.dataset.part);
      menu.querySelector('[data-settings]').onclick = () => { closeMenu(false); document.getElementById('open-settings').click(); document.getElementById('settings-pane-bar-heading').scrollIntoView({ block: 'start' }); };
      document.body.append(menu);
    }
    menu.returnFocus = returnFocus; menu.hidden = false; apply();
    const box = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, innerWidth - box.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y - box.height, innerHeight - box.height - 8)) + 'px';
    menu.querySelector('button').focus();
  }
  document.addEventListener('contextmenu', event => {
    const bar = event.target.closest('.terminal-pane>.pane-status');
    if (!bar) return;
    event.preventDefault();
    const at = event.clientX || event.clientY ? [event.clientX, event.clientY] : (box => [box.x + 16, box.top])(bar.getBoundingClientRect());
    openMenu(...at, bar.closest('.terminal-pane'));
  });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#pane-bar-menu')) closeMenu(false); }, true);
  document.addEventListener('keydown', event => {
    const menu = document.getElementById('pane-bar-menu');
    if (!menu || menu.hidden) return;
    const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    else if (event.key === 'Tab') closeMenu(false);
  });
  window.addEventListener('blur', () => closeMenu(false));
  apply();
})();
