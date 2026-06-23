// GitHub OAuth + REST 帮助（一键连接 / 建仓 / 开 PR）。docx §4.10 后续能力。
// 平台需注册一个 GitHub OAuth App，把 client id/secret 填入 conduit.env。
// access token 存在 conduit 侧（不进容器、不回显、日志脱敏）。
const CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET || '';
const SCOPE = process.env.GITHUB_OAUTH_SCOPE || 'repo';
// 平台公开根地址（用于拼回调）；也可直接给完整 GITHUB_OAUTH_CALLBACK
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const CALLBACK = process.env.GITHUB_OAUTH_CALLBACK || (PUBLIC_BASE_URL ? PUBLIC_BASE_URL + '/api/github/oauth/callback' : '');

const API = 'https://api.github.com';
const UA = 'cloud-ai-bridge';

function isConfigured() { return !!(CLIENT_ID && CLIENT_SECRET); }
function callbackUrl(req) {
  if (CALLBACK) return CALLBACK;
  // 回退：从反代头推导（trust proxy 已开）
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/github/oauth/callback`;
}
function authorizeUrl(state, req) {
  const p = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: callbackUrl(req), scope: SCOPE, state, allow_signup: 'false' });
  return 'https://github.com/login/oauth/authorize?' + p.toString();
}

async function exchangeCode(code, req) {
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: callbackUrl(req) })
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(data.error_description || data.error || '换取 token 失败');
  return data.access_token;
}

async function gh(token, method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data = {}; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!r.ok) {
    const msg = data.message || `GitHub API ${r.status}`;
    const err = new Error(msg); err.status = r.status; err.data = data; throw err;
  }
  return data;
}

async function getUser(token) { const u = await gh(token, 'GET', '/user'); return { login: u.login, name: u.name, avatar: u.avatar_url }; }
async function createRepo(token, name, isPrivate) {
  const repo = await gh(token, 'POST', '/user/repos', { name, private: !!isPrivate, auto_init: false });
  return { fullName: repo.full_name, htmlUrl: repo.html_url, cloneUrl: repo.clone_url, defaultBranch: repo.default_branch || 'main' };
}
async function getRepo(token, owner, repo) {
  const r = await gh(token, 'GET', `/repos/${owner}/${repo}`);
  return { fullName: r.full_name, htmlUrl: r.html_url, defaultBranch: r.default_branch || 'main' };
}
// 开 PR；若该 head→base 已有 PR，返回已存在的
async function openPR(token, owner, repo, { title, head, base, body }) {
  try {
    const pr = await gh(token, 'POST', `/repos/${owner}/${repo}/pulls`, { title, head, base, body });
    return { number: pr.number, htmlUrl: pr.html_url, created: true };
  } catch (e) {
    // 422 常见：已存在 PR 或无差异
    if (e.status === 422) {
      const list = await gh(token, 'GET', `/repos/${owner}/${repo}/pulls?head=${owner}:${head}&base=${base}&state=open`).catch(() => []);
      if (Array.isArray(list) && list.length) return { number: list[0].number, htmlUrl: list[0].html_url, created: false };
    }
    throw e;
  }
}

module.exports = { isConfigured, authorizeUrl, callbackUrl, exchangeCode, getUser, createRepo, getRepo, openPR, SCOPE };
