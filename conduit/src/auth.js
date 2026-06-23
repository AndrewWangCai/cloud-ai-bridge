// 账号 / 会话 / 项目生命周期 / 邀请码 / 配额 / 运行时开关 的统一存储层。
// 持久化到 conduit/data/users.json：{ users:{}, invites:{}, settings:{} }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookie = require('cookie');

const DATA_DIR = process.env.AI_SANDBOX_DATA_DIR
  ? path.resolve(process.env.AI_SANDBOX_DATA_DIR)
  : path.resolve(__dirname, '../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 天

// ---- 生命周期 / 配额 / 管理员 配置（环境变量可覆盖） ----
const FREE_RUN_DAYS = parseInt(process.env.FREE_RUN_DAYS || '5', 10);
const FREE_RUN_HOURS = parseInt(process.env.FREE_RUN_HOURS || '48', 10); // >0 则用小时覆盖天；默认 48h 公开测试（docx 建议）。设 0 则回退到 FREE_RUN_DAYS
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '10', 10);
const MAX_RUNNING_FREE = parseInt(process.env.MAX_RUNNING_FREE || '1', 10);
const MAX_CREATE_PER_DAY = parseInt(process.env.MAX_CREATE_PER_DAY || '1', 10);
const MAX_REGISTER_PER_IP_PER_DAY = parseInt(process.env.MAX_REGISTER_PER_IP_PER_DAY || '3', 10); // docx §4.7 每 IP 每天注册上限
const ADMIN_USERS = (process.env.ADMIN_USERS || 'dev')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const DAY_MS = 1000 * 60 * 60 * 24;

const STATUS = {
  CREATED: 'CREATED',
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
  EXPIRED: 'EXPIRED',
  BACKED_UP: 'BACKED_UP',
  DESTROYED: 'DESTROYED',
  ERROR: 'ERROR'
};

const sessions = new Map();      // sid => { userId, createdAt }
const channelIndex = new Map();  // channelToken => { userId, projectId }

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function defaultSettings() {
  return {
    registrationEnabled: process.env.REGISTRATION_ENABLED !== '0',
    projectCreationEnabled: process.env.PROJECT_CREATION_ENABLED !== '0',
    freeTierEnabled: process.env.FREE_TIER_ENABLED !== '0',
    inviteRequired: process.env.INVITE_REQUIRED !== '0'
  };
}

function loadStore() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(USERS_FILE)) return { users: {}, invites: {}, settings: defaultSettings(), bannedIps: {}, ipRegister: {} };
  let raw;
  try {
    raw = fs.readFileSync(USERS_FILE, 'utf8');
  } catch (e) {
    // 文件存在却读不了（权限/IO）：绝不“按空库启动”，否则之后的 save 会覆盖、清空所有账号！直接抛错退出，保护数据。
    throw new Error('无法读取 ' + USERS_FILE + '：' + e.message
      + ' —— 拒绝以空库启动覆盖数据。请用正确用户/权限运行（conduit 应以 root；手动脚本请加 sudo）。');
  }
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed.users) {
      return {
        users: parsed.users,
        invites: parsed.invites || {},
        settings: { ...defaultSettings(), ...(parsed.settings || {}) },
        bannedIps: parsed.bannedIps || {},
        ipRegister: parsed.ipRegister || {}
      };
    }
    // 旧格式（扁平 users）→ 迁移
    return { users: parsed, invites: {}, settings: defaultSettings(), bannedIps: {}, ipRegister: {} };
  } catch (e) {
    // 解析失败：先备份原文件，再抛错，绝不静默用空库覆盖
    try { fs.copyFileSync(USERS_FILE, USERS_FILE + '.corrupt.' + Date.now()); } catch (_) {}
    throw new Error(USERS_FILE + ' 解析失败（已备份为 .corrupt.*）：' + e.message + ' —— 拒绝以空库覆盖。');
  }
}

let store = loadStore();

