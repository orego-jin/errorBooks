import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function compareCommits(repoPath, baseSha, headSha) {
  if (![baseSha, headSha].every(s => typeof s === 'string' && /^[a-f0-9]{7,40}$/i.test(s))) {
    throw Object.assign(new Error('Provide two hexadecimal commit IDs (7–40 characters).'), { status: 400 });
  }
  async function git(args) {
    try { return (await exec('git', ['-C', repoPath, ...args], { maxBuffer: 2 * 1024 * 1024, timeout: 15000 })).stdout; }
    catch { throw Object.assign(new Error('Git comparison failed. Check REPO_PATH, fetch both commits, and keep the diff under 2 MB.'), { status: 422 }); }
  }
  const base = (await git(['rev-parse', '--verify', `${baseSha}^{commit}`])).trim();
  const head = (await git(['rev-parse', '--verify', `${headSha}^{commit}`])).trim();
  const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--unified=3', base, head, '--']);
  const files = (await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, head, '--'])).split('\0').filter(Boolean);
  return { baseSha: base, headSha: head, files, diff };
}
