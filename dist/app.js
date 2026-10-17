const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let records = [], selected = null, expanded = null, view = 'all', editing = null, draftIndex = null, drafts = [], comparison = null;
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data;
}
async function load() { records = await api('/api/logs'); if (!records.some(r => r.errorId === selected)) selected = records[0]?.errorId; render(); }
function render() {
  const q = $('search').value.toLowerCase(), status = $('filter').value;
  const filtered = records.filter(r => (view !== 'similar' || r.similarMatch.length) && (status === 'all' || r.reviewed === (status === 'confirmed')) && [r.errorId,r.error,r.file,r.rootCause,r.fixSummary].some(v => v.toLowerCase().includes(q)));
  $('rows').innerHTML = filtered.map(r => `<tr class="${r.errorId === selected ? 'selected' : ''}"><td><button class="id-button" data-expand="${esc(r.errorId)}" aria-expanded="${expanded === r.errorId}">${expanded === r.errorId ? '▾' : '▸'} ${esc(r.errorId)}</button></td><td>${esc(r.error)}</td><td>${esc(r.file)}</td><td>${esc(r.rootCause)}</td><td>${esc(r.fixSummary)}</td><td>${r.similarMatch.map(m => `<button class="match-button" data-id="${esc(m.errorId)}"><span class="badge">${m.score}% ↗</span><small>${esc(m.errorId)}</small></button>`).join('') || 'No match yet'}</td></tr>${expanded === r.errorId ? `<tr class="expanded"><td colspan="6"><div class="expanded-content"><div><strong>Evidence & notes</strong><p>${esc(r.evidence || 'No evidence recorded.')}</p><span class="path">${esc(r.baseSha || 'No base SHA')} → ${esc(r.commitSha || 'No commit SHA')}</span><p>${r.reviewed ? 'Confirmed' : 'Needs review'} · ${esc(r.category)} · Updated ${esc(r.updatedAt)}</p></div><button class="primary" data-edit="${esc(r.errorId)}">Edit log ↗</button></div></td></tr>` : ''}`).join('') || '<tr><td colspan="6">No logs found. Create your first fix post or compare two commits.</td></tr>';
  $('count').textContent = `Showing ${filtered.length} of ${records.length} records`;
  $('total').textContent = records.length; $('patterns').textContent = new Set(records.map(r => r.category)).size;
  $('matched').textContent = records.filter(r => r.similarMatch.length).length; $('review').textContent = records.filter(r => !r.reviewed).length;
  const r = records.find(r => r.errorId === selected);
  if (!r) { $('insight').textContent = 'Create a fix post to build your codebase memory.'; $('related').textContent = 'Related fixes will appear here.'; return; }
  $('insight').innerHTML = `<span class="badge">${esc(r.errorId)}</span><h3>${esc(r.error)}</h3><p class="path">${esc(r.file)}</p><p class="summary">${esc(r.fixSummary)}</p><div class="detail-label">Root cause</div><p class="detail-value">${esc(r.rootCause)}</p><div class="detail-label">Evidence</div><p class="detail-value">${esc(r.evidence || 'Not recorded')}</p><p>${r.reviewed ? '✓ Confirmed' : 'Needs review'}</p><button class="review-btn" data-edit="${esc(r.errorId)}">Edit this log ↗</button>`;
  $('related').innerHTML = r.similarMatch.map(m => { const t = records.find(t => t.errorId === m.errorId); return t ? `<button class="related-item" data-id="${esc(t.errorId)}"><span>${esc(t.errorId)} · ${m.score}% match ↗</span><strong>${esc(t.error)}</strong></button>` : ''; }).join('') || 'No related fixes yet.';
}
function openEditor(record = {}, index = null) {
  editing = record.errorId || null; draftIndex = index;
  $('edit-form').reset(); $('editor-status').textContent = '';
  $('editor-title').textContent = editing ? `Edit ${editing}` : index !== null ? 'Review agent draft' : 'New fix post';
  for (const field of ['error','file','rootCause','fixSummary','evidence','category','baseSha','commitSha']) $('edit-form').elements[field].value = record[field] || '';
  $('edit-form').elements.reviewed.checked = record.reviewed || false;
  $('edit-form').elements.matches.value = (record.similarMatch || []).map(m => `${m.errorId},${m.score}`).join('\n');
  $('editor').showModal();
}
$('edit-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form)); body.reviewed = form.elements.reviewed.checked;
    body.similarMatch = body.matches.trim() ? body.matches.trim().split('\n').map(line => { const parts = line.split(','); if (parts.length !== 2 || !parts[1].trim()) throw new Error('Use errorId,score for each similar match.'); return { errorId: parts[0].trim(), score: Number(parts[1]) }; }) : []; delete body.matches;
    const result = await api(editing ? `/api/logs/${encodeURIComponent(editing)}` : '/api/logs', editing ? 'PUT' : 'POST', body);
    selected = expanded = result.errorId;
    if (draftIndex !== null) { drafts.splice(draftIndex, 1); renderDrafts(); }
    $('editor').close(); await load();
  } catch (error) { $('editor-status').textContent = error.message; } finally { button.disabled = false; }
};
$('new-log').onclick = () => openEditor(); $('close-editor').onclick = () => $('editor').close();
document.addEventListener('click', event => {
  const edit = event.target.closest('[data-edit]'); if (edit) return openEditor(records.find(r => r.errorId === edit.dataset.edit));
  const draft = event.target.closest('[data-draft]'); if (draft) return openEditor(drafts[Number(draft.dataset.draft)], Number(draft.dataset.draft));
  const target = event.target.closest('[data-expand],[data-id]');
  if (target) { selected = target.dataset.expand || target.dataset.id; expanded = target.dataset.expand && expanded === selected ? null : selected; render(); }
});
$('search').oninput = render; $('filter').onchange = render;
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { view = button.dataset.view; document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button)); $('table-title').textContent = view === 'similar' ? '↗ Similar issue matches' : '▤ Fix logs'; render(); });
function status(message) { $('analysis-status').hidden = false; $('analysis-status').textContent = message; }
function renderDrafts() { $('drafts').innerHTML = drafts.length ? `<h3>Agent drafts · review before saving</h3>${drafts.map((d,i) => `<div class="draft"><strong>${esc(d.error)}</strong><p>${esc(d.fixSummary)}</p><button class="primary" data-draft="${i}">Review & save</button></div>`).join('')}` : ''; }
$('analyze-form').onsubmit = async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; $('run-agent').disabled = true; comparison = null; $('diff-panel').hidden = true; drafts = []; renderDrafts(); status('Comparing commits…');
  try { comparison = await api('/api/compare', 'POST', { baseSha: $('base').value.trim(), headSha: $('head').value.trim() }); $('diff-panel').hidden = false; $('diff-panel').open = true; $('diff-output').textContent = comparison.diff || 'No changes between these commits.'; status(`${comparison.files.length} changed files. Inspect the diff before sending it to your agent.`); $('run-agent').disabled = !comparison.diff; }
  catch (error) { status(error.message); } finally { button.disabled = false; }
};
$('run-agent').onclick = async () => {
  if (!comparison) return; $('run-agent').disabled = true; status('Agent is analyzing the diff…');
  try { const result = await api('/api/analyze', 'POST', { baseSha: comparison.baseSha, headSha: comparison.headSha }); drafts = result.drafts; renderDrafts(); status(`${drafts.length} draft fixes returned. Review each draft and save it as a post.`); } catch (error) { status(error.message); } finally { $('run-agent').disabled = false; }
};
$('export').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(records,null,2)],{type:'application/json'})); const a = document.createElement('a'); a.href = url; a.download = 'fixlog-records.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); };
load().catch(error => { render(); $('page-status').textContent = `Cannot load records: ${error.message}. Start the Node server with npm start and open http://127.0.0.1:3000.`; });