function saveStore() {
  ensureDir(DATA_DIR);
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

// 补全旧项目缺失的生命周期字段
function normalizeProject(p) {
  if (!p.status) p.status = STATUS.CREATED;
  if (!p.createdAt) p.createdAt = new Date().toISOString();
  if (!p.expiresAt) p.expiresAt = new Date(new Date(p.createdAt).getTime() + runDurationMs()).toISOString();
  if (!p.retentionUntil) p.retentionUntil = new Date(new Date(p.expiresAt).getTime() + RETENTION_DAYS * DAY_MS).toISOString();
  if (!p.resourceTier) p.resourceTier = 'free';
  if (!p.creds) p.creds = {};
  return p;
}

function rebuildChannelIndex() {
  channelIndex.clear();
  for (const key of Object.keys(store.users)) {
    const u = store.users[key];
    for (const pid of Object.keys(u.projects || {})) {
      normalizeProject(u.projects[pid]);
      channelIndex.set(u.projects[pid].channelToken, { userId: u.id, projectId: pid });
    }
  }
}
rebuildChannelIndex();

function sanitizeId(id) {
  if (typeof id !== 'string') return null;
  const t = id.trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(t) ? t : null;
}
function genToken(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }
// 运行期时长（ms）：FREE_RUN_HOURS>0 用小时，否则用天
function runDurationMs() { return FREE_RUN_HOURS > 0 ? FREE_RUN_HOURS * 3600 * 1000 : FREE_RUN_DAYS * DAY_MS; }

// ================= 运行时开关 =================
function getSettings() { return { ...store.settings }; }
function setSetting(key, value) {
  if (!(key in store.settings)) throw new Error('未知开关: ' + key);
  store.settings[key] = !!value;
  saveStore();
  return getSettings();
}

// ================= 邀请码 =================
function createInvite(note) {
  const code = genToken(8);
  store.invites[code] = { code, note: note || '', createdAt: new Date().toISOString(), usedBy: null, usedAt: null, disabled: false };
  saveStore();
  return store.invites[code];
}
function listInvites() { return Object.values(store.invites); }
function disableInvite(code) {
  if (store.invites[code]) { store.invites[code].disabled = true; saveStore(); return true; }
  return false;
}
function validateInvite(code) {
  const inv = store.invites[code];
  return !!(inv && !inv.usedBy && !inv.disabled);
}
function consumeInvite(code, userId) {
  const inv = store.invites[code];
  if (!inv || inv.usedBy || inv.disabled) throw new Error('邀请码无效或已被使用');
  inv.usedBy = userId; inv.usedAt = new Date().toISOString();
  saveStore();
}

// ================= 账号 / 邮箱激活 =================
const ACTIVATION_TTL_MS = parseInt(process.env.ACTIVATION_TTL_MS || String(15 * 60 * 1000), 10); // 激活码有效期
const RESEND_INTERVAL_MS = parseInt(process.env.RESEND_INTERVAL_MS || '60000', 10);              // 重发最小间隔（防刷）
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function genActivationCode() { return String(Math.floor(100000 + Math.random() * 900000)); } // 6 位
function emailExists(email) {
  const e = normEmail(email);
  return Object.values(store.users).some((u) => u.emailLower === e);
}
function getUserByEmail(email) {
  const e = normEmail(email);
  return Object.values(store.users).find((u) => u.emailLower === e) || null;
}

async function registerUser(username, password, opts = {}) {
  const uname = sanitizeId(username);
  if (!uname) throw new Error('用户名只能包含字母/数字/下划线/连字符（1-64 位）');
  if (!password || String(password).length < 6) throw new Error('密码至少 6 位');
  const key = uname.toLowerCase();
  if (store.users[key]) throw new Error('用户名已存在');

  // 邮箱：普通注册必填且唯一；dev/admin 引导（opts.activated）可不填
  let email = null;
  if (opts.email !== undefined && opts.email !== null && opts.email !== '') {
    email = normEmail(opts.email);
    if (!EMAIL_RE.test(email)) throw new Error('邮箱格式不正确');
    if (emailExists(email)) throw new Error('该邮箱已被注册');
  } else if (!opts.activated) {
    throw new Error('请填写邮箱');
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  const activated = !!opts.activated;
  store.users[key] = {
    id: uname, username: uname, passwordHash,
    createdAt: new Date().toISOString(),
    banned: false,
    email: email, emailLower: email,
    activated,
    activationCode: null, activationExpires: null, activationSentAt: null,
    invitedBy: opts.inviteCode || null,
    registeredIp: opts.ip ? normIp(opts.ip) : null,
    projects: {}
  };
  saveStore();
  return store.users[key];
}

// 生成并落库一枚激活码（返回明文 code 供 mailer 发送）
function issueActivationCode(user) {
  const code = genActivationCode();
  user.activationCode = code;
  user.activationExpires = Date.now() + ACTIVATION_TTL_MS;
  user.activationSentAt = Date.now();
  saveStore();
  return code;
}
function canResend(user) {
  return !user.activationSentAt || (Date.now() - user.activationSentAt) >= RESEND_INTERVAL_MS;
}
function isActivated(user) { return !!user.activated; }
// 校验激活码：成功则置 activated 并清码，返回 user；失败抛错
function verifyActivation(email, code) {
  const user = getUserByEmail(email);
  if (!user) throw new Error('账号不存在');
  if (user.activated) return user; // 幂等
  if (!user.activationCode || !user.activationExpires) throw new Error('请先获取激活码');
  if (Date.now() > user.activationExpires) throw new Error('激活码已过期，请重新获取');
  if (String(code).trim() !== user.activationCode) throw new Error('激活码不正确');
  user.activated = true;
  user.activationCode = null; user.activationExpires = null;
  saveStore();
  return user;
}

async function verifyLogin(username, password) {
  const key = (sanitizeId(username) || '').toLowerCase();
  const user = store.users[key];
  if (!user) return null;
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  return ok ? user : null;
}

// ---- 找回密码（邮箱验证码） ----
function issueResetCode(user) {
  const code = genActivationCode();
  user.resetCode = code;
  user.resetExpires = Date.now() + ACTIVATION_TTL_MS;
  user.resetSentAt = Date.now();
  saveStore();
  return code;
}
function canResetResend(user) {
  return !user.resetSentAt || (Date.now() - user.resetSentAt) >= RESEND_INTERVAL_MS;
}
// 校验重置码并设置新密码；成功返回 user 并清掉该用户所有会话
async function verifyResetAndSetPassword(email, code, newPassword) {
  const user = getUserByEmail(email);
  if (!user) throw new Error('账号不存在');
  if (!newPassword || String(newPassword).length < 6) throw new Error('新密码至少 6 位');
  if (!user.resetCode || !user.resetExpires) throw new Error('请先获取验证码');
  if (Date.now() > user.resetExpires) throw new Error('验证码已过期，请重新获取');
  if (String(code).trim() !== user.resetCode) throw new Error('验证码不正确');
  user.passwordHash = await bcrypt.hash(String(newPassword), 10);
  user.resetCode = null; user.resetExpires = null;
  saveStore();
  killUserSessions(user.id); // 改密后踢掉所有旧会话
  return user;
}
// 清掉某用户的所有会话（改密/封禁用）
function killUserSessions(userId) {
  const uid = (userId || '').toLowerCase();
  let n = 0;
  for (const [sid, s] of sessions) if ((s.userId || '').toLowerCase() === uid) { sessions.delete(sid); n++; }
  if (n) saveSessions();
  return n;
}

function getUserById(id) { return store.users[(id || '').toLowerCase()] || null; }
function isAdmin(user) { return !!user && ADMIN_USERS.includes(user.id.toLowerCase()); }
function setBan(userId, banned) {
  const u = getUserById(userId);
  if (!u) return false;
  u.banned = !!banned;
  saveStore();
  if (banned) {
    // 封禁即时生效：清掉该用户所有会话
    const uid = (userId || '').toLowerCase();
    for (const [sid, s] of sessions) if ((s.userId || '').toLowerCase() === uid) sessions.delete(sid);
    saveSessions();
  }
  return true;
}
function listUsers() {
  return Object.values(store.users).map((u) => ({
    id: u.id, createdAt: u.createdAt, banned: !!u.banned,
    email: u.email || null, activated: u.activated !== false,
    registeredIp: u.registeredIp || null, lastLoginIp: u.lastLoginIp || null,
    projectCount: Object.keys(u.projects || {}).length
  }));
}

// ================= IP 封禁 / 注册限频（docx §4.7/§5.1）=================
// 归一化：去掉 IPv6 映射前缀，便于人读与匹配
function normIp(ip) { return String(ip || '').replace(/^::ffff:/, '').trim(); }
function isIpBanned(ip) { return !!store.bannedIps[normIp(ip)]; }
function banIp(ip, note) {
  const k = normIp(ip); if (!k) return false;
  store.bannedIps[k] = { bannedAt: new Date().toISOString(), note: note || '' };
  saveStore(); return true;
}
function unbanIp(ip) {
  const k = normIp(ip);
  if (store.bannedIps[k]) { delete store.bannedIps[k]; saveStore(); return true; }
  return false;
}
function listBannedIps() {
  return Object.entries(store.bannedIps).map(([ip, v]) => ({ ip, ...v }));
}
// 当天该 IP 已注册次数（YYYY-MM-DD 分桶，旧桶随写入清掉）
function countRegisterToday(ip) {
  const k = normIp(ip); const day = new Date().toISOString().slice(0, 10);
  const rec = store.ipRegister[k];
  return rec && rec.day === day ? rec.count : 0;
}
function recordRegister(ip) {
  const k = normIp(ip); if (!k) return;
  const day = new Date().toISOString().slice(0, 10);
  const rec = store.ipRegister[k];
  store.ipRegister[k] = rec && rec.day === day ? { day, count: rec.count + 1 } : { day, count: 1 };
  saveStore();
}
function setUserIp(userId, field, ip) {
  const u = getUserById(userId); if (!u) return;
  u[field] = normIp(ip); saveStore();
}

// ================= GitHub OAuth（每用户，host 侧；token 不入容器/不回显）=================
function setGithubOAuth(user, token, login) {
  user.github = { connected: true, login: login || null, token, connectedAt: new Date().toISOString() };
  saveStore();
}
function getGithubToken(user) { return user.github && user.github.token ? user.github.token : null; }
function clearGithubOAuth(user) { user.github = { connected: false }; saveStore(); }
function publicGithub(user) {
  const g = user.github || {};
  return { connected: !!g.connected, login: g.login || null, connectedAt: g.connectedAt || null };
}

// ================= 会话（落盘持久化：conduit 重启后不掉登录）=================
function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8') || '{}');
    const now = Date.now();
    for (const [sid, s] of Object.entries(obj)) {
      if (s && s.userId && (now - s.createdAt) < SESSION_TTL_MS) sessions.set(sid, s);
    }
  } catch (e) { console.error('[Auth] loadSessions 失败:', e.message); }
}
function saveSessions() {
  try {
    ensureDir(DATA_DIR);
    const obj = {};
    for (const [sid, s] of sessions) obj[sid] = s;
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) { console.error('[Auth] saveSessions 失败:', e.message); }
}
loadSessions();

