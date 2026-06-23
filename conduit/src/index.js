const http = require('http');
const os = require('os');
const url = require('url');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const express = require('express');
const httpProxy = require('http-proxy');
const cookie = require('cookie');
const { WebSocketServer, WebSocket } = require('ws');

const auth = require('./auth');
const orchestrator = require('./orchestrator');
const metrics = require('./metrics');
const mailer = require('./mailer');
const github = require('./github');

const PORT = process.env.PORT || 8080;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1'; // HTTPS 反代后置 1
const PREVIEW_TTL_MIN = parseInt(process.env.PREVIEW_TTL_MIN || '30', 10);
const MAX_PREVIEW_PER_PROJECT = parseInt(process.env.MAX_PREVIEW_PER_PROJECT || '3', 10);
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS || String(5 * 60 * 1000), 10);
const MAX_WS_PER_USER = parseInt(process.env.MAX_WS_PER_USER || '4', 10); // 每用户并发 WS 上限（docx §5.2 防滥用）
const EGRESS_LIMIT_MB = parseInt(process.env.EGRESS_LIMIT_MB || '2048', 10);        // 单容器出站流量上限，超则强停（§5.2）；0=不限
const WORKSPACE_QUOTA_MB = parseInt(process.env.WORKSPACE_QUOTA_MB || '2048', 10);  // 单 workspace 磁盘软配额（§4.4）；0=不限
const BACKUP_MAX_MB = parseInt(process.env.BACKUP_MAX_MB || '1024', 10);            // 单备份体积上限（§5.2）；0=不限
const RESOURCE_GUARD_INTERVAL_MS = parseInt(process.env.RESOURCE_GUARD_INTERVAL_MS || '120000', 10);
const MAX_BODY = process.env.MAX_BODY || '512kb'; // 请求体上限（§5.2 上传大小限制；本原型无文件上传，仅保护 JSON 接口）
const HERMES_FEATURE_ENABLED = process.env.HERMES_FEATURE_ENABLED !== '0'; // 平台级 Hermes 总开关

const app = express();
app.set('trust proxy', true); // 置于 nginx 反代后，req.ip 取 X-Forwarded-For 真实客户端 IP
const server = http.createServer(app);
const proxy = httpProxy.createProxyServer({});

// 客户端真实 IP（反代后取 XFF 链最左，回退 socket）
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return auth.normIp(xff || req.ip || (req.socket && req.socket.remoteAddress) || '');
}

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});
app.use(express.json({ limit: MAX_BODY }));
app.use(express.static(path.join(__dirname, '../public')));

// 连接映射表（key 均为服务端私有 channelToken）
const sandboxes = new Map();
const clients = new Map();         // token => Set<ws>（一个房间可有多个成员同时在线）
const clientMeta = new WeakMap();  // ws => { userId, projectId }（广播在线成员用）
const clientConnCount = new Map(); // userId => 当前并发 client WS 数（§5.2 限流）
const pendingCredentials = new Map();

// 向房间内所有在线 client 广播
function broadcastToRoom(token, packet) {
  const set = clients.get(token); if (!set) return;
  const msg = typeof packet === 'string' ? packet : JSON.stringify(packet);
  for (const ws of set) { if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch (e) {} } }
}
// 房间在线成员用户名列表
function roomMembers(token) {
  const set = clients.get(token); if (!set) return [];
  const names = new Set();
  for (const ws of set) { const m = clientMeta.get(ws); if (m) names.add(m.userId); }
  return [...names];
}
const previewTokens = new Map(); // pt => { userId, ownerId, projectId, port, expiresAt }

const WORKSPACE_BASE = process.env.AI_SANDBOX_WORKSPACE_BASE
  ? path.resolve(process.env.AI_SANDBOX_WORKSPACE_BASE)
  : path.resolve(__dirname, '../../workspace/users');
const BACKUP_BASE = process.env.AI_SANDBOX_BACKUP_BASE
  ? path.resolve(process.env.AI_SANDBOX_BACKUP_BASE)
  : path.resolve(__dirname, '../backups/users');
// 社区快照（发布时把项目打成只读副本，沙箱到期也能看/下载）
const COMMUNITY_BASE = process.env.AI_SANDBOX_COMMUNITY_DIR
  ? path.resolve(process.env.AI_SANDBOX_COMMUNITY_DIR)
  : path.resolve(__dirname, '../community');

// Windows 上可能是 GNU tar（需要 --force-local）或 bsdtar（不支持该参数），运行时自动回退。
const TAR_CANDIDATES = process.platform === 'win32' ? ['tar --force-local', 'tar'] : ['tar'];
function runTar(args, options = {}) {
  return new Promise((resolve, reject) => {
    const tryAt = (i, lastErr, lastStderr) => {
      if (i >= TAR_CANDIDATES.length) {
        const err = lastErr || new Error('tar failed');
        err.stderr = lastStderr || err.stderr || err.message;
        reject(err);
        return;
      }
      exec(`${TAR_CANDIDATES[i]} ${args}`, options, (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr });
        tryAt(i + 1, err, stderr);
      });
    };
    tryAt(0);
  });
}

// 日志脱敏：发给前端/admin 前抹掉疑似密钥
function redact(s) {
  if (!s) return '';
  return String(s)
    .replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-****')
    .replace(/gh[pousr]_[A-Za-z0-9]{6,}/g, 'gh_****')
    .replace(/[A-Fa-f0-9]{32,}/g, '****');
}

