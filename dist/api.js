async function refresh() {
  const status = document.getElementById('config-status');
  try { const response = await fetch('/api/config'); if (!response.ok) throw new Error('Start the Node server to read connection status.'); const config = await response.json(); status.textContent = `Agent: ${config.agentConfigured ? 'Endpoint configured (availability checked when analyzing)' : 'Not configured'}\nRepository: ${config.repository}\nStorage: ${config.storage}`; }
  catch (error) { status.textContent = error.message; }
}
document.getElementById('refresh').onclick = refresh; refresh();