function createSession(userId) {
  const sid = genToken(32);
  sessions.set(sid, { userId, createdAt: Date.now() });
  saveSessions();
  return sid;
}
function destroySession(sid) { if (sid && sessions.delete(sid)) saveSessions(); }
function getSessionUser(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { sessions.delete(sid); return null; }
  return getUserById(s.userId);
}
function parseCookies(req) {
  const h = req.headers && req.headers.cookie;
  if (!h) return {};
  try { return cookie.parse(h); } catch (e) { return {}; }
}
function getUserFromRequest(req) { return getSessionUser(parseCookies(req)[SESSION_COOKIE]); }

function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: '未登录或会话已过期，请重新登录' });
  if (user.banned) return res.status(403).json({ error: '账号已被封禁' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  if (!isAdmin(user)) return res.status(403).json({ error: '需要管理员权限' });
  req.user = user;
  next();
}

// ================= 项目 / 生命周期 =================
function publicProject(p) {
  return {
    projectId: p.projectId, status: p.status, createdAt: p.createdAt,
    expiresAt: p.expiresAt, retentionUntil: p.retentionUntil,
    lastActiveAt: p.lastActiveAt || null, resourceTier: p.resourceTier,
    hasAnthropicKey: !!(p.creds && p.creds.ANTHROPIC_API_KEY),
    hasOpenAIKey: !!(p.creds && p.creds.OPENAI_API_KEY),
    hasDeepSeekKey: !!(p.creds && p.creds.DEEPSEEK_API_KEY),
    hasGlmKey: !!(p.creds && p.creds.GLM_API_KEY),
    hasKimiKey: !!(p.creds && p.creds.MOONSHOT_API_KEY),
    hasQwenKey: !!(p.creds && p.creds.DASHSCOPE_API_KEY),
    hasGitHub: !!(p.creds && p.creds.GITHUB_TOKEN),
    hasBrief: !!(p.creds && p.creds.PROJECT_BRIEF),
    activationFailureReason: p.activationFailureReason || null,
    community: publicCommunity(p.community),
    collaborators: p.collaborators || []
  };
}

function listProjects(user) {
  return Object.keys(user.projects || {}).map((pid) =>
    publicProject({ projectId: pid, ...normalizeProject(user.projects[pid]) }));
}

function countRunningProjects(user) {
  return Object.values(user.projects || {}).filter((p) => p.status === STATUS.RUNNING).length;
}
function countCreatedToday(user) {
  const since = Date.now() - DAY_MS;
  return Object.values(user.projects || {}).filter((p) => new Date(p.createdAt).getTime() > since).length;
}

function getOrCreateProject(user, projectId) {
  const pid = sanitizeId(projectId);
  if (!pid) throw new Error('项目名只能包含字母/数字/下划线/连字符（1-64 位）');
  if (!user.projects) user.projects = {};
  if (!user.projects[pid]) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + runDurationMs());
    const retentionUntil = new Date(expiresAt.getTime() + RETENTION_DAYS * DAY_MS);
    user.projects[pid] = {
      channelToken: genToken(24),
      createdAt: now.toISOString(),
      status: STATUS.CREATED,
      expiresAt: expiresAt.toISOString(),
      retentionUntil: retentionUntil.toISOString(),
      lastActiveAt: null,
      resourceTier: 'free',
      creds: {}
    };
    saveStore();
    channelIndex.set(user.projects[pid].channelToken, { userId: user.id, projectId: pid });
  }
  return { projectId: pid, ...user.projects[pid] };
}

