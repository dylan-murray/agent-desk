// The Settings page edits the same alert preferences as the header speaker button; it keeps
// no state of its own and redraws whenever deskAlerts reports a change, here or in another tab.
(() => {
  const toggle = document.getElementById('settings-sound-enabled');
  const choices = document.querySelectorAll('input[name="settings-sound-events"]');
  function render() {
    const alerts = window.deskAlerts, on = alerts.enabled();
    toggle.setAttribute('aria-checked', String(on));
    for (const choice of choices) choice.checked = choice.value === alerts.events();
    document.getElementById('settings-sound-events').classList.toggle('muted-choices', !on);
  }
  document.getElementById('open-settings').onclick = () => { switchPage('settings'); render(); };
  toggle.onclick = () => window.deskAlerts.setEnabled(!window.deskAlerts.enabled());
  for (const choice of choices) choice.onchange = () => { if (choice.checked) window.deskAlerts.setEvents(choice.value); };
  for (const button of document.querySelectorAll('.settings-preview')) button.onclick = () => window.deskAlerts.preview(button.dataset.preview);
  document.addEventListener('desk-alerts-change', render);
  render();
})();