function ensureDirSync(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// 磁盘占用百分比（workspace 所在分区）。Windows/无 df 时返回 null（不拦截）。
// docx §5.2/§10：>80% 告警、>90% 自动停免费创建/激活，防爆盘导致账单失控或误删。
const DISK_WARN_PCT = +(process.env.DISK_WARN_PCT || 80);
const DISK_BLOCK_PCT = +(process.env.DISK_BLOCK_PCT || 90);
async function diskUsePct() {
  if (process.platform === 'win32') return null;
  try {
    const out = await new Promise((resolve) =>
      exec(`df -P "${WORKSPACE_BASE}" 2>/dev/null | tail -1`, { timeout: 6000 }, (e, o) => resolve(e ? '' : String(o))));
    const m = out.match(/(\d+)%/);
    return m ? parseInt(m[1], 10) : null;
  } catch (e) { return null; }
}
// 返回 {block:bool, pct} —— block=true 表示磁盘超阈值应拒绝新建/激活（管理员豁免在调用处判断）
async function diskGuard() {
  const pct = await diskUsePct();
  if (pct == null) return { block: false, pct: null };
  if (pct >= DISK_WARN_PCT) console.warn(`[DiskGuard] workspace 分区已用 ${pct}% (warn=${DISK_WARN_PCT} block=${DISK_BLOCK_PCT})`);
  return { block: pct >= DISK_BLOCK_PCT, pct };
}
// 目录占用（MB）。Windows/出错返回 null。
async function duMB(dir) {
  if (process.platform === 'win32') return null;
  try {
    const out = await new Promise((resolve) =>
      exec(`du -sm "${dir}" 2>/dev/null`, { timeout: 15000 }, (e, o) => resolve(e ? '' : String(o))));
    const m = out.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch (e) { return null; }
}

function sessionCookie(sid) {
  return cookie.serialize(auth.SESSION_COOKIE, sid, {
    httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/',
    maxAge: Math.floor(auth.SESSION_TTL_MS / 1000)
  });
}
function clearCookie() {
  return cookie.serialize(auth.SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/', maxAge: 0 });
}

function projectPaths(userId, projectId) {
  return {
    projectDir: path.join(WORKSPACE_BASE, userId, projectId),
    userConfigDir: path.join(WORKSPACE_BASE, userId, '.config'),
    claudeDir: path.join(WORKSPACE_BASE, userId, '.claude'),
    codexDir: path.join(WORKSPACE_BASE, userId, '.codex')
  };
}
// Hermes 记忆/数据与项目 workspace 分开存储（docx §7）
function hermesDir(userId) { return path.join(WORKSPACE_BASE, userId, '.hermes'); }

function pushCredentials(channelToken, creds) {
  if (!channelToken || !creds || !Object.keys(creds).length) return;
  const sb = sandboxes.get(channelToken);
  if (sb && sb.ws.readyState === WebSocket.OPEN) sb.ws.send(JSON.stringify({ event: 'init-env', data: creds }));
  else pendingCredentials.set(channelToken, creds);
}

// 断开某通道的沙箱/客户端连接，并清理其暂存凭证与预览 token
function disconnectChannel(token, projectId) {
  if (!token) return;
  const sb = sandboxes.get(token);
  if (sb) { try { sb.ws.close(4009, 'channel closed'); } catch (e) {} sandboxes.delete(token); }
  const set = clients.get(token);
  if (set) {
    for (const c of set) { try { c.send(JSON.stringify({ event: 'output', data: '\r\n\x1b[31m[System] 会话已关闭。\x1b[0m\r\n' })); c.close(); } catch (e) {} }
    clients.delete(token);
  }
  pendingCredentials.delete(token);
  if (projectId) for (const [k, v] of previewTokens) if (v.projectId === projectId) previewTokens.delete(k);
}

// 备份项目 workspace（CleanupWorker 与备份接口共用）
function backupProject(userId, projectId) {
  return new Promise(async (resolve) => {
    const { projectDir } = projectPaths(userId, projectId);
    if (!fs.existsSync(projectDir)) return resolve({ skipped: true });
    const dir = path.join(BACKUP_BASE, userId);
    ensureDirSync(dir);
    const file = path.join(dir, `${projectId}.tar.gz`);
    try {
      await runTar(`-czf "${file}" .`, { cwd: projectDir });
      // 备份体积上限（§5.2）：超限删除并报错，防止超大备份塞满磁盘
      if (BACKUP_MAX_MB > 0) {
        try {
          const mb = fs.statSync(file).size / 1e6;
          if (mb > BACKUP_MAX_MB) {
            fs.rmSync(file, { force: true });
            return resolve({ ok: false, error: `备份体积 ${mb.toFixed(0)}MB 超过上限 ${BACKUP_MAX_MB}MB`, tooLarge: true });
          }
        } catch (e) {}
      }
      resolve({ ok: true, path: file });
    } catch (err) {
      console.error('[Backup Error]', err.stderr || err.message);
      resolve({ ok: false, error: err.stderr || err.message });
    }
  });
}

// 容器停止时累计运行时长（算平均；§10）
function noteContainerStop(userId, projectId) {
  const u = auth.getUserById(userId); if (!u) return;
  const p = auth.getProject(u, projectId);
  if (p && p.runningSince) {
    metrics.recordContainerRuntime(Date.now() - p.runningSince);
    auth.updateProject(userId, projectId, { runningSince: null });
  }
}

function wipeDir(dir, attempt = 0) {
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) {
    if (attempt < 2) return setTimeout(() => wipeDir(dir, attempt + 1), 1000);
    console.error('[Wipe Error]', dir, e.message);
  }
}

// 彻底销毁项目数据（容器 + workspace + 备份），可选删除账号里的项目记录
function destroyProjectData(userId, projectId, channelToken, { removeBackup = true, removeRecord = false } = {}) {
  noteContainerStop(userId, projectId); // 销毁前先结算运行时长（记录会被清）
  disconnectChannel(channelToken, projectId);
  orchestrator.removeSandbox({ userId, projectId }).catch((e) => console.warn('[Destroy] container:', e.message));
  const { projectDir } = projectPaths(userId, projectId);
  setTimeout(() => wipeDir(projectDir), 600);
  if (removeBackup) {
    const f = path.join(BACKUP_BASE, userId, `${projectId}.tar.gz`);
    if (fs.existsSync(f)) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  }
  if (removeRecord) { const u = auth.getUserById(userId); if (u) auth.deleteProject(u, projectId); }
}

// =====================================================================
// 账号 / 会话
// =====================================================================
app.post('/api/auth/register', async (req, res) => {
  const s = auth.getSettings();
  if (!s.registrationEnabled) return res.status(403).json({ error: '注册已关闭' });
  const ip = clientIp(req);
  if (auth.isIpBanned(ip)) return res.status(403).json({ error: '该网络已被封禁' });
  if (auth.countRegisterToday(ip) >= auth.MAX_REGISTER_PER_IP_PER_DAY) {
    metrics.bump('registerBlockedIp');
    return res.status(429).json({ error: `同一网络每天最多注册 ${auth.MAX_REGISTER_PER_IP_PER_DAY} 个账号` });
  }
  const { username, password, email } = req.body;
  try {
    // 邮箱激活流程：创建未激活账号 → 发激活码（不签发会话，激活后才登录）
    const user = await auth.registerUser(username, password, { email, ip });
    auth.recordRegister(ip);
    metrics.recordFunnel('register');
    const code = auth.issueActivationCode(user);
    const r = await mailer.sendActivationCode(user.email, code).catch((e) => ({ error: e.message }));
    if (r && r.error) return res.status(502).json({ error: '激活邮件发送失败：' + r.error });
    res.json({ pendingActivation: true, email: user.email, devMode: !!(r && r.dev), devCode: r && r.dev ? r.code : undefined });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 邮箱激活：校验激活码 → 激活并登录（签发会话）
app.post('/api/auth/activate', async (req, res) => {
  const ip = clientIp(req);
  if (auth.isIpBanned(ip)) return res.status(403).json({ error: '该网络已被封禁' });
  try {
    const user = auth.verifyActivation(req.body.email, req.body.code);
    if (user.banned) return res.status(403).json({ error: '账号已被封禁' });
    auth.setUserIp(user.id, 'lastLoginIp', ip);
    const sid = auth.createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(sid));
    res.json({ username: user.id, isAdmin: auth.isAdmin(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 重发激活码（带频率限制）
app.post('/api/auth/resend', async (req, res) => {
  const user = auth.getUserByEmail(req.body.email);
  if (!user) return res.status(404).json({ error: '账号不存在' });
  if (user.activated) return res.json({ ok: true, alreadyActivated: true });
  if (!auth.canResend(user)) return res.status(429).json({ error: '发送过于频繁，请稍后再试' });
  const code = auth.issueActivationCode(user);
  const r = await mailer.sendActivationCode(user.email, code).catch((e) => ({ error: e.message }));
  if (r && r.error) return res.status(502).json({ error: '发送失败：' + r.error });
  res.json({ ok: true, devMode: !!(r && r.dev), devCode: r && r.dev ? r.code : undefined });
});

// 找回密码：发送重置码（不暴露邮箱是否存在）
app.post('/api/auth/forgot', async (req, res) => {
  const ip = clientIp(req);
  if (auth.isIpBanned(ip)) return res.status(403).json({ error: '该网络已被封禁' });
  const user = auth.getUserByEmail(req.body.email);
  if (!user) return res.json({ ok: true }); // 不告知邮箱不存在，防枚举
  if (!auth.canResetResend(user)) return res.status(429).json({ error: '发送过于频繁，请稍后再试' });
  const code = auth.issueResetCode(user);
  const r = await mailer.sendResetCode(user.email, code).catch((e) => ({ error: e.message }));
  if (r && r.error) return res.status(502).json({ error: '发送失败：' + r.error });
  res.json({ ok: true, devMode: !!(r && r.dev), devCode: r && r.dev ? r.code : undefined });
});
// 用重置码设置新密码（成功后旧会话全失效，需用新密码登录）
app.post('/api/auth/reset', async (req, res) => {
  const ip = clientIp(req);
  if (auth.isIpBanned(ip)) return res.status(403).json({ error: '该网络已被封禁' });
  try {
    const user = await auth.verifyResetAndSetPassword(req.body.email, req.body.code, req.body.newPassword);
    res.json({ ok: true, username: user.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  const ip = clientIp(req);
  if (auth.isIpBanned(ip)) return res.status(403).json({ error: '该网络已被封禁' });
  const user = await auth.verifyLogin(req.body.username, req.body.password);
  if (!user) { metrics.bump('failedLogins'); return res.status(401).json({ error: '用户名或密码错误' }); }
  if (user.banned) return res.status(403).json({ error: '账号已被封禁' });
  if (user.activated === false) return res.status(403).json({ error: '邮箱未激活，请先用激活码激活', code: 'NOT_ACTIVATED', email: user.email });
  auth.setUserIp(user.id, 'lastLoginIp', ip);
  const sid = auth.createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(sid));
  res.json({ username: user.id, isAdmin: auth.isAdmin(user) });
});

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(auth.parseCookies(req)[auth.SESSION_COOKIE]);
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = auth.getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  if (user.banned) return res.status(403).json({ error: '账号已被封禁' });
  res.json({ username: user.id, isAdmin: auth.isAdmin(user), settings: auth.getSettings(), projects: auth.listProjects(user) });
});

// =====================================================================
// 项目
// =====================================================================
app.get('/api/projects', auth.requireAuth, (req, res) => {
  res.json({ projects: auth.listProjects(req.user) });
});

app.post('/api/projects', auth.requireAuth, async (req, res) => {
  const s = auth.getSettings();
  const admin = auth.isAdmin(req.user);
  if (!s.projectCreationEnabled && !admin) return res.status(403).json({ error: '项目创建已暂时关闭' });
  // 已存在则幂等返回；只有"新建"才计入每日配额
  const existing = auth.getProject(req.user, req.body.projectId);
  if (!existing && !admin) {
    const dg = await diskGuard();
    if (dg.block) return res.status(503).json({ error: `服务器磁盘紧张（已用 ${dg.pct}%），暂停新建项目，请稍后再试` });
    if (auth.countCreatedToday(req.user) >= auth.MAX_CREATE_PER_DAY) {
      return res.status(429).json({ error: `每天最多创建 ${auth.MAX_CREATE_PER_DAY} 个免费项目` });
    }
  }
  try {
    const proj = auth.getOrCreateProject(req.user, req.body.projectId);
    if (!existing) metrics.recordFunnel('createProject');
    res.json({ projectId: proj.projectId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/creds', auth.requireAuth, (req, res) => {
  try {
    const projectId = auth.sanitizeId(req.body.projectId);
    if (!projectId) return res.status(400).json({ error: 'projectId 非法' });
    auth.getOrCreateProject(req.user, projectId);
    const saved = auth.setProjectCreds(req.user, projectId, req.body.creds || req.body);
    pushCredentials(auth.resolveChannel(req.user, projectId), saved);
    res.json({ ok: true, bound: Object.keys(saved) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// =====================================================================
// Hermes 云端秘书（docx §7）：默认关闭、用户级、严格隔离、可审计
// =====================================================================
function hermesAudit(userId, action, extra) {
  console.log(`[HermesAudit] user=${userId} action=${action}${extra ? ' ' + extra : ''}`);
}
app.get('/api/hermes', auth.requireAuth, (req, res) => {
  res.json({ featureEnabled: HERMES_FEATURE_ENABLED, hermes: auth.publicHermes(req.user) });
});
app.post('/api/hermes/config', auth.requireAuth, (req, res) => {
  try { res.json(auth.setHermesConfig(req.user, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/hermes/creds', auth.requireAuth, (req, res) => {
  const saved = auth.setHermesCreds(req.user, req.body.creds || req.body || {});
  hermesAudit(req.user.id, 'bind-creds');
  res.json(saved);
});
app.post('/api/hermes/start', auth.requireAuth, async (req, res) => {
  if (!HERMES_FEATURE_ENABLED) return res.status(403).json({ error: 'Hermes 功能未开放' });
  const h = auth.publicHermes(req.user);
  if (!h.provider || !h.hasModelKey) return res.status(400).json({ error: '请先选择 provider 并绑定模型 Key' });
  if (!auth.isAdmin(req.user)) {
    const dg = await diskGuard();
    if (dg.block) return res.status(503).json({ error: `服务器磁盘紧张（已用 ${dg.pct}%），暂不能启动 Hermes` });
  }
  try {
    const hermes = { ...h, creds: auth.getHermesCreds(req.user) }; // 启动时取原始凭证注入容器
    await orchestrator.startHermes({ userId: req.user.id, hermes, hermesDir: hermesDir(req.user.id) });
    const pub = auth.setHermesEnabled(req.user, true, 'RUNNING');
    hermesAudit(req.user.id, 'start', `provider=${h.provider} connectors=${Object.entries(h.connectors).filter(([, v]) => v).map(([k]) => k).join(',') || 'none'}`);
    res.json({ ok: true, hermes: pub });
  } catch (e) {
    auth.setHermesEnabled(req.user, false, 'ERROR');
    res.status(500).json({ error: 'Hermes 启动失败', details: redact(String(e.message || e)) });
  }
});
app.post('/api/hermes/stop', auth.requireAuth, async (req, res) => {
  try { await orchestrator.stopHermes({ userId: req.user.id }); } catch (e) {}
  const pub = auth.setHermesEnabled(req.user, false, 'OFF');
  hermesAudit(req.user.id, 'stop');
  res.json({ ok: true, hermes: pub });
});

// =====================================================================
// GitHub OAuth：一键连接 / 建仓 / 开 PR（host 侧，token 不入容器）
// =====================================================================
const ghStates = new Map(); // state => { userId, exp }
function newGhState(userId) {
  const state = auth.genToken(16);
  ghStates.set(state, { userId, exp: Date.now() + 10 * 60 * 1000 });
  return state;
}
function runGit(dir, args) { // args: 字符串（已自行转义）；返回 {ok,out,err}
  return new Promise((resolve) =>
    exec(`git -C "${dir}" ${args}`, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      (e, out, err) => resolve({ ok: !e, out: String(out || ''), err: String(err || '') })));
}

app.get('/api/github/status', auth.requireAuth, (req, res) => {
  res.json({ configured: github.isConfigured(), scope: github.SCOPE, github: auth.publicGithub(req.user) });
});
app.get('/api/github/oauth/start', auth.requireAuth, (req, res) => {
  if (!github.isConfigured()) return res.status(400).send('GitHub OAuth 未配置');
  const state = newGhState(req.user.id);
  res.redirect(github.authorizeUrl(state, req));
});
app.get('/api/github/oauth/callback', async (req, res) => {
  const user = auth.getUserFromRequest(req);
  const st = ghStates.get(req.query.state);
  ghStates.delete(req.query.state);
  if (!user || !st || st.userId !== user.id || Date.now() > st.exp) return res.redirect('/?github=error');
  try {
    const token = await github.exchangeCode(req.query.code, req);
    const gh = await github.getUser(token);
    auth.setGithubOAuth(user, token, gh.login);
    console.log(`[GitHub] connected user=${user.id} login=${gh.login}`);
    res.redirect('/?github=connected');
  } catch (e) {
    console.error('[GitHub] oauth callback:', redact(e.message));
    res.redirect('/?github=error');
  }
});
app.post('/api/github/disconnect', auth.requireAuth, (req, res) => {
  auth.clearGithubOAuth(req.user); res.json({ ok: true });
});
app.post('/api/github/create-repo', auth.requireAuth, async (req, res) => {
  const token = auth.getGithubToken(req.user);
  if (!token) return res.status(400).json({ error: '请先连接 GitHub' });
  const name = String(req.body.name || '').trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return res.status(400).json({ error: '仓库名非法' });
  try {
    const repo = await github.createRepo(token, name, !!req.body.private);
    res.json({ ok: true, repo });
  } catch (e) { res.status(e.status === 422 ? 409 : 502).json({ error: redact(e.message) }); }
});
// 一键提交并开 PR：host 侧在 workspace 里 commit→push→开 PR（token 仅用于 push URL，不写入 .git/config）
app.post('/api/github/pr', auth.requireAuth, async (req, res) => {
  const token = auth.getGithubToken(req.user);
  if (!token) return res.status(400).json({ error: '请先连接 GitHub' });
  const projectId = auth.sanitizeId(req.body.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId 非法' });
  const m = String(req.body.repo || '').replace(/\.git$/, '').match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)$/);
  if (!m) return res.status(400).json({ error: '仓库格式应为 owner/repo' });
  const [owner, repo] = [m[1], m[2]];
  const { projectDir } = projectPaths(req.user.id, projectId);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: '工作区不存在' });
  const ghLogin = auth.publicGithub(req.user).login || owner;
  const title = String(req.body.title || 'Update from Cloud AI Bridge').slice(0, 200);
  const body = String(req.body.body || '').slice(0, 2000);
  const branch = (auth.sanitizeId(req.body.branch) || `cab-${projectId}-${Date.now().toString(36)}`).slice(0, 80);
  try {
    const base = (await github.getRepo(token, owner, repo).catch(() => ({}))).defaultBranch || 'main';
    // 初始化 + 配置身份（不持久化 token）
    if (!(await runGit(projectDir, 'rev-parse --is-inside-work-tree')).ok) await runGit(projectDir, 'init');
    await runGit(projectDir, `config user.name "${ghLogin}"`);
    await runGit(projectDir, `config user.email "${ghLogin}@users.noreply.github.com"`);
    await runGit(projectDir, `checkout -B ${branch}`);
    await runGit(projectDir, 'add -A');
    await runGit(projectDir, `commit -m "${title.replace(/"/g, '')}"`); // 无改动会失败，忽略
    if (!(await runGit(projectDir, 'rev-parse HEAD')).ok) return res.status(400).json({ error: '工作区还没有任何提交内容' });
    // 用带 token 的临时 URL 直接 push（不写入 remote 配置，避免 token 泄漏进容器可见的 .git/config）
    const pushUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const push = await runGit(projectDir, `push "${pushUrl}" ${branch}:${branch} --force`);
    if (!push.ok) return res.status(502).json({ error: 'push 失败：' + redact(push.err || push.out) });
    // 设置一个干净的 origin（无 token），方便后续 Git 助手显示
    await runGit(projectDir, `remote remove origin`);
    await runGit(projectDir, `remote add origin https://github.com/${owner}/${repo}.git`);
    const pr = await github.openPR(token, owner, repo, { title, head: branch, base, body });
    metrics.recordFunnel('git');
    console.log(`[GitHub] PR ${pr.created ? 'opened' : 'exists'} user=${req.user.id} ${owner}/${repo}#${pr.number}`);
    res.json({ ok: true, pr, branch, base });
  } catch (e) {
    res.status(502).json({ error: redact(e.message || String(e)) });
  }
});

// =====================================================================
// 社区：用户自愿公开项目，仅本人可发布；浏览仅登录用户；快照持久化（沙箱到期也在）
// =====================================================================
const COMMUNITY_SNAP = path.join(COMMUNITY_BASE, 'snapshots');
const COMMUNITY_DL = path.join(COMMUNITY_BASE, 'dl');
const MIME = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain', '.md': 'text/plain', '.webp': 'image/webp' };

// 发布时：打 tar.gz（供下载）+ 解出静态副本（供观赏）
async function snapshotForCommunity(userId, projectId, entryId) {
  const { projectDir } = projectPaths(userId, projectId);
  if (!fs.existsSync(projectDir)) throw new Error('工作区不存在，无法发布');
  ensureDirSync(COMMUNITY_DL);
  const snapDir = path.join(COMMUNITY_SNAP, entryId);
  wipeDir(snapDir); ensureDirSync(snapDir);
  const tar = path.join(COMMUNITY_DL, `${entryId}.tar.gz`);
  // 用 cwd 而非 -C：GNU tar 在 Windows 反斜杠/盘符路径下 -C 解压会失败
  await runTar(`-czf "${tar}" .`, { cwd: projectDir });
  await runTar(`-xzf "${tar}"`, { cwd: snapDir });
}
function removeCommunitySnapshot(entryId) {
  if (!entryId) return;
  wipeDir(path.join(COMMUNITY_SNAP, entryId));
  try { fs.rmSync(path.join(COMMUNITY_DL, `${entryId}.tar.gz`), { force: true }); } catch (e) {}
}

app.get('/api/community', auth.requireAuth, (req, res) => {
  res.json({ entries: auth.listCommunity() });
});
app.post('/api/community/publish', auth.requireAuth, async (req, res) => {
  if (req.user.activated === false) return res.status(403).json({ error: '请先激活邮箱再发布' });
  const projectId = auth.sanitizeId(req.body.projectId);
  if (!projectId || !auth.getProject(req.user, projectId)) return res.status(404).json({ error: '项目不存在或不属于你' });
  try {
    const pub = auth.publishProject(req.user, projectId, { level: req.body.level, title: req.body.title, desc: req.body.desc });
    await snapshotForCommunity(req.user.id, projectId, pub.entryId); // 失败则回滚发布状态
    res.json({ ok: true, community: pub });
  } catch (e) {
    auth.unpublishProject(req.user, projectId);
    res.status(500).json({ error: '发布失败：' + redact(e.message) });
  }
});
app.post('/api/community/unpublish', auth.requireAuth, (req, res) => {
  const projectId = auth.sanitizeId(req.body.projectId);
  const p = projectId && auth.getProject(req.user, projectId);
  if (p && p.community) removeCommunitySnapshot(p.community.entryId);
  auth.unpublishProject(req.user, projectId);
  res.json({ ok: true });
});
// 下载快照：仅 level=fork 允许
app.get('/api/community/:entryId/download', auth.requireAuth, (req, res) => {
  const entry = auth.getCommunityEntry(req.params.entryId);
  if (!entry) return res.status(404).json({ error: '条目不存在' });
  if (entry.community.level !== 'fork') return res.status(403).json({ error: '该项目仅供观赏，作者未开放获取' });
  const tar = path.join(COMMUNITY_DL, `${req.params.entryId}.tar.gz`);
  if (!fs.existsSync(tar)) return res.status(404).json({ error: '快照不存在' });
  res.download(tar, `${req.params.entryId}.tar.gz`);
});
// 观赏：静态服务快照，CSP sandbox 强制隔离（即使直接打开也是 opaque origin，拿不到会话/调不了我们的 API）
app.get('/community-view/:entryId/*', auth.requireAuth, (req, res) => {
  const entry = auth.getCommunityEntry(req.params.entryId);
  if (!entry) return res.status(404).send('Not found');
  const base = path.join(COMMUNITY_SNAP, req.params.entryId);
  let sub = (req.params[0] || 'index.html') || 'index.html';
  const target = path.normalize(path.join(base, sub));
  if (!target.startsWith(base)) return res.status(400).send('Bad path'); // 防穿越
  let file = target;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups;");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

// =====================================================================
// 协作房间：多人 + 多 AI 共建一个项目（广播 + 文件互斥锁）
// =====================================================================
// 把当前锁写进 owner 工作区：LOCKS.md（权威）+ CLAUDE.md/AGENTS.md 受管块（让各 AI 都看到）
function writeLockContext(ownerId, projectId, locks) {
  try {
    const { projectDir } = projectPaths(ownerId, projectId);
    if (!fs.existsSync(projectDir)) return;
    const entries = Object.entries(locks || {});
    const lines = entries.length
      ? entries.map(([f, v]) => `- \`${f}\` — 被 @${v.userId} 锁定`).join('\n')
      : '（当前没有被锁定的文件）';
    const note = `# 协作文件锁（自动维护，请勿手改）\n\n以下文件正被协作者锁定。只有当前操作者就是对应锁持有人时，才可以修改该文件；否则不要修改它们。如任务必须改动，请说明冲突并停下等待解锁：\n\n${lines}\n`;
    fs.writeFileSync(path.join(projectDir, 'LOCKS.md'), note);
    const START = '<!-- CAB-LOCKS-START -->', END = '<!-- CAB-LOCKS-END -->';
    const block = `${START}\n${note}${END}`;
    for (const fn of ['CLAUDE.md', 'AGENTS.md']) {
      const fp = path.join(projectDir, fn);
      let cur = ''; try { cur = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : ''; } catch (e) {}
      if (cur.includes(START) && cur.includes(END)) cur = cur.replace(new RegExp(START + '[\\s\\S]*?' + END), block);
      else cur = (cur ? cur.trimEnd() + '\n\n' : '') + block + '\n';
      try { fs.writeFileSync(fp, cur); } catch (e) {}
    }
  } catch (e) { console.warn('[Locks] writeLockContext:', e.message); }
}
function roomCtx(req) {
  // 解析 owner/projectId 并校验成员身份；owner 省略=自己
  const projectId = auth.sanitizeId(req.body.projectId || req.query.projectId);
  const ownerId = auth.sanitizeId(req.body.owner || req.query.owner) || req.user.id;
  if (!projectId || !auth.isRoomMember(req.user, ownerId, projectId)) return null;
  return { ownerId, projectId, token: auth.resolveRoomChannel(ownerId, projectId) };
}

// 我参与/拥有的协作房间
app.get('/api/rooms', auth.requireAuth, (req, res) => {
  const owned = auth.listProjects(req.user).filter((p) => (p.collaborators || []).length).map((p) => ({ ownerId: req.user.id, projectId: p.projectId, role: 'owner', collaborators: p.collaborators }));
  const joined = auth.listRoomsForMember(req.user).map((r) => ({ ...r, role: 'member' }));
  res.json({ rooms: [...owned, ...joined] });
});
// 邀请/移除协作者（仅 owner）
app.post('/api/room/collaborators', auth.requireAuth, (req, res) => {
  const projectId = auth.sanitizeId(req.body.projectId);
  if (!projectId || !auth.getProject(req.user, projectId)) return res.status(404).json({ error: '项目不存在或非你所有' });
  try {
    let list;
    if (req.body.remove) {
      list = auth.removeCollaborator(req.user.id, projectId, req.body.username);
      const locks = auth.releaseAllLocksByUser(req.user.id, projectId, auth.sanitizeId(req.body.username));
      writeLockContext(req.user.id, projectId, locks);
      broadcastToRoom(auth.resolveRoomChannel(req.user.id, projectId), { event: 'locks', data: locks });
    } else {
      list = auth.addCollaborator(req.user.id, projectId, req.body.username);
    }
    res.json({ ok: true, collaborators: list });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 锁定文件（成员）
app.post('/api/room/lock', auth.requireAuth, (req, res) => {
  const ctx = roomCtx(req); if (!ctx) return res.status(403).json({ error: '不是该房间成员' });
  const files = Array.isArray(req.body.files) ? req.body.files : String(req.body.files || '').split(',');
  const r = auth.claimLocks(ctx.ownerId, ctx.projectId, req.user.id, files);
  writeLockContext(ctx.ownerId, ctx.projectId, r.locks);
  broadcastToRoom(ctx.token, { event: 'locks', data: r.locks });
  if (r.conflicts.length) broadcastToRoom(ctx.token, { event: 'room-msg', data: { from: 'system', text: `@${req.user.id} 想锁 ${r.conflicts.map((c) => c.file).join(',')}，但已被他人锁定` } });
  res.json({ ok: true, ...r });
});
// 解锁（只能解自己的）
app.post('/api/room/unlock', auth.requireAuth, (req, res) => {
  const ctx = roomCtx(req); if (!ctx) return res.status(403).json({ error: '不是该房间成员' });
  const files = Array.isArray(req.body.files) ? req.body.files : String(req.body.files || '').split(',');
  const locks = req.body.all ? auth.releaseAllLocksByUser(ctx.ownerId, ctx.projectId, req.user.id) : auth.releaseLocks(ctx.ownerId, ctx.projectId, req.user.id, files);
  writeLockContext(ctx.ownerId, ctx.projectId, locks);
  broadcastToRoom(ctx.token, { event: 'locks', data: locks });
  res.json({ ok: true, locks });
});
app.get('/api/room/locks', auth.requireAuth, (req, res) => {
  const ctx = roomCtx(req); if (!ctx) return res.status(403).json({ error: '不是该房间成员' });
  res.json({ locks: auth.listLocks(ctx.ownerId, ctx.projectId) });
});
// 房间聊天（人对人广播，不经过 AI）
app.post('/api/room/say', auth.requireAuth, (req, res) => {
  const ctx = roomCtx(req); if (!ctx) return res.status(403).json({ error: '不是该房间成员' });
  const text = String(req.body.text || '').slice(0, 2000);
  if (!text.trim()) return res.status(400).json({ error: '空消息' });
  broadcastToRoom(ctx.token, { event: 'room-msg', data: { from: req.user.id, text } });
  res.json({ ok: true });
});

// =====================================================================
// 沙箱编排
// =====================================================================
app.post('/api/sandbox/start', auth.requireAuth, async (req, res) => {
  const s = auth.getSettings();
  const admin = auth.isAdmin(req.user);
  if (!s.freeTierEnabled && !admin) return res.status(403).json({ error: '免费额度已暂时关闭' });

  const userId = req.user.id;
  const projectId = auth.sanitizeId(req.body.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId 非法' });

  // 同时运行的免费项目配额
  const existing = auth.getProject(req.user, projectId);
  const alreadyRunning = existing && existing.status === auth.STATUS.RUNNING;
  if (!admin && !alreadyRunning) {
    const dg = await diskGuard();
    if (dg.block) return res.status(503).json({ error: `服务器磁盘紧张（已用 ${dg.pct}%），暂停激活新沙箱，请稍后再试` });
    if (auth.countRunningProjects(req.user) >= auth.MAX_RUNNING_FREE) {
      return res.status(429).json({ error: `同时最多运行 ${auth.MAX_RUNNING_FREE} 个免费项目，请先停止其它项目` });
    }
  }

  const proj = auth.getOrCreateProject(req.user, projectId);
  const token = proj.channelToken;
  const creds = proj.creds || {};
  const paths = projectPaths(userId, projectId);
  if (Object.keys(creds).length) pushCredentials(token, creds);

  // 激活可观测：标记 ACTIVATING → 编排 → 等 agent 连上；每步失败都落 activationFailureReason
  auth.updateProject(userId, projectId, { status: 'ACTIVATING', activationFailureReason: null });

  let result;
  try {
    result = await orchestrator.startSandbox({ userId, projectId, token, creds, resourceTier: proj.resourceTier || 'free', ...paths });
  } catch (err) {
    const reason = '[orchestrate] ' + err.message;
    auth.updateProject(userId, projectId, { status: auth.STATUS.ERROR, activationFailureReason: reason });
    return res.status(500).json({ ok: false, step: 'orchestrate', error: err.message });
  }

  // 等容器内 agent 连上 conduit（最多 ~12s）
  const deadline = Date.now() + 12000;
  while (!sandboxes.has(token) && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 500)); }

  if (sandboxes.has(token)) {
    const existing2 = auth.getProject(req.user, projectId);
    auth.updateProject(userId, projectId, {
      status: auth.STATUS.RUNNING, lastActiveAt: new Date().toISOString(), activationFailureReason: null,
      runningSince: (existing2 && existing2.runningSince) || Date.now() // 容器开始运行时间（算平均运行时长）
    });
    metrics.recordFunnel('activate');
    return res.json({ ok: true, status: 'running', result });
  }

  // 容器起来了但 agent 没连上 → 抓日志帮定位（脱敏后回前端/admin）
  let logs = '';
  try { logs = await orchestrator.getLogs({ userId, projectId, tail: 15 }); } catch (e) {}
  const reason = '[agent] 容器已启动，但 12s 内未连上 conduit（常见：容器→宿主 8080 被防火墙挡 / token 不符需重建 / 容器内进程崩溃）。';
  auth.updateProject(userId, projectId, { status: auth.STATUS.ERROR, activationFailureReason: reason });
  return res.status(504).json({ ok: false, step: 'agent', error: reason, logs: redact(logs), result });
});

// Git Helper（docx §4.10）：只读 workspace 的 git 状态 + 生成可复制命令。
// 宿主侧读取 bind 挂载的 workspace（容器离线也可用）；只读，不保存 token、不替用户 push。
app.get('/api/git/status', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const projectId = auth.sanitizeId(req.query.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId 非法' });
  const { projectDir } = projectPaths(userId, projectId);
  if (!fs.existsSync(projectDir)) return res.json({ exists: false, isRepo: false });
  const git = (args) => new Promise((resolve) =>
    exec(`git -C "${projectDir}" ${args}`, { timeout: 6000 }, (e, o) => resolve(e ? null : String(o).trim())));
  const inside = await git('rev-parse --is-inside-work-tree');
  if (inside !== 'true') return res.json({ exists: true, isRepo: false });
  const [branch, remote, statusRaw] = await Promise.all([
    git('rev-parse --abbrev-ref HEAD'),
    git('remote get-url origin'),
    git('status --porcelain')
  ]);
  const modified = statusRaw ? statusRaw.split('\n').filter(Boolean).map((l) => l.trim()).slice(0, 50) : [];
  metrics.recordFunnel('git');
  res.json({ exists: true, isRepo: true, branch: branch || 'HEAD', remote: remote || null, modifiedCount: modified.length, modified });
});

// 备份下载（无现成备份则即时打包；userId 取会话）
app.get('/api/backup/download', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const projectId = auth.sanitizeId(req.query.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId 非法' });
  const dir = path.join(BACKUP_BASE, userId);
  const file = path.join(dir, `${projectId}.tar.gz`);
  if (!fs.existsSync(file)) {
    const { projectDir } = projectPaths(userId, projectId);
    if (!fs.existsSync(projectDir)) return res.status(404).json({ error: '没有可下载的备份/工作区' });
    ensureDirSync(dir);
    try {
      await runTar(`-czf "${file}" .`, { cwd: projectDir });
    } catch (e) {
      return res.status(500).json({ error: '打包失败', details: String(e.message || e) });
    }
  }
  res.download(file, `${projectId}.tar.gz`);
});

// =====================================================================
// 备份 / 还原 / 销毁（userId 取会话，projectId sanitize）
// =====================================================================
app.post('/api/backup/save', auth.requireAuth, async (req, res) => {
  const projectId = auth.sanitizeId(req.body.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId 非法' });
  const r = await backupProject(req.user.id, projectId);
  if (r.skipped) return res.status(404).json({ error: '本地不存在该项目工作区目录' });
  if (!r.ok) return res.status(500).json({ error: 'Failed to create project backup archive', details: r.error });
  auth.updateProject(req.user.id, projectId, { status: auth.STATUS.BACKED_UP });
  metrics.recordFunnel('backup');
  res.json({ message: 'Backup created successfully', path: r.path });
});

app.post('/api/backup/restore', auth.requireAuth, (req, res) => {
  const userId = req.user.id;
  const projectId = auth.sanitizeId(req.body.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId 非法' });
  const backupFile = path.join(BACKUP_BASE, userId, `${projectId}.tar.gz`);
  if (!fs.existsSync(backupFile)) return res.status(404).json({ error: '云端没有该项目的备份' });

  const { projectDir } = projectPaths(userId, projectId);
  const run = (attempt = 0) => {
    try {
      if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
      ensureDirSync(projectDir);
      runTar(`-xzf "${backupFile}"`, { cwd: projectDir }).then(() => {
        // 还原出来的文件归 root，容器内 node(1000) 写不了 → 改归 1000（仅 Linux/root 生效）
        if (process.platform !== 'win32') exec(`chown -R 1000:1000 "${projectDir}"`, () => {});
        res.json({ message: 'Project synchronized and restored from backup successfully' });
      }).catch((err) => {
        console.error('[Restore Error]', err.stderr || err.message);
        return res.status(500).json({ error: 'Failed to restore', details: err.stderr || err.message });
      });
    } catch (e) {
      if (attempt < 1) return setTimeout(() => run(attempt + 1), 1000);
      res.status(500).json({ error: 'Failed to wipe project dir before restore', details: e.message });
    }
  };
  run();
});

app.post('/api/project/destroy', auth.requireAuth, (req, res) => {
  const userId = req.user.id;
  const projectId = auth.sanitizeId(req.body.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId 非法' });
  const token = auth.resolveChannel(req.user, projectId);
  console.log(`[Destroy] user=${userId} project=${projectId}`);
  destroyProjectData(userId, projectId, token, { removeBackup: true, removeRecord: true });
  res.json({ message: '项目已彻底物理销毁，本地代码与云端备份均已安全擦除。' });
});

// =====================================================================
// 预览 token（可分享的临时链接，带过期）
// =====================================================================
app.post('/api/preview', auth.requireAuth, (req, res) => {
  const projectId = auth.sanitizeId(req.body.projectId);
  const ownerId = auth.sanitizeId(req.body.owner) || req.user.id;
  const port = parseInt(req.body.port, 10);
  if (!projectId || !port) return res.status(400).json({ error: '缺少 projectId / port' });
  if (!auth.isRoomMember(req.user, ownerId, projectId)) return res.status(403).json({ error: '无权访问该项目预览' });

  const now = Date.now();
  for (const [k, v] of previewTokens) if (v.expiresAt < now) previewTokens.delete(k);
  const mine = [...previewTokens.entries()].filter(([, v]) => (v.ownerId || v.userId) === ownerId && v.projectId === projectId);
  if (mine.length >= MAX_PREVIEW_PER_PROJECT) {
    mine.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    previewTokens.delete(mine[0][0]);
  }
  const pt = auth.genToken(12);
  const expiresAt = Date.now() + PREVIEW_TTL_MIN * 60 * 1000;
  previewTokens.set(pt, { userId: req.user.id, ownerId, projectId, port, expiresAt });
  metrics.recordFunnel('preview');
  const ownerQuery = ownerId !== req.user.id ? `owner=${encodeURIComponent(ownerId)}&` : '';
  res.json({ token: pt, url: `/preview/${projectId}/${port}/?${ownerQuery}pt=${pt}`, expiresAt, ttlMinutes: PREVIEW_TTL_MIN });
});

// =====================================================================
// 网页预览反向代理：/preview/<projectId>/<port>/<subpath>
//   鉴权：会话 cookie（项目所有者） 或 有效预览 token(?pt= 或 pt_<projectId> cookie)
// =====================================================================
function ptFromReq(req, projectId) {
  if (req.query && req.query.pt) return req.query.pt;
  const ownerId = auth.sanitizeId(req.query && req.query.owner);
  const cookies = auth.parseCookies(req);
  return (ownerId && cookies[`pt_${ownerId}_${projectId}`]) || cookies['pt_' + projectId] || null;
}
function authorizedUserForPreview(req, projectId, port) {
  const ownerFromQuery = auth.sanitizeId(req.query && req.query.owner);
  const pt = ptFromReq(req, projectId);
  if (pt) {
    const t = previewTokens.get(pt);
    const tokenOwner = t && (t.ownerId || t.userId);
    if (t && t.expiresAt > Date.now() && t.projectId === projectId && t.port === port && (!ownerFromQuery || tokenOwner === ownerFromQuery)) {
      return { userId: tokenOwner, ownerId: tokenOwner, pt, ttl: t.expiresAt - Date.now() };
    }
  }
  const user = auth.getUserFromRequest(req);
  const ownerId = ownerFromQuery || (user && user.id);
  if (user && ownerId && auth.isRoomMember(user, ownerId, projectId)) return { userId: ownerId, ownerId };
  return null;
}

app.all('/preview/*', (req, res) => {
  const parts = (req.params[0] || '').split('/');
  const projectId = auth.sanitizeId(parts[0]);
  const targetPort = parseInt(parts[1], 10);
  const subPath = '/' + parts.slice(2).join('/');
  if (!projectId || !targetPort) return res.status(400).send('Bad preview path');

  const authz = authorizedUserForPreview(req, projectId, targetPort);
  if (!authz) return res.status(401).send('Unauthorized: login or valid preview token required');
  if (subPath === '/' || subPath === '') metrics.bump('previewClicks'); // 只计主页面打开，不计子资源



  // 分享链接首次带 ?pt= 命中后，写一个限定在 /preview/<projectId> 路径的 cookie，让子资源也能鉴权
  if (authz.pt && req.query && req.query.pt) {
    const cookieName = authz.ownerId ? `pt_${authz.ownerId}_${projectId}` : 'pt_' + projectId;
    res.setHeader('Set-Cookie', cookie.serialize(cookieName, authz.pt, {
      httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE,
      path: `/preview/${projectId}`, maxAge: Math.floor((authz.ttl || 0) / 1000)
    }));
  }

  const owner = auth.getUserById(authz.userId);
  const token = owner && auth.resolveChannel(owner, projectId);
  const sandbox = token && sandboxes.get(token);
  if (!sandbox) return res.status(404).send('Sandbox not found or offline');
  if (!sandbox.activePorts.includes(targetPort)) return res.status(403).send(`Port ${targetPort} not listening in sandbox`);

  const queryStr = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  req.url = subPath + queryStr;
  const targetUrl = `http://${sandbox.ipAddress || '127.0.0.1'}:${targetPort}`;
  proxy.web(req, res, { target: targetUrl }, (err) => {
    console.error(`[Proxy Error] ${targetUrl}:`, err.message);
    res.status(502).send(`Bad Gateway: cannot reach sandbox dev server on port ${targetPort}`);
  });
});

// =====================================================================
// 管理员 API（requireAdmin）
// =====================================================================
app.get('/api/admin/overview', auth.requireAdmin, (req, res) => {
  const projects = auth.allProjects().map(({ userId, projectId, project }) => ({
    userId, ...auth.publicProject({ projectId, ...project }),
    online: sandboxes.has(project.channelToken)
  }));
  res.json({
    users: auth.listUsers(),
    projects,
    settings: auth.getSettings(),
    invites: auth.listInvites(),
    bannedIps: auth.listBannedIps(),
    metrics: metrics.snapshot(),
    hermes: auth.listHermes(),
    community: auth.listCommunity(),
    runningContainers: sandboxes.size,
    activePreviewTokens: previewTokens.size
  });
});
app.post('/api/admin/community/:entryId/takedown', auth.requireAdmin, (req, res) => {
  removeCommunitySnapshot(req.params.entryId);
  res.json({ ok: auth.takedownCommunity(req.params.entryId) });
});
app.post('/api/admin/hermes/:userId/stop', auth.requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const u = auth.getUserById(userId);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  try { await orchestrator.stopHermes({ userId }); } catch (e) {}
  auth.setHermesEnabled(u, false, 'OFF');
  hermesAudit(userId, 'admin-stop');
  res.json({ ok: true });
});
app.post('/api/admin/invites', auth.requireAdmin, (req, res) => res.json(auth.createInvite(req.body.note)));
app.post('/api/admin/invites/:code/disable', auth.requireAdmin, (req, res) => res.json({ ok: auth.disableInvite(req.params.code) }));
app.post('/api/admin/users/:id/ban', auth.requireAdmin, (req, res) => {
  const ok = auth.setBan(req.params.id, req.body.banned !== false);
  res.json({ ok });
});
app.post('/api/admin/ip/ban', auth.requireAdmin, (req, res) => {
  const ip = auth.normIp(req.body.ip);
  if (!ip) return res.status(400).json({ error: 'ip 不能为空' });
  res.json({ ok: auth.banIp(ip, req.body.note) });
});
app.post('/api/admin/ip/unban', auth.requireAdmin, (req, res) => {
  res.json({ ok: auth.unbanIp(req.body.ip) });
});
app.post('/api/admin/settings', auth.requireAdmin, (req, res) => {
  try { res.json(auth.setSetting(req.body.key, req.body.value)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/projects/:userId/:projectId/stop', auth.requireAdmin, async (req, res) => {
  const { userId, projectId } = req.params;
  const u = auth.getUserById(userId);
  const token = u && auth.resolveChannel(u, projectId);
  await orchestrator.stopSandbox({ userId, projectId }).catch(() => {});
  disconnectChannel(token, projectId);
  noteContainerStop(userId, projectId);
  auth.updateProject(userId, projectId, { status: auth.STATUS.STOPPED });
  res.json({ ok: true });
});
app.post('/api/admin/projects/:userId/:projectId/destroy', auth.requireAdmin, (req, res) => {
  const { userId, projectId } = req.params;
  const u = auth.getUserById(userId);
  const token = u && auth.resolveChannel(u, projectId);
  destroyProjectData(userId, projectId, token, { removeBackup: true, removeRecord: true });
  res.json({ ok: true });
});
app.post('/api/admin/previews/revoke', auth.requireAdmin, (req, res) => {
  const n = previewTokens.size; previewTokens.clear(); res.json({ revoked: n });
});

// 资源监控：宿主机 CPU/内存/磁盘 + 各容器 CPU/内存
app.get('/api/admin/metrics', auth.requireAdmin, async (req, res) => {
  const load = os.loadavg();
  const memTotal = os.totalmem(), memFree = os.freemem();
  let disk = '';
  try {
    disk = await new Promise((resolve) => exec(`df -h "${WORKSPACE_BASE}" 2>/dev/null | tail -1`, { timeout: 6000 }, (e, o) => resolve(e ? '' : String(o).trim())));
  } catch (e) {}
  let containers = [];
  try { containers = await orchestrator.getStats(); } catch (e) {}
  res.json({
    host: {
      cpuCount: os.cpus().length,
      load1: +load[0].toFixed(2), load5: +load[1].toFixed(2), load15: +load[2].toFixed(2),
      memTotalGB: +(memTotal / 1e9).toFixed(1),
      memUsedGB: +((memTotal - memFree) / 1e9).toFixed(1),
      memUsedPct: Math.round((1 - memFree / memTotal) * 100),
      disk
    },
    containers
  });
});

// =====================================================================
// WebSocket：upgrade 阶段鉴权与路由
// =====================================================================
const wssControl = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname === '/agent') {
    const token = parsedUrl.query.token;
    const channel = token && auth.lookupChannel(token);
    if (!channel) { socket.destroy(); return; }
    req.ctx = { role: 'agent', channelToken: token, userId: channel.userId, projectId: channel.projectId };
    wssControl.handleUpgrade(req, socket, head, (ws) => wssControl.emit('connection', ws, req));
    return;
  }

  if (pathname === '/client') {
    const user = auth.getUserFromRequest(req);
    const projectId = auth.sanitizeId(parsedUrl.query.projectId);
    // owner 省略=自己的项目；协作者需带 owner 参数，且必须是该房间成员
    const ownerId = auth.sanitizeId(parsedUrl.query.owner) || (user && user.id);
    const member = user && projectId && ownerId && auth.isRoomMember(user, ownerId, projectId);
    const channelToken = member ? auth.resolveRoomChannel(ownerId, projectId) : null;
    if (!user || user.banned || user.activated === false || !channelToken) { socket.destroy(); return; }
    req.ctx = { role: 'client', channelToken, userId: user.id, ownerId, projectId };
    wssControl.handleUpgrade(req, socket, head, (ws) => wssControl.emit('connection', ws, req));
    return;
  }

  const previewMatch = pathname.match(/^\/preview\/([a-zA-Z0-9_-]{1,64})\/(\d+)/);
  if (previewMatch) {
    const projectId = auth.sanitizeId(previewMatch[1]);
    const targetPort = parseInt(previewMatch[2], 10);
    const authz = projectId ? authorizedUserForPreview(req, projectId, targetPort) : null;
    const owner = authz && auth.getUserById(authz.userId);
    const token = owner && auth.resolveChannel(owner, projectId);
    const sandbox = token && sandboxes.get(token);
    if (sandbox && sandbox.activePorts.includes(targetPort)) {
      req.url = req.url.replace(/^\/preview\/[^/]+\/\d+/, '') || '/';
      proxy.ws(req, socket, head, { target: `ws://${sandbox.ipAddress || '127.0.0.1'}:${targetPort}` });
    } else {
      socket.destroy();
    }
    return;
  }

  socket.destroy();
});

wssControl.on('connection', (ws, req) => {
  const ctx = req.ctx;
  if (!ctx) { ws.close(); return; }
  const token = ctx.channelToken;
  // 心跳保活：浏览器对 ping 帧会自动回 pong，保住移动端 NAT 映射，并据此剔除死连接
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (ctx.role === 'agent') {
    console.log(`[Conduit] Agent connected. user=${ctx.userId} project=${ctx.projectId}`);
    sandboxes.set(token, { ws, activePorts: [], previewPaths: [], ipAddress: null, userId: ctx.userId, projectId: ctx.projectId });
    if (pendingCredentials.has(token)) {
      ws.send(JSON.stringify({ event: 'init-env', data: pendingCredentials.get(token) }));
      pendingCredentials.delete(token);
    }
    ws.on('message', (message) => {
      try {
        const packet = JSON.parse(message.toString());
        const sb = sandboxes.get(token);
        if (packet.event === 'ports' && sb) sb.activePorts = Array.isArray(packet.data) ? packet.data : [];
        if (packet.event === 'preview-paths' && sb) sb.previewPaths = Array.isArray(packet.data) ? packet.data : [];
        if (packet.event === 'status' && packet.data && packet.data.ip && sb) sb.ipAddress = packet.data.ip;
        broadcastToRoom(token, packet); // 广播给房间所有成员
      } catch (err) { console.error('[Conduit] bad agent message:', err.message); }
    });
    ws.on('close', () => {
      console.log(`[Conduit] Agent disconnected. project=${ctx.projectId}`);
      sandboxes.delete(token);
      broadcastToRoom(token, { event: 'status', data: { status: 'offline' } });
    });
    return;
  }

  // client（房间成员）
  // 每用户并发 WS 上限（§5.2 防滥用）
  const cur = clientConnCount.get(ctx.userId) || 0;
  if (cur >= MAX_WS_PER_USER) {
    ws.send(JSON.stringify({ event: 'output', data: `\r\n[Conduit] 并发连接过多（上限 ${MAX_WS_PER_USER}），请关闭其它标签页后重试。\r\n` }));
    ws.close(); return;
  }
  clientConnCount.set(ctx.userId, cur + 1);
  const connectedAt = Date.now();
  const ownerId = ctx.ownerId || ctx.userId;
  console.log(`[Conduit] Client connected. user=${ctx.userId} room=${ownerId}/${ctx.projectId}`);
  let set = clients.get(token); if (!set) { set = new Set(); clients.set(token, set); }
  set.add(ws);
  clientMeta.set(ws, { userId: ctx.userId, projectId: ctx.projectId });
  metrics.recordFunnel('terminal');
  auth.touchProject(ownerId, ctx.projectId); // 标记活跃（owner 的项目）
  const sandbox = sandboxes.get(token);
  ws.send(JSON.stringify({ event: 'status', data: { status: sandbox ? 'ready' : 'offline' } }));
  if (sandbox) {
    ws.send(JSON.stringify({ event: 'ports', data: sandbox.activePorts }));
    ws.send(JSON.stringify({ event: 'preview-paths', data: sandbox.previewPaths || [] }));
  }
  // 同步房间状态给新加入者，并广播成员变化
  ws.send(JSON.stringify({ event: 'locks', data: auth.listLocks(ownerId, ctx.projectId) }));
  broadcastToRoom(token, { event: 'room', data: { members: roomMembers(token), joined: ctx.userId } });
  ws.on('message', (message) => {
    const sb = sandboxes.get(token);
    if (sb && sb.ws.readyState === WebSocket.OPEN) {
      try {
        const packet = JSON.parse(message.toString());
        if (packet && packet.event === 'chat') {
          packet.data = { ...(packet.data || {}), operatorUserId: ctx.userId, roomOwnerId: ownerId };
          sb.ws.send(JSON.stringify(packet));
        } else {
          sb.ws.send(message);
        }
      } catch (e) {
        sb.ws.send(message);
      }
    } else ws.send(JSON.stringify({ event: 'output', data: '\r\n[Conduit] 沙箱当前离线，请先点【激活并连接】。\r\n' }));
  });
  ws.on('close', () => {
    console.log(`[Conduit] Client disconnected. user=${ctx.userId} room=${ownerId}/${ctx.projectId}`);
    const s = clients.get(token); if (s) { s.delete(ws); if (!s.size) clients.delete(token); }
    const n = (clientConnCount.get(ctx.userId) || 1) - 1;
    if (n <= 0) clientConnCount.delete(ctx.userId); else clientConnCount.set(ctx.userId, n);
    metrics.recordSessionDuration(Date.now() - connectedAt);
    broadcastToRoom(token, { event: 'room', data: { members: roomMembers(token), left: ctx.userId } });
  });
});

// =====================================================================
// CleanupWorker：到期停止+备份，超保留期销毁
// =====================================================================
async function runCleanup() {
  const now = Date.now();
  for (const { userId, projectId, project } of auth.allProjects()) {
    try {
      if (project.status === auth.STATUS.DESTROYED) continue;

      // 超过保留期 → 彻底销毁（保留记录，状态 DESTROYED 供审计）
      if (now > Date.parse(project.retentionUntil)) {
        console.log(`[Cleanup] DESTROY ${userId}/${projectId}`);
        destroyProjectData(userId, projectId, project.channelToken, { removeBackup: true, removeRecord: false });
        auth.updateProject(userId, projectId, { status: auth.STATUS.DESTROYED });
        continue;
      }

      // 到期但尚未备份 → 停容器 + 备份
      if (now > Date.parse(project.expiresAt) && project.status !== auth.STATUS.BACKED_UP) {
        console.log(`[Cleanup] EXPIRE+BACKUP ${userId}/${projectId}`);
        await orchestrator.stopSandbox({ userId, projectId }).catch(() => {});
        disconnectChannel(project.channelToken, projectId);
        noteContainerStop(userId, projectId);
        auth.updateProject(userId, projectId, { status: auth.STATUS.EXPIRED });
        const r = await backupProject(userId, projectId);
        auth.updateProject(userId, projectId, { status: auth.STATUS.BACKED_UP });
        if (r && r.ok === false) console.warn(`[Cleanup] backup failed for ${userId}/${projectId}`);
      }
    } catch (e) {
      console.error(`[Cleanup ERROR] ${userId}/${projectId}:`, e.message);
      auth.updateProject(userId, projectId, { status: auth.STATUS.ERROR });
    }
  }
}

// 资源守卫（§4.4/§5.2）：出站流量超限强停容器 + workspace 磁盘软配额
async function runResourceGuard() {
  // 1) 出站流量超限 → 强停（按项目名匹配 docker stats，避免下划线歧义）
  if (EGRESS_LIMIT_MB > 0) {
    try {
      const stats = await orchestrator.getStats();
      const byName = new Map(stats.map((c) => [c.name, c]));
      for (const { userId, projectId, project } of auth.allProjects()) {
        if (project.status !== auth.STATUS.RUNNING) continue;
        const c = byName.get(`sandbox_${userId}_${projectId}`);
        if (c && c.txBytes > EGRESS_LIMIT_MB * 1e6) {
          console.warn(`[ResourceGuard] egress ${(c.txBytes / 1e6).toFixed(0)}MB>${EGRESS_LIMIT_MB}MB 强停 ${userId}/${projectId}`);
          await orchestrator.stopSandbox({ userId, projectId }).catch(() => {});
          disconnectChannel(project.channelToken, projectId);
          noteContainerStop(userId, projectId);
          auth.updateProject(userId, projectId, { status: auth.STATUS.STOPPED, activationFailureReason: `出站流量超限(${EGRESS_LIMIT_MB}MB)被自动停止` });
          metrics.bump('egressKills');
        }
      }
      // Hermes 容器同样适用出站限制
      for (const hm of auth.listHermes()) {
        if (hm.status !== 'RUNNING') continue;
        const c = byName.get(`hermes_${hm.userId}`);
        if (c && c.txBytes > EGRESS_LIMIT_MB * 1e6) {
          console.warn(`[ResourceGuard] hermes egress ${(c.txBytes / 1e6).toFixed(0)}MB>${EGRESS_LIMIT_MB}MB 强停 ${hm.userId}`);
          await orchestrator.stopHermes({ userId: hm.userId }).catch(() => {});
          const u = auth.getUserById(hm.userId); if (u) auth.setHermesEnabled(u, false, 'STOPPED');
          metrics.bump('egressKills');
        }
      }
    } catch (e) { console.error('[ResourceGuard egress]', e.message); }
  }
  // 2) workspace 磁盘软配额：超限标记；超 1.5x 强停防爆盘
  if (WORKSPACE_QUOTA_MB > 0 && process.platform !== 'win32') {
    for (const { userId, projectId, project } of auth.allProjects()) {
      if (project.status === auth.STATUS.DESTROYED) continue;
      const { projectDir } = projectPaths(userId, projectId);
      if (!fs.existsSync(projectDir)) continue;
      const mb = await duMB(projectDir);
      if (mb == null) continue;
      if (mb > WORKSPACE_QUOTA_MB) {
        if (project.overQuotaMB !== mb) auth.updateProject(userId, projectId, { overQuotaMB: mb });
        if (mb > WORKSPACE_QUOTA_MB * 1.5 && project.status === auth.STATUS.RUNNING) {
          console.warn(`[ResourceGuard] workspace ${userId}/${projectId} ${mb}MB>1.5×配额 强停`);
          await orchestrator.stopSandbox({ userId, projectId }).catch(() => {});
          disconnectChannel(project.channelToken, projectId);
          noteContainerStop(userId, projectId);
          auth.updateProject(userId, projectId, { status: auth.STATUS.STOPPED, activationFailureReason: `磁盘占用 ${mb}MB 超配额(${WORKSPACE_QUOTA_MB}MB) 被自动停止` });
        }
      } else if (project.overQuotaMB) {
        auth.updateProject(userId, projectId, { overQuotaMB: null });
      }
    }
  }
  // 3) OOM 统计（§10）：扫已退出容器里 OOMKilled 的，去重计数
  try {
    for (const k of await orchestrator.getOomKilled()) {
      const key = `${k.id || k.name}@${k.finishedAt}`;
      if (!oomSeen.has(key)) { oomSeen.add(key); metrics.bump('oomKills'); console.warn(`[ResourceGuard] OOM killed ${k.name}`); }
    }
    if (oomSeen.size > 5000) oomSeen.clear(); // 防无限增长
  } catch (e) {}
}
const oomSeen = new Set();

function startWorkers() {
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  setTimeout(runCleanup, 5000); // 启动后先跑一次
  setInterval(runResourceGuard, RESOURCE_GUARD_INTERVAL_MS);
  setTimeout(runResourceGuard, 20000);
  // 清理过期预览 token
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of previewTokens) if (v.expiresAt < now) previewTokens.delete(k);
  }, 60 * 1000);
  // WS 心跳：每 25s ping 一次（< 移动网络 ~30-60s 空闲回收），无 pong 的死连接直接终止
  setInterval(() => {
    wssControl.clients.forEach((ws) => {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, 25000);
}

server.listen(PORT, () => {
  console.log(`[Conduit Server] Running on http://localhost:${PORT}`);
  console.log(`[Conduit] free-run=${auth.FREE_RUN_DAYS}d retention=${auth.RETENTION_DAYS}d cleanup-every=${Math.round(CLEANUP_INTERVAL_MS / 1000)}s`);
  mailer.verify();
  startWorkers();
});
