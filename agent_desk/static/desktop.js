(() => {
  const bridge = window.agentDeskDesktop;if (!bridge) return;
  document.documentElement.classList.toggle('desktop-mac', bridge.platform === 'darwin');
  let state, notice, text, retry;
  function update(next) {
    if (state && next.revision < state.revision) return;
    const reconnected = state && state.connection !== 'connected' && next.connection === 'connected';
    state = next;
    document.documentElement.classList.toggle('native-fullscreen', state.fullscreen);
    document.body?.classList.toggle('app-fullscreen', state.fullscreen);
    const button = document.getElementById('app-fullscreen');
    if (button) {
      button.setAttribute('aria-pressed', String(state.fullscreen));
      button.title = state.fullscreen ? 'Leave full screen' : 'Put Agent Desk in full screen';
      button.setAttribute('aria-label', state.fullscreen ? 'Leave full screen' : 'Full screen');
    }
    if (notice) {
      notice.hidden = state.connection === 'connected';
      text.textContent = state.error || 'Reconnecting to your workspace…';
      retry.hidden = state.connection === 'preparing';
      if (reconnected) void refresh();
    }
  }
  bridge.subscribe(update);bridge.snapshot().then(update);
  document.addEventListener('DOMContentLoaded', () => {
    const brand = document.querySelector('.brand');
    if (bridge.platform === 'darwin' && brand) {
      const header = document.createElement('div');header.className = 'desktop-sidebar-header';
      brand.before(header);header.append(brand);
    }
    document.getElementById('app-fullscreen').hidden = false;
    document.getElementById('app-fullscreen').onclick = () => bridge.toggleFullscreen();
    if (bridge.platform === 'darwin') {
      const workspace = document.getElementById('terminal'), page = document.getElementById('agents-page');
      let expanded;
      const syncWindowButtons = () => {
        const active = workspace.classList.contains('has-fullscreen') && !page.classList.contains('hidden');
        if (expanded !== active) {expanded = active;bridge.setPaneFullscreen(active);}
      };
      const observer = new MutationObserver(syncWindowButtons);
      observer.observe(workspace, {attributes: true, attributeFilter: ['class']});
      observer.observe(page, {attributes: true, attributeFilter: ['class']});
      syncWindowButtons();
    }
    brand?.addEventListener('click', event => {event.preventDefault();switchPage('agents');});
    notice = document.createElement('div');notice.className = 'desktop-connection';notice.hidden = true;
    text = document.createElement('span');text.setAttribute('role','status');text.setAttribute('aria-live','polite');
    retry = document.createElement('button');retry.className = 'text-button';retry.textContent = 'Retry';retry.onclick = () => bridge.recover('retry');
    notice.append(text,retry);document.body.append(notice);
    if (state) update(state);
    bridge.workspaceReady();
  });
})();