function getProject(user, projectId) {
  const pid = sanitizeId(projectId);
  if (!pid || !user.projects || !user.projects[pid]) return null;
  return { projectId: pid, ...normalizeProject(user.projects[pid]) };
}

function updateProject(userId, projectId, patch) {
  const u = getUserById(userId);
  if (!u || !u.projects || !u.projects[projectId]) return null;
  Object.assign(u.projects[projectId], patch);
  saveStore();
  return u.projects[projectId];
}

function touchProject(userId, projectId) {
  const u = getUserById(userId);
  if (!u || !u.projects || !u.projects[projectId]) return;
  const p = u.projects[projectId];
  if (p.status === STATUS.DESTROYED) return;
  const now = Date.now();
  p.lastActiveAt = new Date(now).toISOString();
  // 活跃即续期：到期时间从「最近活跃」重新计 48h，活跃项目不会被清理（数据/项目不丢）
  p.expiresAt = new Date(now + runDurationMs()).toISOString();
  p.retentionUntil = new Date(now + runDurationMs() + RETENTION_DAYS * DAY_MS).toISOString();
  p.status = STATUS.RUNNING;
  saveStore();
}

function deleteProject(user, projectId) {
  const pid = sanitizeId(projectId);
  if (!pid || !user.projects || !user.projects[pid]) return false;
  channelIndex.delete(user.projects[pid].channelToken);
  delete user.projects[pid];
  saveStore();
  return true;
}

