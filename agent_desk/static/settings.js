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

// Focus glow: on/off and brightness, saved per browser, applied as --glow on the root.
(() => {
  const KEY = 'agent-desk-focus-glow';
  const toggle = document.getElementById('settings-glow-enabled');
  const slider = document.getElementById('settings-glow-strength');
  const value = document.getElementById('settings-glow-value');
  let glow = { on: true, strength: 100 };
  try { glow = { ...glow, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
  const clamp = n => Math.min(200, Math.max(25, Math.round(Number(n) / 5) * 5 || 100));
  glow.strength = clamp(glow.strength);
  function apply() {
    document.documentElement.style.setProperty('--glow', glow.on ? String(glow.strength / 100) : '0');
    toggle.setAttribute('aria-checked', String(glow.on));
    slider.value = glow.strength; slider.disabled = !glow.on; value.textContent = glow.strength + '%';
    document.getElementById('settings-glow-strength-row').classList.toggle('muted-choices', !glow.on);
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(glow)); } catch {} apply(); }
  toggle.onclick = () => { glow.on = !glow.on; save(); };
  slider.oninput = () => { glow.strength = clamp(slider.value); save(); };
  window.addEventListener('storage', event => { if (event.key !== KEY) return; try { glow = { on: true, strength: 100, ...JSON.parse(event.newValue || '{}') }; glow.strength = clamp(glow.strength); } catch {} apply(); });
  apply();
})();
