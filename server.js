import http from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { compareCommits } from './server/git.js';
import { analyzeWithAgent } from './server/agent.js';
const root = dirname(fileURLToPath(import.meta.url));
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
function validate(input, records, selfId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem('A fix must be an object.');
  const out = {};
  for (const field of ['error', 'file', 'rootCause', 'fixSummary', 'evidence', 'category', 'baseSha', 'commitSha']) {
    const value = input[field] ?? '';
    if (typeof value !== 'string' || value.length > 10000) throw problem(`${field} must be text under 10,000 characters.`);
    out[field] = value.trim();
  }
  for (const field of ['error', 'file', 'rootCause', 'fixSummary']) if (!out[field]) throw problem(`${field} is required.`);
  for (const field of ['baseSha','commitSha']) if (out[field] && !/^[a-f0-9]{7,40}$/i.test(out[field])) throw problem(`${field} must be a commit SHA.`);
  out.category ||= 'Uncategorized';
  if (input.reviewed !== undefined && typeof input.reviewed !== 'boolean') throw problem('reviewed must be a boolean.');
  out.reviewed = input.reviewed ?? false;
  out.similarMatch = input.similarMatch ?? [];
  if (!Array.isArray(out.similarMatch) || out.similarMatch.length > 50) throw problem('similarMatch must be an array of at most 50 matches.');
  const ids = new Set();
  out.similarMatch = out.similarMatch.map(m => {
    if (!m || typeof m.errorId !== 'string' || m.errorId === selfId || ids.has(m.errorId) || !records.some(r => r.errorId === m.errorId) || typeof m.score !== 'number' || !Number.isFinite(m.score) || m.score < 0 || m.score > 100) throw problem('Each similar match needs a different existing errorId and a score from 0 to 100.');
    ids.add(m.errorId); return { errorId: m.errorId, score: m.score };
  });
  return out;
}
export async function createApp(options = {}) {
  const config = { repoPath: resolve(process.env.REPO_PATH || root), dataFile: resolve(process.env.DATA_FILE || join(root, 'data/logs.json')), agentUrl: process.env.AI_AGENT_URL, agentKey: process.env.AI_AGENT_KEY, ...options };
  let records;
  try { records = JSON.parse(await readFile(config.dataFile, 'utf8')); if (!Array.isArray(records)) throw new Error('Expected a JSON array'); }
  catch (e) { if (e.code === 'ENOENT') records = []; else throw new Error(`Unable to load logs: ${e.message}`); }
  let queue = Promise.resolve();
  const mutate = fn => {
    const next = queue.then(async () => {
      const copy = structuredClone(records); const result = fn(copy);
      await mkdir(dirname(config.dataFile), { recursive: true });
      await writeFile(`${config.dataFile}.tmp`, JSON.stringify(copy, null, 2));
      await rename(`${config.dataFile}.tmp`, config.dataFile); records = copy; return result;
    }); queue = next.catch(() => {}); return next;
  };
  return http.createServer(async (req, res) => {
    function send(status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); }
    try {
      // Local app: reject browser requests originating from another website.
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw problem('Invalid host.', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw problem('Cross-origin requests are not allowed.', 403);
      const path = new URL(req.url, `http://${host}`).pathname;
      if (path.startsWith('/api/')) {
        if (req.method === 'GET' && path === '/api/config') return send(200, { agentConfigured: Boolean(config.agentUrl), repository: config.repoPath, storage: 'Local JSON file' });
        if (req.method === 'GET' && path === '/api/logs') return send(200, records);
        if (!['POST', 'PUT'].includes(req.method)) throw problem('Endpoint not found.', 404);
        if (!req.headers['content-type']?.startsWith('application/json')) throw problem('Use Content-Type: application/json.', 415);
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) throw problem('Request too large.', 413); }
        let input; try { input = JSON.parse(raw); } catch { throw problem('Invalid JSON.'); }
        if (path === '/api/logs' && req.method === 'POST') {
          const result = await mutate(copy => { const log = { ...validate(input, copy), errorId: `ERR-${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; copy.unshift(log); return log; });
          return send(201, result);
        }
        if (path.startsWith('/api/logs/') && req.method === 'PUT') {
          const id = decodeURIComponent(path.slice('/api/logs/'.length));
          const result = await mutate(copy => { const index = copy.findIndex(r => r.errorId === id); if (index < 0) throw problem('Log not found.', 404); copy[index] = { ...copy[index], ...validate(input, copy, id), updatedAt: new Date().toISOString() }; return copy[index]; });
          return send(200, result);
        }
        if (['/api/compare', '/api/analyze'].includes(path) && req.method === 'POST') {
          const comparison = await compareCommits(config.repoPath, input?.baseSha, input?.headSha);
          if (path === '/api/compare') return send(200, comparison);
          const fixes = comparison.diff ? await analyzeWithAgent(comparison, records, config) : [];
          let drafts;
          try { drafts = fixes.map(f => { const clean = validate({ ...f, reviewed: false, baseSha: comparison.baseSha, commitSha: comparison.headSha }, records); if (!comparison.files.includes(clean.file)) throw problem('Agent returned a file outside the diff.'); return clean; }); }
          catch (e) { throw problem(`Invalid agent response: ${e.message}`, 502); }
          return send(200, { comparison, drafts });
        }
        throw problem('Endpoint not found.', 404);
      }
      if (req.method !== 'GET') throw problem('Method not allowed.', 405);
      const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/api.html': 'api.html', '/api.js': 'api.js' };
      if (!files[path]) throw problem('Page not found.', 404);
      const file = files[path]; const body = await readFile(join(root, 'dist', file));
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/css', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
    } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Server error. Check the local server configuration.' }); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp(); server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`FixLog running at http://127.0.0.1:${server.address().port}`));
}