// 跨所有用户枚举项目（CleanupWorker 用）
function allProjects() {
  const out = [];
  for (const key of Object.keys(store.users)) {
    const u = store.users[key];
    for (const pid of Object.keys(u.projects || {})) {
      out.push({ userId: u.id, projectId: pid, project: normalizeProject(u.projects[pid]) });
    }
  }
  return out;
}

const ALLOWED_CRED_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY', 'MOONSHOT_API_KEY', 'DASHSCOPE_API_KEY', 'GITHUB_TOKEN', 'GIT_USERNAME', 'GIT_EMAIL', 'PROJECT_BRIEF'];
function setProjectCreds(user, projectId, creds) {
  const pid = sanitizeId(projectId);
  if (!pid || !user.projects || !user.projects[pid]) throw new Error('项目不存在');
  const target = user.projects[pid].creds || (user.projects[pid].creds = {});
  for (const k of ALLOWED_CRED_KEYS) {
    if (typeof creds[k] === 'string' && creds[k].trim()) target[k] = creds[k].trim();
  }
  saveStore();
  return target;
}

function resolveChannel(user, projectId) {
  const p = getProject(user, projectId);
  return p ? p.channelToken : null;
}
function lookupChannel(channelToken) { return channelIndex.get(channelToken) || null; }

// ================= 社区（用户自愿公开项目，仅本人可发布）=================
const COMMUNITY_LEVELS = ['view', 'fork']; // view=仅观赏；fork=可获取/下载
function publicCommunity(c) {
  if (!c) return { published: false };
  return { published: !!c.published, level: c.level || 'view', title: c.title || '', desc: c.desc || '',
    entryId: c.entryId || null, publishedAt: c.publishedAt || null, takedown: !!c.takedown };
}
// 发布/更新（调用方已确认 user 是该项目所有者且已激活）
function publishProject(user, projectId, { level, title, desc }) {
  const pid = sanitizeId(projectId);
  if (!pid || !user.projects || !user.projects[pid]) throw new Error('项目不存在');
  const lvl = COMMUNITY_LEVELS.includes(level) ? level : 'view';
  const p = user.projects[pid];
  const c = p.community || {};
  p.community = {
    published: true, level: lvl,
    title: String(title || pid).slice(0, 80),
    desc: String(desc || '').slice(0, 500),
    entryId: c.entryId || genToken(8),
    publishedAt: new Date().toISOString(),
    takedown: false
  };
  saveStore();
  return publicCommunity(p.community);
}
function unpublishProject(user, projectId) {
  const pid = sanitizeId(projectId);
  const p = user.projects && user.projects[pid];
  if (p && p.community) { p.community.published = false; saveStore(); }
  return { published: false };
}
function listCommunity() {
  const out = [];
  for (const u of Object.values(store.users)) {
    for (const [pid, p] of Object.entries(u.projects || {})) {
      const c = p.community;
      if (c && c.published && !c.takedown) {
        out.push({ entryId: c.entryId, userId: u.id, projectId: pid, author: u.id,
          title: c.title, desc: c.desc, level: c.level, publishedAt: c.publishedAt });
      }
    }
  }
  return out.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
}
function getCommunityEntry(entryId) {
  for (const u of Object.values(store.users)) {
    for (const [pid, p] of Object.entries(u.projects || {})) {
      if (p.community && p.community.entryId === entryId && p.community.published && !p.community.takedown) {
        return { userId: u.id, projectId: pid, community: publicCommunity(p.community) };
      }
    }
  }
  return null;
}
function takedownCommunity(entryId) {
  for (const u of Object.values(store.users)) {
    for (const p of Object.values(u.projects || {})) {
      if (p.community && p.community.entryId === entryId) { p.community.takedown = true; p.community.published = false; saveStore(); return true; }
    }
  }
  return false;
}

