(() => {
  const bridge = window.agentDeskDesktop, status = document.getElementById('status'), retry = document.getElementById('retry');
  let revision = -1;
  function update(state) {
    if (state.revision < revision) return;revision = state.revision;
    status.textContent = state.error || (state.stage === 'setup' ? 'Setting up Agent Desk…' : 'Opening your workspace…');
    retry.hidden = !state.error;retry.disabled = state.connection === 'preparing';
  }
  bridge.subscribe(update);bridge.snapshot().then(update);
  retry.onclick = () => {retry.disabled = true;void bridge.recover('retry');};
})();