// ================= 协作房间（多人 + 多 AI 共建一个项目）=================
function rawProject(ownerId, projectId) {
  const u = getUserById(ownerId); const pid = sanitizeId(projectId);
  if (!u || !pid || !u.projects || !u.projects[pid]) return null;
  return u.projects[pid];
}
function addCollaborator(ownerId, projectId, username) {
  const p = rawProject(ownerId, projectId); if (!p) throw new Error('项目不存在');
  const uname = sanitizeId(username); if (!uname) throw new Error('用户名非法');
  const target = getUserById(uname); if (!target) throw new Error('该用户不存在');
  if (uname.toLowerCase() === (ownerId || '').toLowerCase()) throw new Error('不能把自己加为协作者');
  if (!p.collaborators) p.collaborators = [];
  if (!p.collaborators.map((s) => s.toLowerCase()).includes(uname.toLowerCase())) p.collaborators.push(target.id);
  saveStore(); return p.collaborators;
}
function removeCollaborator(ownerId, projectId, username) {
  const p = rawProject(ownerId, projectId); if (!p || !p.collaborators) return [];
  p.collaborators = p.collaborators.filter((s) => s.toLowerCase() !== (username || '').toLowerCase());
  saveStore(); return p.collaborators;
}
function listCollaborators(ownerId, projectId) { const p = rawProject(ownerId, projectId); return (p && p.collaborators) || []; }
function isRoomMember(user, ownerId, projectId) {
  if (!user) return false;
  const p = rawProject(ownerId, projectId);
  if (!p) return false;
  if (user.id.toLowerCase() === (ownerId || '').toLowerCase()) return true;
  return !!((p.collaborators || []).map((s) => s.toLowerCase()).includes(user.id.toLowerCase()));
}
function resolveRoomChannel(ownerId, projectId) { const p = rawProject(ownerId, projectId); return p ? p.channelToken : null; }
// 我参与的协作项目（别人邀请我的）
function listRoomsForMember(user) {
  const out = [];
  for (const u of Object.values(store.users)) {
    if (u.id.toLowerCase() === user.id.toLowerCase()) continue;
    for (const [pid, p] of Object.entries(u.projects || {})) {
      if ((p.collaborators || []).map((s) => s.toLowerCase()).includes(user.id.toLowerCase())) {
        out.push({ ownerId: u.id, projectId: pid });
      }
    }
  }
  return out;
}
// ---- 文件互斥锁 ----
function normalizeLockFile(raw) {
  let f = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!f || f.includes('\0')) return null;
  f = path.posix.normalize(f);
  if (!f || f === '.' || f === '..' || f.startsWith('../') || path.posix.isAbsolute(f)) return null;
  if (f.length > 256) return null;
  return f;
}
function listLocks(ownerId, projectId) { const p = rawProject(ownerId, projectId); return (p && p.locks) || {}; }
function claimLocks(ownerId, projectId, userId, files) {
  const p = rawProject(ownerId, projectId); if (!p) throw new Error('项目不存在');
  if (!p.locks) p.locks = {};
  const granted = [], conflicts = [];
  const seen = new Set();
  for (const raw of (files || []).slice(0, 100)) {
    const f = normalizeLockFile(raw);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    const cur = p.locks[f];
    if (cur && cur.userId.toLowerCase() !== (userId || '').toLowerCase()) conflicts.push({ file: f, by: cur.userId });
    else { p.locks[f] = { userId, at: new Date().toISOString() }; granted.push(f); }
  }
  saveStore(); return { granted, conflicts, locks: p.locks };
}
function releaseLocks(ownerId, projectId, userId, files) {
  const p = rawProject(ownerId, projectId); if (!p || !p.locks) return {};
  for (const raw of files || []) {
    const f = normalizeLockFile(raw);
    if (!f) continue;
    if (p.locks[f] && p.locks[f].userId.toLowerCase() === (userId || '').toLowerCase()) delete p.locks[f];
  }
  saveStore(); return p.locks;
}
function releaseAllLocksByUser(ownerId, projectId, userId) {
  const p = rawProject(ownerId, projectId); if (!p || !p.locks) return {};
  for (const f of Object.keys(p.locks)) if (p.locks[f].userId.toLowerCase() === (userId || '').toLowerCase()) delete p.locks[f];
  saveStore(); return p.locks;
}

// ================= Hermes 云端秘书（docx §7，默认关闭、用户级、严格隔离）=================
// 平台只提供「受治理的隔离运行时」：默认 off、预算/连接器/工具权限白名单、跨用户隔离、可审计。
// 绝不赋予 Hermes 管理员权限或跨用户读取能力。
const HERMES_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'openrouter', 'custom'];
const HERMES_CONNECTORS = ['telegram', 'feishu', 'slack', 'discord', 'email', 'qq', 'wechat'];
const HERMES_TOOLS = ['readFiles', 'writeFiles', 'runCommands', 'sendMessages'];
const HERMES_CRED_KEYS = ['HERMES_API_KEY', 'HERMES_BASE_URL', 'HERMES_MODEL',
  'TELEGRAM_BOT_TOKEN', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'SLACK_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'EMAIL_SMTP',
  'QQ_BOT_APPID', 'QQ_BOT_TOKEN', 'QQ_BOT_SECRET', 'WECHAT_APPID', 'WECHAT_TOKEN', 'WECHAT_SECRET'];

function defaultHermes() {
  return {
    enabled: false,
    provider: null,
    budgets: { tokensPerDay: 100000, messagesPerDay: 200, tasksPerDay: 50 },
    connectors: HERMES_CONNECTORS.reduce((o, c) => ((o[c] = false), o), {}),
    tools: { readFiles: true, writeFiles: false, runCommands: false, sendMessages: false }, // 默认只读
    usage: { day: '', tokens: 0, messages: 0, tasks: 0 },
    createdAt: null, lastStartedAt: null, lastStoppedAt: null,
    status: 'OFF', // OFF / RUNNING / STOPPED / ERROR
    creds: {}
  };
}
function getHermesRaw(user) {
  if (!user.hermes) user.hermes = defaultHermes();
  else user.hermes = { ...defaultHermes(), ...user.hermes,
    budgets: { ...defaultHermes().budgets, ...(user.hermes.budgets || {}) },
    connectors: { ...defaultHermes().connectors, ...(user.hermes.connectors || {}) },
    tools: { ...defaultHermes().tools, ...(user.hermes.tools || {}) },
    usage: { ...defaultHermes().usage, ...(user.hermes.usage || {}) },
    creds: user.hermes.creds || {} };
  return user.hermes;
}
// 对外视图：不回显原始 key，只给 has* 布尔
function publicHermes(user) {
  const h = getHermesRaw(user);
  return {
    enabled: h.enabled, provider: h.provider, status: h.status,
    budgets: h.budgets, connectors: h.connectors, tools: h.tools,
    usage: h.usage, lastStartedAt: h.lastStartedAt, lastStoppedAt: h.lastStoppedAt,
    hasModelKey: !!h.creds.HERMES_API_KEY,
    connectorCreds: HERMES_CONNECTORS.reduce((o, c) => {
      o[c] = HERMES_CRED_KEYS.some((k) => k !== 'HERMES_API_KEY' && k.toLowerCase().includes(c) && h.creds[k]);
      return o;
    }, {})
  };
}
function setHermesConfig(user, patch) {
  const h = getHermesRaw(user);
  if (patch.provider !== undefined) {
    if (patch.provider && !HERMES_PROVIDERS.includes(patch.provider)) throw new Error('未知 provider');
    h.provider = patch.provider || null;
  }
  if (patch.budgets) for (const k of ['tokensPerDay', 'messagesPerDay', 'tasksPerDay']) {
    if (Number.isFinite(+patch.budgets[k])) h.budgets[k] = Math.max(0, Math.floor(+patch.budgets[k]));
  }
  if (patch.connectors) for (const c of HERMES_CONNECTORS) {
    if (c in patch.connectors) h.connectors[c] = !!patch.connectors[c];
  }
  if (patch.tools) for (const t of HERMES_TOOLS) {
    if (t in patch.tools) h.tools[t] = !!patch.tools[t];
  }
  saveStore();
  return publicHermes(user);
}
function setHermesCreds(user, creds) {
  const h = getHermesRaw(user);
  for (const k of HERMES_CRED_KEYS) {
    if (typeof creds[k] === 'string' && creds[k].trim()) h.creds[k] = creds[k].trim();
  }
  saveStore();
  return publicHermes(user);
}
function setHermesEnabled(user, enabled, status) {
  const h = getHermesRaw(user);
  h.enabled = !!enabled;
  if (!h.createdAt) h.createdAt = new Date().toISOString();
  if (status) h.status = status;
  if (enabled) h.lastStartedAt = new Date().toISOString();
  else { h.lastStoppedAt = new Date().toISOString(); if (!status) h.status = 'OFF'; }
  saveStore();
  return publicHermes(user);
}
function setHermesStatus(userId, status) {
  const u = getUserById(userId); if (!u) return;
  getHermesRaw(u).status = status; saveStore();
}
// 预算：自动按天重置；返回是否仍在预算内
function hermesWithinBudget(user) {
  const h = getHermesRaw(user);
  const day = new Date().toISOString().slice(0, 10);
  if (h.usage.day !== day) { h.usage = { day, tokens: 0, messages: 0, tasks: 0 }; saveStore(); }
  return h.usage.tokens < h.budgets.tokensPerDay
    && h.usage.messages < h.budgets.messagesPerDay
    && h.usage.tasks < h.budgets.tasksPerDay;
}
function recordHermesUsage(userId, delta) {
  const u = getUserById(userId); if (!u) return;
  const h = getHermesRaw(u);
  const day = new Date().toISOString().slice(0, 10);
  if (h.usage.day !== day) h.usage = { day, tokens: 0, messages: 0, tasks: 0 };
  h.usage.tokens += Math.max(0, delta.tokens || 0);
  h.usage.messages += Math.max(0, delta.messages || 0);
  h.usage.tasks += Math.max(0, delta.tasks || 0);
  saveStore();
}
function getHermesCreds(user) { return { ...getHermesRaw(user).creds }; }
// admin 视图：所有用户的 hermes 概览
function listHermes() {
  return Object.values(store.users)
    .filter((u) => u.hermes && (u.hermes.enabled || u.hermes.createdAt))
    .map((u) => ({ userId: u.id, ...publicHermes(u) }));
}

module.exports = {
  SESSION_COOKIE, SESSION_TTL_MS, ALLOWED_CRED_KEYS, STATUS,
  FREE_RUN_DAYS, RETENTION_DAYS, MAX_RUNNING_FREE, MAX_CREATE_PER_DAY, MAX_REGISTER_PER_IP_PER_DAY,
  sanitizeId, genToken,
  // settings
  getSettings, setSetting,
  // invites
  createInvite, listInvites, disableInvite, validateInvite, consumeInvite,
  // accounts
  registerUser, verifyLogin, getUserById, isAdmin, setBan, listUsers,
  // email activation
  EMAIL_RE, normEmail, getUserByEmail, emailExists, issueActivationCode, canResend,
  isActivated, verifyActivation,
  // password reset
  issueResetCode, canResetResend, verifyResetAndSetPassword, killUserSessions,
  // ip controls
  normIp, isIpBanned, banIp, unbanIp, listBannedIps, countRegisterToday, recordRegister, setUserIp,
  // github oauth
  setGithubOAuth, getGithubToken, clearGithubOAuth, publicGithub,
  // community
  COMMUNITY_LEVELS, publicCommunity, publishProject, unpublishProject, listCommunity, getCommunityEntry, takedownCommunity,
  // collaboration rooms
  addCollaborator, removeCollaborator, listCollaborators, isRoomMember, resolveRoomChannel, listRoomsForMember,
  normalizeLockFile, listLocks, claimLocks, releaseLocks, releaseAllLocksByUser,
  // sessions
  createSession, destroySession, getSessionUser, getUserFromRequest, parseCookies,
  requireAuth, requireAdmin,
  // projects / lifecycle
  listProjects, publicProject, countRunningProjects, countCreatedToday,
  getOrCreateProject, getProject, updateProject, touchProject, deleteProject, allProjects,
  setProjectCreds, resolveChannel, lookupChannel,
  // hermes 云端秘书
  HERMES_PROVIDERS, HERMES_CONNECTORS, HERMES_TOOLS, HERMES_CRED_KEYS,
  publicHermes, setHermesConfig, setHermesCreds, setHermesEnabled, setHermesStatus,
  hermesWithinBudget, recordHermesUsage, getHermesCreds, listHermes
};

