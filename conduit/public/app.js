// ===== 全局状态 =====
let ws = null;
let term = null;
let fitAddon = null;
let currentTab = 'chat';
let activeStepBodyId = null;
let authMode = 'login';            // 'login' | 'register'
let currentUser = null;
let currentProject = null;
let projects = [];
let currentOwner = null;       // 协作房间所有者；null/== 自己 表示自己的项目
let roomsJoined = [];          // 我被邀请加入的房间 [{ownerId,projectId}]
let lastPorts = [];
let lastPreviewPaths = [];
let currentConvId = null;        // 当前会话 ID（多会话切换）
let currentPreviewPort = null;   // 当前预览的端口
let previewLoadedPort = null;    // iframe 当前已加载的端口（避免轮询打断用户浏览）
const CHAT_PROVIDERS = {
  claude: {
    label: 'Claude',
    keyFlag: 'hasAnthropicKey',
    keyName: 'Anthropic API Key',
    login: true,
    models: [
      { value: '', label: '默认（Claude CLI）' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
      { value: '__custom', label: '自定义模型 ID' }
    ]
  },
  codex: {
    label: 'Codex',
    keyFlag: 'hasOpenAIKey',
    keyName: 'OpenAI API Key',
    login: true,
    models: [
      { value: '', label: '默认（Codex CLI）' },
      { value: '__custom', label: '自定义模型 ID' }
    ]
  },
  deepseek: {
    label: 'DeepSeek',
    keyFlag: 'hasDeepSeekKey',
    keyName: 'DeepSeek API Key',
    login: false,
    models: [
      { value: '', label: '默认（deepseek-chat）' },
      { value: 'deepseek-chat', label: 'deepseek-chat' },
      { value: 'deepseek-reasoner', label: 'deepseek-reasoner' },
      { value: '__custom', label: '自定义模型 ID' }
    ]
  },
  glm: {
    label: 'GLM / 智谱',
    keyFlag: 'hasGlmKey',
    keyName: 'GLM（智谱）API Key',
    login: false,
    models: [
      { value: '', label: '默认（glm-5.2）' },
      { value: 'glm-5.2', label: 'glm-5.2（最新·1M 上下文）' },
      { value: 'glm-4.6', label: 'glm-4.6' },
      { value: 'glm-4.5-air', label: 'glm-4.5-air' },
      { value: 'glm-4-flash', label: 'glm-4-flash（便宜）' },
      { value: '__custom', label: '自定义模型 ID' }
    ]
  },
  kimi: {
    label: 'Kimi / Moonshot',
    keyFlag: 'hasKimiKey',
    keyName: 'Moonshot（Kimi）API Key',
    login: false,
    models: [
      { value: '', label: '默认（kimi-k2）' },
      { value: 'kimi-k2-0905-preview', label: 'kimi-k2' },
      { value: 'moonshot-v1-128k', label: 'moonshot-v1-128k' },
      { value: 'moonshot-v1-32k', label: 'moonshot-v1-32k' },
      { value: '__custom', label: '自定义模型 ID' }
    ]
  },
  qwen: {
    label: 'Qwen / 通义',
    keyFlag: 'hasQwenKey',
    keyName: 'DashScope（通义）API Key',
    login: false,
    models: [
      { value: '', label: '默认（qwen-plus）' },
      { value: 'qwen-plus', label: 'qwen-plus' },
      { value: 'qwen-max', label: 'qwen-max' },
      { value: 'qwen-turbo', label: 'qwen-turbo（便宜）' },
      { value: '__custom', label: '自定义模型 ID' }
    ]
  }
};
const DEFAULT_CHAT_PROVIDER = 'deepseek';
let currentChatTool = normalizeChatProvider(safeStorageGet('cab.chat.provider') || DEFAULT_CHAT_PROVIDER); // 对话模式用哪个平台
let currentChatModel = safeStorageGet(chatModelStorageKey(currentChatTool)) || ''; // 同平台下的模型 ID
let pendingReplyEl = null;        // 等待 AI 回复填充的气泡
let pendingReplyText = '';        // 流式回复累积文本
let historyLoaded = false;        // 本次页面是否已加载过历史对话
let terminalLoginHelperState = { provider: null, url: '' };
let terminalLoginBuffer = '';

// 所有 DOM 访问均为防御式动态获取，脚本提前加载也不会因 null 崩溃。
const $ = (id) => document.getElementById(id);

// ===================================================================
// 认证
// ===================================================================
window.toggleAuthMode = function () {
  authMode = authMode === 'login' ? 'register' : 'login';
  const submit = $('authSubmit');
  const switchText = $('authSwitchText');
  const switchBtn = $('authSwitchBtn');
  const msg = $('authMsg');
  const emailField = $('emailField');
  if (msg) { msg.textContent = ''; msg.className = 'auth-msg'; }
  if (emailField) emailField.style.display = authMode === 'register' ? 'block' : 'none';
  const ap = $('activatePanel'); if (ap) ap.style.display = 'none'; // 切模式收起激活面板
  const rp = $('resetPanel'); if (rp) rp.style.display = 'none';
  const fw = $('forgotWrap'); if (fw) fw.style.display = authMode === 'register' ? 'none' : 'inline';
  if (authMode === 'login') {
    if (submit) submit.textContent = '登录';
    if (switchText) switchText.textContent = '还没有账号？';
    if (switchBtn) switchBtn.textContent = '注册一个';
  } else {
    if (submit) submit.textContent = '注册并登录';
    if (switchText) switchText.textContent = '已有账号？';
    if (switchBtn) switchBtn.textContent = '去登录';
  }
};

function setAuthMsg(text, kind) {
  const msg = $('authMsg');
  if (!msg) return;
  msg.textContent = text || '';
  msg.className = 'auth-msg' + (kind ? ' ' + kind : '');
}

let pendingEmail = null; // 待激活邮箱
function showActivate(email, hint) {
  pendingEmail = email;
  const ap = $('activatePanel'); if (ap) ap.style.display = 'block';
  const ae = $('activateEmail'); if (ae) ae.textContent = email || '';
  if (hint) setAuthMsg(hint, '');
  const cf = $('authCode'); if (cf) cf.focus();
}

window.doAuth = async function () {
  const username = ($('authUser') || {}).value ? $('authUser').value.trim() : '';
  const password = ($('authPass') || {}).value || '';
  if (!username || !password) return setAuthMsg('请输入用户名和密码', 'err');

  if (authMode === 'register') {
    const email = ($('authEmail') || {}).value ? $('authEmail').value.trim() : '';
    if (!email) return setAuthMsg('请填写邮箱', 'err');
    setAuthMsg('注册中，正在发送激活码…', '');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, email })
      });
      const data = await res.json();
      if (!res.ok) return setAuthMsg(data.error || '注册失败', 'err');
      showActivate(data.email, data.devMode ? `（开发模式）激活码：${data.devCode}` : '激活码已发到你的邮箱，请查收（含垃圾箱）');
    } catch (err) { setAuthMsg('请求失败：' + err.message, 'err'); }
    return;
  }

  // 登录
  setAuthMsg('处理中…', '');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.status === 403 && data.code === 'NOT_ACTIVATED') {
      return showActivate(data.email, '该账号邮箱未激活，请输入激活码（可重发）');
    }
    if (!res.ok) return setAuthMsg(data.error || '失败', 'err');
    setAuthMsg('成功', 'ok');
    await enterApp();
  } catch (err) {
    setAuthMsg('请求失败：' + err.message, 'err');
  }
};

window.doActivate = async function () {
  const code = ($('authCode') || {}).value ? $('authCode').value.trim() : '';
  if (!pendingEmail) return setAuthMsg('请先注册或登录', 'err');
  if (!code) return setAuthMsg('请输入激活码', 'err');
  setAuthMsg('激活中…', '');
  try {
    const res = await fetch('/api/auth/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, code })
    });
    const data = await res.json();
    if (!res.ok) return setAuthMsg(data.error || '激活失败', 'err');
    setAuthMsg('激活成功', 'ok');
    await enterApp();
  } catch (err) { setAuthMsg('请求失败：' + err.message, 'err'); }
};

window.doResend = async function () {
  if (!pendingEmail) return;
  setAuthMsg('重新发送中…', '');
  try {
    const res = await fetch('/api/auth/resend', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail })
    });
    const data = await res.json();
    if (!res.ok) return setAuthMsg(data.error || '发送失败', 'err');
    if (data.alreadyActivated) return setAuthMsg('该账号已激活，请直接登录', 'ok');
    setAuthMsg(data.devMode ? `（开发模式）激活码：${data.devCode}` : '已重新发送，请查收邮箱', 'ok');
  } catch (err) { setAuthMsg('请求失败：' + err.message, 'err'); }
};

// ---- 找回密码 ----
window.startForgot = function () {
  const ap = $('activatePanel'); if (ap) ap.style.display = 'none';
  const rp = $('resetPanel'); if (rp) rp.style.display = 'block';
  const s2 = $('resetStep2'); if (s2) s2.style.display = 'none';
  setAuthMsg('输入注册邮箱，我们会发一个验证码给你', '');
};
window.cancelForgot = function () {
  const rp = $('resetPanel'); if (rp) rp.style.display = 'none';
  setAuthMsg('', '');
};
window.sendResetCode = async function () {
  const email = ($('resetEmail') || {}).value ? $('resetEmail').value.trim() : '';
  if (!email) return setAuthMsg('请输入邮箱', 'err');
  setAuthMsg('发送中…', '');
  try {
    const res = await fetch('/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const data = await res.json();
    if (!res.ok) return setAuthMsg(data.error || '发送失败', 'err');
    const s2 = $('resetStep2'); if (s2) s2.style.display = 'block';
    setAuthMsg(data.devMode ? `（开发模式）验证码：${data.devCode}` : '若该邮箱已注册，验证码已发出，请查收（含垃圾箱）', 'ok');
  } catch (err) { setAuthMsg('请求失败：' + err.message, 'err'); }
};
window.doReset = async function () {
  const email = ($('resetEmail') || {}).value ? $('resetEmail').value.trim() : '';
  const code = ($('resetCode') || {}).value ? $('resetCode').value.trim() : '';
  const newPassword = ($('resetNewPass') || {}).value || '';
  if (!code || !newPassword) return setAuthMsg('请填验证码和新密码', 'err');
  setAuthMsg('重置中…', '');
  try {
    const res = await fetch('/api/auth/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code, newPassword }) });
    const data = await res.json();
    if (!res.ok) return setAuthMsg(data.error || '重置失败', 'err');
    cancelForgot();
    if ($('authUser') && data.username) $('authUser').value = data.username;
    if ($('authPass')) $('authPass').value = '';
    setAuthMsg('✅ 密码已重置，请用新密码登录', 'ok');
  } catch (err) { setAuthMsg('请求失败：' + err.message, 'err'); }
};

window.doLogout = async function () {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  wsIntentionalClose = true; wsHasConnected = false;
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  currentUser = null; currentProject = null; projects = [];
  showAuth();
};

function showAuth() {
  const a = $('authView'); const app = $('appView');
  if (a) a.classList.remove('hidden');
  if (app) app.classList.add('hidden');
}

async function enterApp() {
  // 拉取当前登录态与项目列表
  const res = await fetch('/api/auth/me');
  if (!res.ok) { showAuth(); return; }
  const me = await res.json();
  currentUser = me.username;
  projects = me.projects || [];
  currentOwner = null;
  try { const rr = await fetch('/api/rooms'); if (rr.ok) { const rd = await rr.json(); roomsJoined = (rd.rooms || []).filter((r) => r.role === 'member'); } } catch (e) {}

  const a = $('authView'); const app = $('appView');
  if (a) a.classList.add('hidden');
  if (app) app.classList.remove('hidden');

  const adminLink = $('adminLink');
  if (adminLink) adminLink.style.display = me.isAdmin ? 'flex' : 'none';

  refreshChatModelControls();

  refreshProjectSelect();
  loadXtermDynamically();
  window.handleResizeLayout();
  if (window.refreshHermes) refreshHermes();
  if (window.refreshGithub) refreshGithub();
  if (window.refreshCommunityStatus) refreshCommunityStatus();
  if (window.refreshCollab) refreshCollab();
  // OAuth 回跳提示
  const gp = new URLSearchParams(window.location.search).get('github');
  if (gp) {
    addChatMessage('ai', gp === 'connected' ? '✅ GitHub 已连接，可在【配置】里一键建仓/开 PR。' : '⚠️ GitHub 连接失败，请重试。');
    history.replaceState(null, '', window.location.pathname);
  }
}

// ===================================================================
// 项目管理
// ===================================================================
const STATUS_LABEL = {
  CREATED: '未启动', RUNNING: '运行中', STOPPED: '已停止',
  EXPIRED: '已过期', BACKED_UP: '已备份', DESTROYED: '已销毁', ERROR: '异常'
};

function daysLeft(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function refreshProjectSelect() {
  const sel = $('projectSelect');
  if (!sel) return;
  const visible = projects.filter((p) => p.status !== 'DESTROYED');
  sel.innerHTML = '';
  if (!visible.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '（暂无项目，请新建）';
    sel.appendChild(opt);
    currentProject = null;
  } else {
    visible.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.projectId;
      opt.textContent = `${p.projectId} · ${STATUS_LABEL[p.status] || p.status}`;
      sel.appendChild(opt);
    });
    if (!currentProject || !visible.find((p) => p.projectId === currentProject)) {
      currentProject = visible[0].projectId; currentOwner = null;
    }
    if (!currentOwner) sel.value = currentProject;
    prefillKeys();
  }
  // 追加：我加入的协作房间（别人的项目）
  roomsJoined.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = `room:${r.ownerId}/${r.projectId}`;
    opt.textContent = `👥 ${r.ownerId}/${r.projectId}（协作）`;
    sel.appendChild(opt);
  });
  if (currentOwner) sel.value = `room:${currentOwner}/${currentProject}`;
  updateProjectMeta();
  refreshChatModelControls();
}

function updateProjectMeta() {
  const meta = $('projectMeta');
  if (!meta) return;
  const p = projects.find((x) => x.projectId === currentProject);
  if (!p) { meta.textContent = ''; return; }
  const d = daysLeft(p.expiresAt);
  const rd = Math.max(0, daysLeft(p.retentionUntil));
  meta.textContent = `状态：${STATUS_LABEL[p.status] || p.status}　·　` +
    (d > 0 ? `剩 ${d} 天到期` : '已到期') +
    `　·　备份保留约 ${rd} 天`;
}

function prefillKeys() {
  // 不回显密钥本体，仅用 placeholder 提示是否已绑定
  const p = projects.find((x) => x.projectId === currentProject);
  const ak = $('anthropicKey'); const ok = $('openaiKey'); const dk = $('deepseekKey');
  if (ak) { ak.value = ''; ak.placeholder = p && p.hasAnthropicKey ? '已绑定（留空则不改）' : 'sk-ant-...'; }
  if (ok) { ok.value = ''; ok.placeholder = p && p.hasOpenAIKey ? '已绑定（留空则不改）' : 'sk-...'; }
  if (dk) { dk.value = ''; dk.placeholder = p && p.hasDeepSeekKey ? '已绑定（留空则不改）' : 'sk-...'; }
  const gk = $('glmKey'); if (gk) { gk.value = ''; gk.placeholder = p && p.hasGlmKey ? '已绑定（留空则不改）' : '智谱开放平台 API Key'; }
  const kk = $('kimiKey'); if (kk) { kk.value = ''; kk.placeholder = p && p.hasKimiKey ? '已绑定（留空则不改）' : 'Moonshot 开放平台 API Key'; }
  const qk = $('qwenKey'); if (qk) { qk.value = ''; qk.placeholder = p && p.hasQwenKey ? '已绑定（留空则不改）' : '阿里云百炼 DashScope API Key'; }
  const gt = $('githubToken'); const gu = $('gitUser'); const ge = $('gitEmail'); const pb = $('projectBrief');
  if (gt) { gt.value = ''; gt.placeholder = p && p.hasGitHub ? '已绑定（留空则不改）' : 'GitHub Token (PAT，需 repo 权限)'; }
  if (gu) gu.value = '';
  if (ge) ge.value = '';
  if (pb) { pb.value = ''; pb.placeholder = p && p.hasBrief ? '已填项目说明（留空则不改）' : '例：仿淘宝的商城前端，HTML/CSS/JS，重点首页和商品列表'; }
}

function isCollab() { return !!(currentOwner && currentOwner !== currentUser); }
function ownerParam() { return isCollab() ? '&owner=' + encodeURIComponent(currentOwner) : ''; }
window.onProjectChange = function () {
  const sel = $('projectSelect');
  if (!sel) return;
  const v = sel.value || '';
  if (v.startsWith('room:')) {
    const m = v.slice(5).match(/^([^/]+)\/(.+)$/);
    if (m) { currentOwner = m[1]; currentProject = m[2]; }
  } else {
    currentOwner = null; currentProject = v || null;
  }
  prefillKeys(); updateProjectMeta();
  refreshChatModelControls();
  historyLoaded = false;
  if (window.refreshCommunityStatus) refreshCommunityStatus();
  if (window.refreshCollab) refreshCollab();
};

// 生成可分享的临时预览链接（带过期）
window.makePreviewLink = async function () {
  if (!currentProject) return alert('请先选择项目');
  if (!lastPorts.length) return alert('当前没有检测到正在监听的端口（先在沙箱里启动一个 web 服务）');
  const port = currentPreviewPort || lastPorts[0];
  try {
    const res = await fetch('/api/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject, port, ...(isCollab() ? { owner: currentOwner } : {}) })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || '生成失败');
    const [rootUrl, query = ''] = String(data.url || '').split('?');
    const sharedPath = rootUrl.replace(/\/$/, '') + currentPreviewPath() + (query ? '?' + query : '');
    const fullUrl = `${window.location.origin}${sharedPath}`;
    try { await navigator.clipboard.writeText(fullUrl); } catch (e) {}
    addChatMessage('ai', `🔗 临时预览链接（${data.ttlMinutes} 分钟有效，已复制）：<br><code style="word-break:break-all;">${fullUrl}</code>`);
  } catch (err) { alert('请求失败：' + err.message); }
};

window.createProject = async function () {
  const input = $('newProjectInput');
  const name = input && input.value ? input.value.trim() : '';
  if (!name) return alert('请输入新项目名');
  try {
    const res = await fetch('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: name })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || '创建失败');
    if (input) input.value = '';
    currentProject = data.projectId;
    // 从服务器重新拉完整项目数据（含状态/到期时间），避免本地拼一个缺字段的对象导致显示 undefined
    try { const r = await fetch('/api/projects'); if (r.ok) { const d = await r.json(); if (d.projects) projects = d.projects; } } catch (e) {}
    refreshProjectSelect();
    addChatMessage('ai', `📁 项目 <b>${data.projectId}</b> 已创建，点【激活并连接沙箱】启动它的隔离容器。`);
  } catch (err) { alert('请求失败：' + err.message); }
};

// ===================================================================
// 连接沙箱
// ===================================================================
window.connect = async function () {
  if (!currentProject) return alert('请先新建或选择一个项目');
  wsIntentionalClose = true; wsHasConnected = false; // 重新激活：旧连接的关闭不触发重连
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) { try { ws.close(); } catch (e) {} }

  if (window.closeSettings) closeSettings();

  // 协作者加入别人的房间：不自己启沙箱（由房主激活），直接连管道
  if (isCollab()) {
    addChatMessage('ai', `正在加入 ${currentOwner} 的协作房间…`);
    const protocol2 = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    openClientWs(`${protocol2}//${window.location.host}/client?projectId=${encodeURIComponent(currentProject)}${ownerParam()}`);
    return;
  }

  addChatMessage('ai', '正在唤醒云端隔离沙箱…');
  try {
    const res = await fetch('/api/sandbox/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject })
    });
    const data = await res.json();
    if (data && data.ok === false) {
      // 激活可观测：把失败在哪一步 + 容器日志摘要显示出来，而不是黑盒
      let msg = `⚠️ 激活失败 [${data.step || '?'}]：${data.error || ''}`;
      if (data.logs) {
        const safe = String(data.logs).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        msg += `<br><b>容器日志(末尾，已脱敏)：</b><br><code style="white-space:pre-wrap;word-break:break-all;font-size:.72rem;">${safe}</code>`;
      }
      addChatMessage('ai', msg);
    } else if (!res.ok) {
      addChatMessage('ai', `⚠️ 唤醒失败：${data.error || ''} ${data.details || ''}`);
    } else {
      const st = (data.result && data.result.status) || '';
      const mode = st.startsWith('mock') ? '本地模拟进程' : 'Docker 容器';
      addChatMessage('ai', `✅ 沙箱就绪（${mode}），遥控管道已通。`);
    }
  } catch (err) {
    addChatMessage('ai', '⚠️ 唤醒请求异常，仍尝试连通管道…');
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  openClientWs(`${protocol}//${window.location.host}/client?projectId=${encodeURIComponent(currentProject)}${ownerParam()}`);
};

// 自动重连状态：手机录屏/切后台会让浏览器挂起标签、断开 WebSocket，需自动连回
let wsLastUrl = null, wsIntentionalClose = false, wsReconnectTimer = null, wsReconnectDelay = 1000, wsHasConnected = false;

function openClientWs(wsUrl) {
  wsLastUrl = wsUrl;
  wsIntentionalClose = false;
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }   // 替换旧连接时不触发重连
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    wsReconnectDelay = 1000;                       // 连上了，退避归零
    setStatus(true);
    if (!wsHasConnected) { wsHasConnected = true; addChatMessage('ai', isCollab() ? '🎉 已加入协作房间！' : '🎉 遥控器已在线！可以发指令了。'); }
    else { addChatMessage('ai', '✅ 已重新连接。'); }
    fitTerminal();
    try { ws.send(JSON.stringify({ event: 'list-conversations' })); ws.send(JSON.stringify({ event: 'get-chat-history' })); } catch (e) {}
  };
  ws.onmessage = (event) => {
    try { handleServerMessage(JSON.parse(event.data)); } catch (e) { console.error(e); }
  };
  ws.onclose = () => {
    setStatus(false);
    if (wsIntentionalClose) return;                // 登出/切项目/销毁 → 不重连
    if (!wsReconnectTimer) addChatMessage('ai', '🔄 连接断开，正在自动重连…');
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} }; // 触发 onclose → 走重连
}

function scheduleReconnect() {
  if (!wsLastUrl || wsIntentionalClose || wsReconnectTimer) return;
  const text = $('statusText'); if (text) text.textContent = '重连中…';
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    if (!wsIntentionalClose && wsLastUrl) openClientWs(wsLastUrl);
  }, wsReconnectDelay);
  wsReconnectDelay = Math.min(Math.round(wsReconnectDelay * 1.6), 8000); // 退避，封顶 8s
}

// 手机切回前台 / 标签恢复可见时，若连接已断立刻连回（不等退避）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!wsLastUrl || wsIntentionalClose) return;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    wsReconnectDelay = 1000;
    openClientWs(wsLastUrl);
  }
});

function setStatus(online) {
  const dot = $('statusDot'); const text = $('statusText');
  const btnText = $('connectBtnText'); const btn = $('connectBtn');
  if (dot) dot.className = online ? 'dot online' : 'dot';
  if (text) text.textContent = online ? '在线' : '离线';
  if (btnText) btnText.textContent = online ? '已连接（点此重连）' : '激活并连接沙箱';
}

// ===================================================================
// 绑定凭证
// ===================================================================
window.bindKeys = async function () {
  if (!currentProject) return alert('请先选择项目');
  const creds = {};
  const ak = $('anthropicKey'); const ok = $('openaiKey'); const dk = $('deepseekKey'); const gk = $('glmKey'); const kk = $('kimiKey'); const qk = $('qwenKey');
  const gu = $('gitUser'); const ge = $('gitEmail'); const gt = $('githubToken'); const pb = $('projectBrief');
  if (ak && ak.value.trim()) creds.ANTHROPIC_API_KEY = ak.value.trim();
  if (ok && ok.value.trim()) creds.OPENAI_API_KEY = ok.value.trim();
  if (dk && dk.value.trim()) creds.DEEPSEEK_API_KEY = dk.value.trim();
  if (gk && gk.value.trim()) creds.GLM_API_KEY = gk.value.trim();
  if (kk && kk.value.trim()) creds.MOONSHOT_API_KEY = kk.value.trim();
  if (qk && qk.value.trim()) creds.DASHSCOPE_API_KEY = qk.value.trim();
  if (gu && gu.value.trim()) creds.GIT_USERNAME = gu.value.trim();
  if (ge && ge.value.trim()) creds.GIT_EMAIL = ge.value.trim();
  if (gt && gt.value.trim()) creds.GITHUB_TOKEN = gt.value.trim();
  if (pb && pb.value.trim()) creds.PROJECT_BRIEF = pb.value.trim();
  if (!Object.keys(creds).length) return alert('请至少填写一项（API Key / GitHub / 项目说明）');
  try {
    const res = await fetch('/api/creds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: currentProject, creds })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || '保存失败');
    // 本地标记已绑定 + 清空输入框
    const p = projects.find((x) => x.projectId === currentProject);
    if (p) {
      if (creds.ANTHROPIC_API_KEY) p.hasAnthropicKey = true;
      if (creds.OPENAI_API_KEY) p.hasOpenAIKey = true;
      if (creds.DEEPSEEK_API_KEY) p.hasDeepSeekKey = true;
      if (creds.GLM_API_KEY) p.hasGlmKey = true;
      if (creds.MOONSHOT_API_KEY) p.hasKimiKey = true;
      if (creds.DASHSCOPE_API_KEY) p.hasQwenKey = true;
      if (creds.GITHUB_TOKEN) p.hasGitHub = true;
      if (creds.PROJECT_BRIEF) p.hasBrief = true;
    }
    prefillKeys();
    refreshChatModelControls();
    let msg = `🔐 已保存：${data.bound.join('、')}。沙箱在线时即时生效。`;
    if (creds.DEEPSEEK_API_KEY) msg += '<br>已把 DeepSeek 接好（对话模型选 DeepSeek 即用）。';
    if (creds.GLM_API_KEY) msg += '<br>已把 GLM/智谱 接好（对话模型选 GLM 即用，经 ccr 调用）。';
    if (creds.GITHUB_TOKEN) msg += '<br>GitHub 免密已配：终端可直接 <code>git clone/push</code>。';
    if (creds.PROJECT_BRIEF) msg += '<br>项目说明已写入 CLAUDE.md，AI 会据此了解你的项目。';
    addChatMessage('ai', msg);
  } catch (err) { alert('请求失败：' + err.message); }
};

// ===================================================================
// 对话模型 / 凭证状态
// ===================================================================
function safeStorageGet(key) {
  try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (e) { return null; }
}
function safeStorageSet(key, value) {
  try { if (window.localStorage) window.localStorage.setItem(key, value); } catch (e) {}
}
function safeStorageRemove(key) {
  try { if (window.localStorage) window.localStorage.removeItem(key); } catch (e) {}
}
function normalizeChatProvider(provider) {
  return CHAT_PROVIDERS[provider] ? provider : DEFAULT_CHAT_PROVIDER;
}
function chatModelStorageKey(provider) {
  return 'cab.chat.model.' + normalizeChatProvider(provider);
}
function currentProjectInfo() {
  return projects.find((x) => x.projectId === currentProject) || null;
}
function loginStorageKey(tool) {
  return 'cab.login.' + (currentUser || 'anon') + '.' + normalizeChatProvider(tool);
}
function hasMarkedLogin(tool) {
  return safeStorageGet(loginStorageKey(tool)) === '1';
}
function providerHasProjectKey(tool) {
  const cfg = CHAT_PROVIDERS[normalizeChatProvider(tool)];
  const p = currentProjectInfo();
  return !!(cfg && p && p[cfg.keyFlag]);
}
function selectedChatModel() {
  const sel = $('chatModelSelect');
  const custom = $('chatCustomModel');
  if (sel) {
    if (sel.value === '__custom') return ((custom && custom.value) || '').trim();
    return sel.value || '';
  }
  return currentChatModel || '';
}
function setSelectedChatModel(model) {
  currentChatModel = (model || '').trim();
  safeStorageSet(chatModelStorageKey(currentChatTool), currentChatModel);
}
function chatCredentialState(tool) {
  const provider = normalizeChatProvider(tool);
  const cfg = CHAT_PROVIDERS[provider];
  if (isCollab()) {
    return { ok: true, shortText: '协作房间：使用房主沙箱配置。', message: '' };
  }
  if (!currentProject) {
    return { ok: false, shortText: '未选择项目', message: '请先在【设置 > 项目】新建或选择一个项目。' };
  }
  if (providerHasProjectKey(provider)) {
    return { ok: true, shortText: cfg.label + '：API Key 已绑定', message: '' };
  }
  if (cfg.login && hasMarkedLogin(provider)) {
    return { ok: true, shortText: cfg.label + '：使用会员登录', message: '' };
  }
  const loginHint = cfg.login ? '，或先连接沙箱后完成会员登录，并点“已完成登录”' : '';
  return {
    ok: false,
    shortText: cfg.label + ' 未接入',
    message: '还没接上 ' + cfg.label + '。请在【设置 > 模型/账号】绑定 ' + cfg.keyName + loginHint + '，再发送。'
  };
}
function refreshLoginStatus() {
  const el = $('loginStatus');
  if (!el) return;
  el.textContent = 'Claude：' + (hasMarkedLogin('claude') ? '已标记会员登录' : '未标记') + '　·　Codex：' + (hasMarkedLogin('codex') ? '已标记会员登录' : '未标记');
}
function refreshChatModelControls() {
  currentChatTool = normalizeChatProvider(currentChatTool);
  const cfg = CHAT_PROVIDERS[currentChatTool];
  const providerSel = $('chatProvider');
  if (providerSel) providerSel.value = currentChatTool;

  const modelSel = $('chatModelSelect');
  const custom = $('chatCustomModel');
  if (modelSel) {
    modelSel.innerHTML = '';
    const known = cfg.models || [];
    known.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      modelSel.appendChild(opt);
    });
    const useCustom = !!currentChatModel && !known.some((m) => m.value === currentChatModel);
    modelSel.value = useCustom ? '__custom' : (currentChatModel || '');
    if (custom) {
      custom.style.display = modelSel.value === '__custom' ? 'block' : 'none';
      custom.value = modelSel.value === '__custom' ? currentChatModel : '';
    }
  }

  const state = chatCredentialState(currentChatTool);
  const status = $('chatCredentialStatus');
  if (status) {
    status.textContent = state.shortText;
    status.classList.toggle('ok', state.ok);
    status.classList.toggle('warn', !state.ok);
  }
  const launchLabel = $('launchSelectedLabel');
  if (launchLabel) launchLabel.textContent = cfg.label;
  refreshLoginStatus();
}
window.onChatProviderChange = function (value) {
  const next = normalizeChatProvider(value || (($('chatProvider') || {}).value));
  currentChatTool = next;
  safeStorageSet('cab.chat.provider', next);
  currentChatModel = safeStorageGet(chatModelStorageKey(next)) || '';
  refreshChatModelControls();
  addChatMessage('ai', '已切换对话平台为 <b>' + toolLabel(next) + '</b>。模型可在旁边选择；没有 Key 时会先提醒，不会再直接丢底层 API 错误。');
};
window.onChatModelChange = function () {
  const sel = $('chatModelSelect');
  const custom = $('chatCustomModel');
  if (!sel) return;
  if (sel.value === '__custom') {
    if (custom) custom.style.display = 'block';
    setSelectedChatModel((custom && custom.value) || '');
  } else {
    if (custom) { custom.style.display = 'none'; custom.value = ''; }
    setSelectedChatModel(sel.value || '');
  }
  refreshChatModelControls();
};
window.onChatCustomModelInput = function () {
  setSelectedChatModel(selectedChatModel());
};
window.markToolLoginDone = function (tool) {
  const provider = normalizeChatProvider(tool);
  const cfg = CHAT_PROVIDERS[provider];
  if (!cfg.login) return;
  safeStorageSet(loginStorageKey(provider), '1');
  refreshChatModelControls();
  addChatMessage('ai', '已标记 <b>' + cfg.label + '</b> 会员登录完成。之后即使没有 API Key，也允许用该平台发对话消息。');
};
window.clearToolLoginDone = function (tool) {
  const provider = normalizeChatProvider(tool);
  safeStorageRemove(loginStorageKey(provider));
  refreshChatModelControls();
};
window.launchSelectedTool = function () {
  window.launchTool(currentChatTool);
};
window.openSettingsSection = function (key) {
  const m = $('settingsModal');
  if (m) m.classList.add('show');
  if (window.selectSettingsSection) window.selectSettingsSection(key || 'project');
};
function shellQuoteArg(value) {
  const s = String(value || '');
  return /^[A-Za-z0-9_.:@/-]+$/.test(s) ? s : JSON.stringify(s);
}
function requireChatReady() {
  const state = chatCredentialState(currentChatTool);
  refreshChatModelControls();
  if (state.ok) return true;
  addChatMessage('ai', '⚠️ ' + state.message);
  window.openSettingsSection('creds');
  return false;
}

// ===================================================================
// 工具启动 / 登录（向 PTY 写入命令）
// ===================================================================
function sendToPty(command) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addChatMessage('ai', '⚠️ 沙箱未连线，请先在【设置 > 项目】里连接。');
    return false;
  }
  ws.send(JSON.stringify({ event: 'input', data: command }));
  return true;
}
function sendPtyLater(command, delay) {
  setTimeout(() => sendToPty(command), delay);
}
function loginGuide(provider) {
  if (provider === 'codex') {
    return '已为你打开 Codex 登录流程。请点登录助手里的“打开官方登录页”，完成授权后回到这里点“我已完成登录”。';
  }
  return '已为你打开 Claude 登录流程，并自动发送 /login。请点登录助手里的“打开官方登录页”，网页登录后把授权码粘贴回来。';
}
function terminalProviderLabel(provider) {
  return provider === 'codex' ? 'Codex' : 'Claude';
}
function stripTerminalAnsi(text) {
  return String(text || '').replace(/[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}
function providerFromLoginUrl(url) {
  if (/claude/i.test(url || '')) return 'claude';
  if (/openai|chatgpt/i.test(url || '')) return 'codex';
  return terminalLoginHelperState.provider || 'claude';
}
function extractLoginUrl(buffer) {
  const compact = stripTerminalAnsi(buffer).replace(/\s+/g, '');
  const start = compact.search(/https:\/\/(?:claude\.com|platform\.claude\.com|auth\.openai\.com|chatgpt\.com|platform\.openai\.com|openai\.com)/i);
  if (start < 0) return '';
  let url = compact.slice(start);
  const stops = ['Pastecode', 'Pasteauthorization', 'Esctocancel', 'Selectloginmethod', 'Browserdidn', 'PressCtrl', 'Welcomeback'];
  let end = url.length;
  stops.forEach((stop) => {
    const idx = url.toLowerCase().indexOf(stop.toLowerCase());
    if (idx > 12 && idx < end) end = idx;
  });
  url = url.slice(0, end);
  try { return new URL(url).href; } catch (e) { return url; }
}
function showLoginHelper(provider, url) {
  const p = normalizeChatProvider(provider || terminalLoginHelperState.provider || 'claude');
  terminalLoginHelperState.provider = p;
  if (url) terminalLoginHelperState.url = url;
  const box = $('terminalLoginHelper');
  if (!box) return;
  box.style.display = 'flex';
  const label = terminalProviderLabel(p);
  const title = $('loginHelperTitle');
  const hint = $('loginHelperHint');
  const urlBox = $('loginUrlBox');
  const openBtn = $('loginOpenBtn');
  const copyBtn = $('loginCopyBtn');
  const codeHint = $('loginCodeHint');
  const hasUrl = !!terminalLoginHelperState.url;
  if (title) title.textContent = label + ' 登录助手';
  if (hint) hint.innerHTML = hasUrl
    ? '1. 打开官方登录页完成授权。<br>2. 如果官方页面给你授权码，把它粘贴到下方并提交。<br>3. 终端显示登录成功后，点“我已完成登录”。'
    : '正在等待终端输出官方登录链接。这里不会收集你的 ' + label + ' 密码。';
  if (urlBox) { urlBox.style.display = hasUrl ? 'block' : 'none'; urlBox.textContent = terminalLoginHelperState.url || ''; }
  if (openBtn) openBtn.disabled = !hasUrl;
  if (copyBtn) copyBtn.disabled = !hasUrl;
  if (codeHint) codeHint.textContent = hasUrl ? '网页登录完成后，如果页面显示 code/authorization code，就粘贴到这里。' : '等待官方授权链接中...';
}
function handleLoginTerminalOutput(data) {
  const clean = stripTerminalAnsi(data);
  terminalLoginBuffer = (terminalLoginBuffer + clean).slice(-12000);
  const url = extractLoginUrl(terminalLoginBuffer);
  if (url && url !== terminalLoginHelperState.url) showLoginHelper(providerFromLoginUrl(url), url);
  if (/Paste code|authorization code|Browser didn|Select login method|Not logged in|Please run \/login/i.test(clean) && terminalLoginHelperState.provider) {
    showLoginHelper(terminalLoginHelperState.provider, terminalLoginHelperState.url);
  }
  if (/Welcome back|Successfully authenticated|Logged in/i.test(clean) && terminalLoginHelperState.provider) {
    const codeHint = $('loginCodeHint');
    if (codeHint) codeHint.textContent = '看起来已经登录成功。确认能正常使用后，点“我已完成登录”。';
  }
}
window.hideLoginHelper = function () {
  const box = $('terminalLoginHelper');
  if (box) box.style.display = 'none';
};
window.openLoginUrl = function () {
  if (!terminalLoginHelperState.url) return alert('还没有捕获到官方登录链接，请稍等几秒。');
  window.open(terminalLoginHelperState.url, '_blank', 'noopener');
};
window.copyLoginUrl = async function () {
  if (!terminalLoginHelperState.url) return alert('还没有捕获到官方登录链接，请稍等几秒。');
  try { await navigator.clipboard.writeText(terminalLoginHelperState.url); alert('已复制官方登录链接'); }
  catch (e) { alert('复制失败，请长按链接手动复制'); }
};
window.submitLoginCode = function () {
  const input = $('loginCodeInput');
  const val = input && input.value ? input.value.trim() : '';
  if (!val) return alert('请先粘贴授权码，或网页授权后跳转的完整 callback 链接');
  const codeHint = $('loginCodeHint');
  // Codex 等用 localhost 回调：粘贴完整 callback 链接 → 让容器内 agent 投递回调
  if (/^https?:\/\//i.test(val) && /[?&]code=/.test(val)) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'oauth-callback', url: val }));
      if (input) input.value = '';
      if (codeHint) codeHint.textContent = '已提交回调，正在投递到容器内登录服务，看终端结果...';
    } else { alert('沙箱未连线，请先连接'); }
    return;
  }
  // 否则当作要粘进终端的授权码（如 Claude 的 paste code 提示）
  if (sendToPty(val + String.fromCharCode(13))) {
    if (input) input.value = '';
    if (codeHint) codeHint.textContent = '授权码已提交给终端，等待登录结果...';
  }
};
window.finishLoginHelper = function () {
  if (terminalLoginHelperState.provider) window.markToolLoginDone(terminalLoginHelperState.provider);
  window.hideLoginHelper();
};

window.launchTool = function (tool) {
  const provider = normalizeChatProvider(tool);
  const model = selectedChatModel();
  const enter = String.fromCharCode(13);
  let cmd, label;
  if (provider === 'codex') {
    cmd = model ? 'codex --model ' + shellQuoteArg(model) + enter : 'codex' + enter;
    label = 'Codex';
  } else if (isRoutedProvider(provider)) {
    cmd = 'ccr code' + enter;
    label = 'Claude Code 路 ' + toolLabel(provider);
  } else {
    cmd = model ? 'claude --model ' + shellQuoteArg(model) + enter : 'claude' + enter;
    label = 'Claude Code';
  }
  if (sendToPty(cmd)) {
    const modelNote = model ? '（模型：' + model + '）' : '';
    addChatMessage('ai', '▶ 已在沙箱启动 <b>' + label + '</b>' + modelNote + '。终端交互适合处理 yes/no 批准；普通消息可直接用下方对话框。');
  }
};

window.loginTool = function (tool) {
  const provider = normalizeChatProvider(tool);
  const cfg = CHAT_PROVIDERS[provider];
  if (!cfg.login) {
    addChatMessage('ai', cfg.label + ' 没有会员号登录入口，请绑定 ' + cfg.keyName + ' 后使用。');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addChatMessage('ai', '⚠️ 请先在【设置 > 项目】里【激活并连接沙箱】，再发起会员登录。');
    if (window.openSettingsSection) window.openSettingsSection('project');
    return;
  }
  const enter = String.fromCharCode(13);
  const ctrlC = String.fromCharCode(3);
  if (!sendToPty(ctrlC)) return;
  sendPtyLater(ctrlC, 120);
  if (provider === 'codex') {
    sendPtyLater('codex login' + enter, 320);
  } else {
    sendPtyLater('claude' + enter, 320);
    sendPtyLater('/login' + enter, 2200);
  }
  if (window.closeSettings) closeSettings();
  if (window.switchTab) switchTab('terminal');
  setTimeout(() => { try { if (term) term.focus(); } catch (e) {} }, 150);
  showLoginHelper(provider, '');
  addChatMessage('ai', '🔑 ' + loginGuide(provider) + '<br>如果终端显示 npm auto-update 权限警告，可以先忽略，它不影响登录。');
};

// ===================================================================
// 核心：把指令原封不动转发给当前运行的 AI 工具
// ===================================================================
window.sendChatInstruction = function () {
  const el = $('chatInput');
  if (!el) return;
  const text = (el.value || '').trim();
  if (!text) return;
  if (!requireChatReady()) return;
  if (pendingReplyEl) { // 上一条还在生成 → 不重复发（避免触发后端忙碌拒绝、也别打断进度显示）
    const s = Math.floor((Date.now() - chatStartTs) / 1000);
    addChatMessage('ai', '⏳ 上一条还在生成中（已 ' + s + 's），请等它完成后再发～');
    return;
  }

  addChatMessage('user', text);
  el.value = '';
  window.autoGrow(el);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addChatMessage('ai', '⚠️ 沙箱未连线，请先在【设置 > 项目】里【激活并连接沙箱】。');
    return;
  }

  // 对话模式：发给 headless AI（沙箱内自动执行），回复以气泡显示在这里
  const model = selectedChatModel();
  const waitingLabel = toolLabel(currentChatTool) + (model ? ' · ' + model : '');
  const container = $('chatMessages');
  if (container) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrapper ai';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    wrap.appendChild(bubble);
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
    pendingReplyEl = bubble;
    pendingReplyText = '';
    // 实时计时：长任务不再像卡死（生成完/有输出即停）
    startChatTimer(bubble, waitingLabel);
  }
  ws.send(JSON.stringify({ event: 'chat', data: { text, tool: currentChatTool, model } }));
};
let chatTimer = null, chatStartTs = 0, chatWaitingLabel = '', chatSteps = [];
function escHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
// 渲染等待气泡：流式文字 + 实时步骤(写文件/装依赖…) + 一直在跳的"生成中（已 Ns）"，直到最终回复才撤掉
function renderPending() {
  if (!pendingReplyEl) return;
  const s = Math.floor((Date.now() - chatStartTs) / 1000);
  const body = pendingReplyText ? renderReply(pendingReplyText) : '';
  const note = (s >= 20 ? '，大任务可能需 1–2 分钟' : '');
  const steps = chatSteps.length
    ? '<div style="opacity:.7;font-size:.84em;margin-top:.4em;line-height:1.5">' + chatSteps.slice(-4).map((x) => escHtml(x)).join('<br>') + '</div>'
    : '';
  const status = '<div style="opacity:.55;font-size:.86em;margin-top:' + (body || steps ? '.4em' : '0') + '">⏳ ' + escHtml(chatWaitingLabel) + ' 生成中…（已 ' + s + 's' + note + '）</div>';
  pendingReplyEl.innerHTML = body + steps + status;
}
function startChatTimer(bubble, label) {
  stopChatTimer();
  chatWaitingLabel = label || '';
  chatStartTs = Date.now();
  chatSteps = [];
  renderPending();
  chatTimer = setInterval(renderPending, 1000);
}
function stopChatTimer() { if (chatTimer) { clearInterval(chatTimer); chatTimer = null; } }

window.selectChatModel = function (tool) {
  const provider = normalizeChatProvider(tool);
  currentChatTool = provider;
  safeStorageSet('cab.chat.provider', provider);
  currentChatModel = safeStorageGet(chatModelStorageKey(provider)) || '';
  refreshChatModelControls();
  addChatMessage('ai', '已切换对话平台为 <b>' + toolLabel(provider) + '</b>。同平台模型可在顶部模型下拉里切换。');
};

function toolLabel(tool) {
  const cfg = CHAT_PROVIDERS[normalizeChatProvider(tool)];
  return cfg ? cfg.label : 'AI';
}
function isRoutedProvider(tool) {
  return ['deepseek', 'glm', 'kimi', 'qwen'].includes(normalizeChatProvider(tool));
}

// 把 AI 回复渲染成气泡内容（转义 + ``` 代码块 + 换行）
function renderReply(t) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = esc(t).replace(/```([\s\S]*?)```/g, (m, c) =>
    '<pre style="background:#2A2A27;color:#E9E6DD;padding:.5rem;border-radius:6px;overflow:auto;font-size:.78rem;white-space:pre-wrap;">' + c + '</pre>');
  return html.replace(/\n/g, '<br>');
}

window.handleInputKey = function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    window.sendChatInstruction();
  }
};

window.autoGrow = function (el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
};

// ===================================================================
// 服务端消息处理
// ===================================================================
function handleServerMessage(packet) {
  const { event, data } = packet;
  switch (event) {
    case 'output':
      if (term) term.write(data);
      handleLoginTerminalOutput(data);
      updateActiveStepLog(data);
      break;
    case 'ports':
      updatePorts(data || []);
      break;
    case 'preview-paths':
      renderPreviewPathOptions(data || []);
      break;
    case 'status':
      if (data.status === 'ready') addChatMessage('ai', '沙箱终端在线，就绪。');
      else if (data.status === 'offline') { setStatus(false); addChatMessage('ai', '沙箱已下线。'); }
      break;

    case 'room': // 房间成员变化
      renderRoomMembers(data.members || []);
      if (data.joined && data.joined !== currentUser) addChatMessage('ai', `👋 ${data.joined} 加入了房间`);
      if (data.left && data.left !== currentUser) addChatMessage('ai', `👋 ${data.left} 离开了房间`);
      break;
    case 'locks': // 锁变化
      renderLocks(data || {});
      break;
    case 'room-msg': { // 房间成员发言（人对人）
      const from = data.from || '?';
      addChatMessage(from === currentUser ? 'user' : 'ai', `<b>${from === 'system' ? '⚙️ 系统' : '👤 ' + escapeHtml(from)}：</b>${escapeHtml(data.text || '')}`);
      break;
    }

    case 'chat-delta': {
      const chunk = data && data.text ? String(data.text) : '';
      if (!chunk) break;
      pendingReplyText += chunk; // 不再停计时：让"生成中（已 Ns）"持续显示直到最终回复
      if (!pendingReplyEl) {
        const container = $('chatMessages');
        if (container) {
          const wrap = document.createElement('div');
          wrap.className = 'msg-wrapper ai';
          const bubble = document.createElement('div');
          bubble.className = 'msg-bubble';
          wrap.appendChild(bubble);
          container.appendChild(wrap);
          pendingReplyEl = bubble;
        }
      }
      if (!chatTimer && pendingReplyEl) { if (!chatStartTs) chatStartTs = Date.now(); chatTimer = setInterval(renderPending, 1000); }
      renderPending();
      const c = $('chatMessages'); if (c) c.scrollTop = c.scrollHeight;
      break;
    }

    case 'chat-step': { // 实时步骤：写文件/装依赖/起服务…
      const t = data && data.text ? String(data.text) : '';
      if (t) {
        if (chatSteps[chatSteps.length - 1] !== t) chatSteps.push(t); // 去重连续相同
        if (!chatStartTs) chatStartTs = Date.now();
        if (!chatTimer && pendingReplyEl) chatTimer = setInterval(renderPending, 1000);
        renderPending();
      }
      break;
    }

    case 'chat-reply': {
      stopChatTimer();
      chatSteps = [];
      const txt = (data && data.text) || pendingReplyText || '';
      if (pendingReplyEl) {
        pendingReplyEl.innerHTML = renderReply(txt);
        pendingReplyEl = null;
        pendingReplyText = '';
      }
      else addChatMessage('ai', renderReply(txt));
      const c = $('chatMessages'); if (c) c.scrollTop = c.scrollHeight;
      break;
    }

    case 'chat-cleared':
      break; // 新对话已在 agent 侧清空，前端已处理，无需动作

    case 'chat-history': {
      if (!historyLoaded && Array.isArray(data) && data.length) {
        addChatMessage('ai', '—— 以下是上次的对话记录 ——');
        data.forEach((m) => addChatMessage(m.role === 'user' ? 'user' : 'ai', renderReply(m.text || '')));
        const c = $('chatMessages'); if (c) c.scrollTop = c.scrollHeight;
      }
      historyLoaded = true;
      break;
    }

    case 'conversations': // 会话列表
      renderConversationList(data && data.list, data && data.current);
      break;
    case 'conversation': { // 切换/打开某个会话 → 重绘消息
      currentConvId = data && data.id;
      const sel = $('convSelect'); if (sel && currentConvId) sel.value = currentConvId;
      const c = $('chatMessages');
      if (c) {
        const msgs = (data && data.messages) || [];
        c.innerHTML = msgs.length
          ? msgs.map((m) => bubbleHtml(m.role === 'user' ? 'user' : 'ai', renderReply(m.text || ''))).join('')
          : '<div class="msg-wrapper ai"><div class="msg-bubble">🆕 新对话，直接发指令即可。</div></div>';
        c.scrollTop = c.scrollHeight;
      }
      historyLoaded = true; pendingReplyEl = null;
      break;
    }
  }
}
function bubbleHtml(sender, html) {
  return '<div class="msg-wrapper ' + (sender === 'user' ? 'user' : 'ai') + '"><div class="msg-bubble">' + html + '</div></div>';
}
function renderConversationList(list, current) {
  const sel = $('convSelect');
  if (!sel || !Array.isArray(list)) return;
  if (current) currentConvId = current;
  sel.innerHTML = list.map((c) => '<option value="' + c.id + '">' + escapeHtml(c.title) + '（' + c.count + '）</option>').join('');
  if (currentConvId) sel.value = currentConvId;
}

function updateActiveStepLog(text) {
  if (!activeStepBodyId) return;
  const body = $(activeStepBodyId);
  if (!body) return;
  const clean = String(text).replace(/[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  body.textContent += clean;
  body.scrollTop = body.scrollHeight;
}

const PREVIEW_PATH_OPTIONS = [
  { value: '/', label: '首页 /' },
  { value: '/index.html', label: 'index.html' },
  { value: '/about.html', label: 'about.html' },
  { value: '/login.html', label: 'login.html' },
  { value: '/dashboard.html', label: 'dashboard.html' }
];

function normalizePreviewPath(pathStr) {
  let p = String(pathStr || '/').trim() || '/';
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

function currentPreviewPath() {
  const sel = $('previewPathSelect');
  const custom = sel && sel.value === '__custom';
  if (sel && sel.value && !custom) return normalizePreviewPath(sel.value);
  return normalizePreviewPath(($('previewPath') || {}).value || '/');
}

function pathOptionLabel(pathStr) {
  const p = normalizePreviewPath(pathStr);
  if (p === '/') return '首页 /';
  return p;
}

function renderPreviewPathOptions(paths) {
  const sel = $('previewPathSelect');
  if (!sel) return;
  const current = currentPreviewPath();
  const merged = new Map();
  PREVIEW_PATH_OPTIONS.forEach((opt) => merged.set(normalizePreviewPath(opt.value), opt.label));
  (Array.isArray(paths) ? paths : []).forEach((item) => {
    const value = normalizePreviewPath(typeof item === 'string' ? item : item && item.value);
    if (value) merged.set(value, (item && item.label) || pathOptionLabel(value));
  });
  lastPreviewPaths = [...merged.keys()];
  sel.innerHTML = [...merged.entries()].map(([value, label]) =>
    `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`
  ).join('') + '<option value="__custom">自定义路径...</option>';
  if (merged.has(current)) sel.value = current;
  else sel.value = '__custom';
  const input = $('previewPath');
  if (input) {
    const custom = sel.value === '__custom';
    input.style.display = custom ? 'inline-block' : 'none';
    input.value = custom ? current : sel.value;
  }
}

window.onPreviewPathSelect = function () {
  const sel = $('previewPathSelect');
  const input = $('previewPath');
  const custom = sel && sel.value === '__custom';
  if (input) {
    input.style.display = custom ? 'inline-block' : 'none';
    if (!custom && sel) input.value = sel.value || '/';
    if (custom) setTimeout(() => input.focus(), 30);
  }
  if (!custom) window.loadPreview();
};

function previewBaseUrl(port, pathStr) {
  const p = normalizePreviewPath(pathStr);
  let out = `${window.location.protocol}//${window.location.host}/preview/${encodeURIComponent(currentProject)}/${port}${p}`;
  if (isCollab()) out += (out.includes('?') ? '&' : '?') + `owner=${encodeURIComponent(currentOwner)}`;
  return out;
}
// 按当前选中端口 + 路径加载/刷新预览
window.loadPreview = function () {
  const sel = $('previewPort');
  const port = (sel && sel.value) || currentPreviewPort;
  if (!port || !currentProject) return;
  currentPreviewPort = port;
  const pathStr = currentPreviewPath();
  const iframe = $('previewIframe'); const empty = $('previewEmpty');
  if (iframe) {
    const url = previewBaseUrl(port, pathStr);
    // 同 url 也强制刷新
    iframe.src = 'about:blank';
    setTimeout(() => { iframe.src = url; iframe.style.display = 'block'; }, 30);
    previewLoadedPort = port;
  }
  if (empty) empty.style.display = 'none';
};
window.openPreviewNewTab = function () {
  if (!currentPreviewPort) return alert('暂无可预览的服务');
  window.open(previewBaseUrl(currentPreviewPort, currentPreviewPath()), '_blank');
};
// 一键起常驻静态服务器（伺服 /workspace），适合"AI 只生成了静态 HTML、没起服务"的情况
window.startStaticServer = function () {
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert('沙箱未连线，请先【激活并连接沙箱】');
  ws.send(JSON.stringify({ event: 'start-static-server' }));
  switchTab('chat'); // 回到对话区看 agent 的启动反馈
  addChatMessage('ai', '🌐 正在启动静态服务器（伺服 /workspace，端口 8765）… 启动后切到【预览】选 8765 刷新即可。');
};

function updatePorts(ports) {
  ports = ports || [];
  const changed = JSON.stringify(ports) !== JSON.stringify(lastPorts);
  lastPorts = ports;
  const previewTab = $('tab-preview');
  const info = $('previewUrlInfo');
  const iframe = $('previewIframe');
  const empty = $('previewEmpty');
  const sel = $('previewPort');
  const pathSel = $('previewPathSelect');
  const pathInput = $('previewPath');

  if (ports.length > 0 && currentProject) {
    if (previewTab) previewTab.classList.add('has-web');
    if (sel) {
      sel.innerHTML = ports.map((p) => `<option value="${p}">:${p}</option>`).join('');
      if (!ports.map(String).includes(String(currentPreviewPort))) currentPreviewPort = ports[0];
      sel.value = currentPreviewPort;
      sel.style.display = ports.length > 1 ? 'inline-block' : 'none';
    }
    if (pathSel) {
      if (!pathSel.options.length) renderPreviewPathOptions(lastPreviewPaths);
      pathSel.style.display = 'inline-block';
      if (!pathSel.value) pathSel.value = '/';
    }
    if (pathInput) {
      const custom = pathSel && pathSel.value === '__custom';
      pathInput.style.display = custom ? 'inline-block' : 'none';
      if (!custom && pathSel) pathInput.value = pathSel.value || '/';
    }
    if (info) info.textContent = `:${currentPreviewPort}`;
    if (empty) empty.style.display = 'none';
    // 仅在「还没加载」或「当前端口已消失」时才(重)加载，避免每次轮询打断用户正在浏览的页面
    if (!previewLoadedPort || !ports.map(String).includes(String(previewLoadedPort))) {
      window.loadPreview();
    } else if (iframe) { iframe.style.display = 'block'; }
    if (changed) addChatMessage('ai', `✨ 检测到 Web 服务：端口 ${ports.join('、')}。已加载到【预览】${ports.length > 1 ? '（可在预览栏切换端口）' : ''}。`);
  } else {
    if (previewTab) previewTab.classList.remove('has-web');
    if (iframe) { iframe.style.display = 'none'; iframe.src = 'about:blank'; }
    if (empty) empty.style.display = 'flex';
    if (info) info.textContent = '无活跃预览';
    currentPreviewPort = null; previewLoadedPort = null;
    if (sel) { sel.style.display = 'none'; sel.innerHTML = ''; }
    if (pathSel) pathSel.style.display = 'none';
    if (pathInput) pathInput.style.display = 'none';
  }
}

// ===================================================================
// 聊天 UI
// ===================================================================
function addChatMessage(sender, text, hasStep = false) {
  const container = $('chatMessages');
  if (!container) return;
  const wrapper = document.createElement('div');
  wrapper.className = `msg-wrapper ${sender}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = text.replace(/\n/g, '<br>');
  wrapper.appendChild(bubble);

  if (hasStep) {
    const stepId = 'step-' + Date.now();
    activeStepBodyId = stepId;
    const stepCard = document.createElement('div');
    stepCard.className = 'step-card';
    stepCard.innerHTML =
      `<div class="step-header" onclick="window.toggleStepBody('${stepId}')">` +
      `<span><i class="fa-solid fa-code"></i> 沙箱实时输出</span>` +
      `<i class="fa-solid fa-chevron-down" id="arrow-${stepId}"></i></div>` +
      `<div class="step-body" id="${stepId}" style="display:block;"></div>`;
    bubble.appendChild(stepCard);
  }

  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
}

window.toggleStepBody = function (id) {
  const body = $(id); const arrow = $('arrow-' + id);
  if (!body) return;
  const open = body.style.display === 'block';
  body.style.display = open ? 'none' : 'block';
  if (arrow) arrow.className = open ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
};

// ===================================================================
// 终端
// ===================================================================
function initTerminal() {
  try {
    if (typeof Terminal === 'undefined') { setTimeout(initTerminal, 800); return; }
    if (term) return;
    term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Fira Code', monospace",
      fontSize: 13,
      theme: { background: '#2A2A27', foreground: '#E9E6DD', cursor: '#C96442' }
    });
    if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    }
    const container = $('terminalContainer');
    if (container) term.open(container);
    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'input', data }));
    });
    // 移动端关键：点/触终端区域时聚焦 xterm 隐藏输入框，弹出软键盘（否则手机上看得到却敲不了）
    if (container) {
      const focusTerm = () => { try { term.focus(); } catch (e) {} };
      container.addEventListener('click', focusTerm);
      container.addEventListener('touchend', focusTerm);
    }
    setTimeout(fitTerminal, 50);
  } catch (err) { console.error('[Terminal] init failed:', err.message); }
}

function fitTerminal() {
  const container = $('terminalContainer');
  if (!term || !container || !container.clientWidth) return;
  try {
    if (fitAddon) {
      fitAddon.fit(); // 按容器实际尺寸自适应（手机上更准）
    } else {
      term.resize(Math.max(2, Math.floor(container.clientWidth / 8)), Math.max(2, Math.floor(container.clientHeight / 16)));
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'resize', data: { cols: term.cols, rows: term.rows } }));
    }
  } catch (e) {}
}

window.clearTerminal = function () { if (term) term.clear(); };
// 新建一个独立会话（保留旧会话，可随时切回）
window.newChat = function () {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'new-conversation' }));
  else { const c = $('chatMessages'); if (c) c.innerHTML = '<div class="msg-wrapper ai"><div class="msg-bubble">请先连接沙箱再新建对话。</div></div>'; }
};
// 切换到已有会话
window.switchConversation = function (id) {
  if (id && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'switch-conversation', id }));
};
// 删除当前选中会话
window.deleteConversation = function () {
  const sel = $('convSelect');
  const id = sel && sel.value;
  if (!id) return;
  if (!confirm('删除这个对话？（不可恢复）')) return;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'delete-conversation', id }));
};
window.restartTerminal = function () {
  if (ws && ws.readyState === WebSocket.OPEN && confirm('重启终端 Shell？正在运行的进程会被结束。')) {
    ws.send(JSON.stringify({ event: 'restart-shell', data: {} }));
  }
};

// ===================================================================
// 数据：备份 / 同步 / 销毁
// ===================================================================
async function projectApi(path, okMsg, extra) {
  if (!currentProject) { alert('请先选择项目'); return false; }
  try {
    const res = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ projectId: currentProject }, extra || {}))
    });
    const data = await res.json();
    if (!res.ok) { addChatMessage('ai', `⚠️ ${data.error || '失败'}`); return false; }
    if (okMsg) addChatMessage('ai', okMsg);
    return true;
  } catch (err) { addChatMessage('ai', '⚠️ 请求失败：' + err.message); return false; }
}

window.saveBackup = function () {
  addChatMessage('ai', '正在打包冷备份…');
  projectApi('/api/backup/save', '💾 备份成功，已打包同步到云端存储。');
};

window.downloadBackup = function () {
  if (!currentProject) return alert('请先选择项目');
  addChatMessage('ai', '正在准备下载备份（浏览器会开始下载 .tar.gz）…');
  window.open('/api/backup/download?projectId=' + encodeURIComponent(currentProject), '_blank');
};

window.restoreBackup = async function () {
  addChatMessage('ai', '正在从云端备份还原…');
  const ok = await projectApi('/api/backup/restore', '🔄 已从云端还原。正在重启终端加载最新文件…');
  if (ok && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'restart-shell', data: {} }));
};

// ---- Git 助手（docx §4.10）：只读状态 + 生成可复制命令 ----
function buildGitCmds({ isRepo, remote }, remoteInput) {
  const url = (remoteInput || remote || '<你的仓库地址.git>').trim();
  const lines = [];
  if (!isRepo) {
    lines.push('git init', 'git add .', 'git commit -m "update"', 'git branch -M main',
      `git remote add origin ${url}`, 'git push -u origin main');
  } else {
    lines.push('git add .', 'git commit -m "update"');
    if (!remote) lines.push(`git remote add origin ${url}`, 'git push -u origin main');
    else lines.push('git push');
    lines.push('', '# 拉取最新：', 'git pull origin main');
  }
  return lines.join('\n');
}
window.refreshGit = async function () {
  if (!currentProject) return alert('请先选择项目');
  const statusEl = document.getElementById('gitStatus');
  const cmdsEl = document.getElementById('gitCmds');
  const remoteInput = document.getElementById('gitRemoteInput');
  statusEl.textContent = '读取中…';
  try {
    const res = await fetch('/api/git/status?projectId=' + encodeURIComponent(currentProject));
    const d = await res.json();
    if (!res.ok) { statusEl.textContent = '⚠️ ' + (d.error || '读取失败'); return; }
    if (!d.exists) { statusEl.textContent = '工作区尚未创建（先激活沙箱或新建文件）'; }
    else if (!d.isRepo) { statusEl.textContent = '尚未初始化 Git 仓库 —— 用下面的命令初始化并推送：'; }
    else {
      statusEl.textContent = `分支 ${d.branch}｜远程 ${d.remote || '未设置'}｜未提交改动 ${d.modifiedCount} 项`;
      if (d.remote && remoteInput && !remoteInput.value) remoteInput.value = d.remote;
    }
    cmdsEl.textContent = buildGitCmds(d, remoteInput ? remoteInput.value : '');
  } catch (err) { statusEl.textContent = '⚠️ 请求失败：' + err.message; }
};
window.copyGitCmds = async function () {
  const txt = document.getElementById('gitCmds').textContent || '';
  if (!txt.trim()) return alert('请先点「刷新」生成命令');
  try { await navigator.clipboard.writeText(txt); addChatMessage('ai', '📋 Git 命令已复制，到终端粘贴执行即可把代码推到你的仓库。'); }
  catch (e) { alert('复制失败，请手动选择文本复制'); }
};

// ---- GitHub OAuth 一键（连接 / 建仓 / 开 PR）----
window.refreshGithub = async function () {
  const st = document.getElementById('ghStatus');
  const connectBtn = document.getElementById('ghConnectBtn');
  const actions = document.getElementById('ghActions');
  if (!st) return;
  try {
    const r = await fetch('/api/github/status'); const d = await r.json();
    if (!d.configured) {
      st.textContent = '管理员未配置 GitHub OAuth（仍可用上面的手动 Git 命令）';
      if (connectBtn) connectBtn.style.display = 'none'; if (actions) actions.style.display = 'none';
      return;
    }
    if (d.github && d.github.connected) {
      st.textContent = `已连接：@${d.github.login}`;
      if (connectBtn) connectBtn.style.display = 'none'; if (actions) actions.style.display = 'block';
    } else {
      st.textContent = '未连接 —— 连接后可一键建仓 / 提交开 PR';
      if (connectBtn) connectBtn.style.display = 'block'; if (actions) actions.style.display = 'none';
    }
  } catch (e) {}
};
window.connectGithub = function () { window.location.href = '/api/github/oauth/start'; };
window.disconnectGithub = async function () {
  try { await fetch('/api/github/disconnect', { method: 'POST' }); addChatMessage('ai', '已断开 GitHub。'); refreshGithub(); } catch (e) {}
};
window.ghCreateRepo = async function () {
  const name = (document.getElementById('ghRepoName').value || '').trim();
  if (!name) return alert('请输入仓库名');
  const priv = document.getElementById('ghPrivate').checked;
  addChatMessage('ai', '正在创建 GitHub 仓库…');
  try {
    const r = await fetch('/api/github/create-repo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, private: priv }) });
    const d = await r.json();
    if (!r.ok) return addChatMessage('ai', '⚠️ ' + (d.error || '建仓失败'));
    document.getElementById('ghRepoFull').value = d.repo.fullName;
    addChatMessage('ai', `✅ 仓库已创建：${d.repo.htmlUrl}（已填入 PR 目标）`);
  } catch (e) { addChatMessage('ai', '⚠️ ' + e.message); }
};
window.ghOpenPR = async function () {
  if (!currentProject) return alert('请先选择项目');
  const repo = (document.getElementById('ghRepoFull').value || '').trim();
  if (!repo) return alert('请填写 owner/repo');
  const title = (document.getElementById('ghPrTitle').value || '').trim();
  addChatMessage('ai', '正在提交并开 PR…');
  try {
    const r = await fetch('/api/github/pr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: currentProject, repo, title }) });
    const d = await r.json();
    if (!r.ok) return addChatMessage('ai', '⚠️ ' + (d.error || '开 PR 失败'));
    addChatMessage('ai', `🚀 PR ${d.pr.created ? '已创建' : '已存在'}：${d.pr.htmlUrl}（分支 ${d.branch} → ${d.base}）`);
  } catch (e) { addChatMessage('ai', '⚠️ ' + e.message); }
};

// ---- 社区：发布/撤下本项目 ----
function refreshCommunityStatus() {
  const st = document.getElementById('communityStatus'); if (!st) return;
  const p = projects.find((x) => x.projectId === currentProject);
  const c = p && p.community;
  if (c && c.published) {
    st.textContent = `已发布：${c.level === 'fork' ? '可获取' : '仅观赏'}${c.title ? '｜' + c.title : ''}`;
    const t = document.getElementById('communityTitle'); if (t && !t.value) t.value = c.title || '';
    const d = document.getElementById('communityDesc'); if (d && !d.value) d.value = c.desc || '';
    const l = document.getElementById('communityLevel'); if (l) l.value = c.level || 'view';
  } else {
    st.textContent = '把这个项目公开给大家观赏；仅你本人可发布。';
  }
}
window.publishCommunity = async function () {
  if (!currentProject) return alert('请先选择项目');
  const title = (document.getElementById('communityTitle').value || '').trim();
  const desc = (document.getElementById('communityDesc').value || '').trim();
  const level = document.getElementById('communityLevel').value;
  addChatMessage('ai', '正在发布到社区…');
  try {
    const r = await fetch('/api/community/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: currentProject, level, title, desc }) });
    const d = await r.json();
    if (!r.ok) return addChatMessage('ai', '⚠️ ' + (d.error || '发布失败'));
    const p = projects.find((x) => x.projectId === currentProject); if (p) p.community = d.community;
    addChatMessage('ai', `🌃 已发布到社区（${level === 'fork' ? '可获取' : '仅观赏'}）。点【逛社区】查看。`);
    refreshCommunityStatus();
  } catch (e) { addChatMessage('ai', '⚠️ ' + e.message); }
};
window.unpublishCommunity = async function () {
  if (!currentProject) return;
  try {
    await fetch('/api/community/unpublish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: currentProject }) });
    const p = projects.find((x) => x.projectId === currentProject); if (p && p.community) p.community.published = false;
    addChatMessage('ai', '已从社区撤下。'); refreshCommunityStatus();
  } catch (e) {}
};

// ---- 协作房间：成员/锁/邀请 ----
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function roomTarget() { return { projectId: currentProject, owner: isCollab() ? currentOwner : undefined }; }
function refreshCollab() {
  const bar = document.getElementById('collabBar'); if (!bar) return;
  const p = projects.find((x) => x.projectId === currentProject);
  const hasCollab = isCollab() || (p && (p.collaborators || []).length);
  bar.style.display = hasCollab ? 'flex' : 'none';
  const cl = document.getElementById('collabList');
  if (cl) {
    if (isCollab()) cl.textContent = `你是 ${currentOwner} 房间的协作者`;
    else if (p) { const list = p.collaborators || []; cl.innerHTML = list.length ? ('协作者：' + list.map((u) => `${escapeHtml(u)} <a href="#" onclick="window.removeCollaborator('${escapeHtml(u)}');return false;">移除</a>`).join('、')) : '（暂无协作者）'; }
    else cl.textContent = '';
  }
}
function renderRoomMembers(members) { const el = document.getElementById('collabMembers'); if (el) el.textContent = '👥 ' + (members.length ? members.join('、') : '—'); }
function renderLocks(locks) {
  const el = document.getElementById('collabLocks'); if (!el) return;
  const ks = Object.keys(locks || {});
  el.textContent = ks.length ? ('🔒 ' + ks.map((f) => `${f}(@${locks[f].userId})`).join('  ')) : '🔓 无锁定';
}
window.inviteCollaborator = async function () {
  if (!currentProject || isCollab()) return alert('请在你自己的项目里邀请');
  const u = (document.getElementById('collabInvite').value || '').trim(); if (!u) return;
  try {
    const r = await fetch('/api/room/collaborators', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: currentProject, username: u }) });
    const d = await r.json();
    if (!r.ok) return addChatMessage('ai', '⚠️ ' + (d.error || '邀请失败'));
    const p = projects.find((x) => x.projectId === currentProject); if (p) p.collaborators = d.collaborators;
    document.getElementById('collabInvite').value = ''; addChatMessage('ai', '✅ 已邀请 ' + u + '（对方在项目下拉里会看到这个协作房间）'); refreshCollab();
  } catch (e) { addChatMessage('ai', '⚠️ ' + e.message); }
};
window.removeCollaborator = async function (u) {
  try {
    const r = await fetch('/api/room/collaborators', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: currentProject, username: u, remove: true }) });
    const d = await r.json(); const p = projects.find((x) => x.projectId === currentProject); if (p) p.collaborators = d.collaborators || []; refreshCollab();
  } catch (e) {}
};
async function lockApi(path, files, extra) {
  const t = roomTarget();
  const body = Object.assign({ projectId: t.projectId, files }, t.owner ? { owner: t.owner } : {}, extra || {});
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { r, d: await r.json() };
}
window.lockFilesNow = async function () {
  const v = (document.getElementById('lockFiles').value || '').trim(); if (!v) return;
  const files = v.split(',').map((s) => s.trim()).filter(Boolean);
  const { r, d } = await lockApi('/api/room/lock', files);
  if (!r.ok) return addChatMessage('ai', '⚠️ ' + (d.error || '锁定失败'));
  if (d.conflicts && d.conflicts.length) addChatMessage('ai', '⚠️ 已被他人锁定：' + d.conflicts.map((c) => `${c.file}(@${c.by})`).join('、'));
  if (d.granted && d.granted.length) addChatMessage('ai', '🔒 已锁定：' + d.granted.join('、') + '（其他人的 AI 会被告知不要改这些文件）');
  document.getElementById('lockFiles').value = '';
};
window.unlockFilesNow = async function () {
  const v = (document.getElementById('lockFiles').value || '').trim();
  const files = v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const { r, d } = await lockApi('/api/room/unlock', files, files.length ? {} : { all: true });
  if (!r.ok) return addChatMessage('ai', '⚠️ ' + (d.error || '解锁失败'));
  addChatMessage('ai', files.length ? ('已解锁：' + files.join('、')) : '已解锁我的全部文件');
  document.getElementById('lockFiles').value = '';
};

// ---- Hermes 云端秘书（docx §7）：默认关闭、最小授权 ----
const HERMES_CONNECTORS = ['telegram', 'feishu', 'slack', 'discord', 'email', 'qq', 'wechat'];
const HERMES_TOOLS = [['readFiles', '读文件'], ['writeFiles', '写文件'], ['runCommands', '执行命令'], ['sendMessages', '发消息']];
let hermesState = null;
function renderHermes(h) {
  hermesState = h;
  const st = document.getElementById('hermesStatus');
  if (st) st.textContent = `状态：${h.status}｜模型Key：${h.hasModelKey ? '已绑定' : '未绑定'}｜今日用量 ${h.usage.tokens}tok/${h.usage.messages}msg`;
  const pv = document.getElementById('hermesProvider'); if (pv && h.provider) pv.value = h.provider;
  const bt = document.getElementById('hermesBudgetTokens'); if (bt) bt.value = h.budgets.tokensPerDay;
  const bm = document.getElementById('hermesBudgetMsgs'); if (bm) bm.value = h.budgets.messagesPerDay;
  const cc = document.getElementById('hermesConnectors');
  if (cc) cc.innerHTML = HERMES_CONNECTORS.map((c) =>
    `<label><input type="checkbox" data-conn="${c}" ${h.connectors[c] ? 'checked' : ''}> ${c}</label>`).join('');
  const tt = document.getElementById('hermesTools');
  if (tt) tt.innerHTML = HERMES_TOOLS.map(([k, label]) =>
    `<label><input type="checkbox" data-tool="${k}" ${h.tools[k] ? 'checked' : ''}> ${label}</label>`).join('');
}
window.refreshHermes = async function () {
  try {
    const r = await fetch('/api/hermes'); const d = await r.json();
    if (!d.featureEnabled) { const st = document.getElementById('hermesStatus'); if (st) st.textContent = 'Hermes 功能未开放'; return; }
    renderHermes(d.hermes);
  } catch (e) {}
};
function collectHermesConfig() {
  const connectors = {}, tools = {};
  document.querySelectorAll('#hermesConnectors input[data-conn]').forEach((el) => connectors[el.dataset.conn] = el.checked);
  document.querySelectorAll('#hermesTools input[data-tool]').forEach((el) => tools[el.dataset.tool] = el.checked);
  return {
    provider: document.getElementById('hermesProvider').value || null,
    connectors, tools,
    budgets: {
      tokensPerDay: +document.getElementById('hermesBudgetTokens').value || 0,
      messagesPerDay: +document.getElementById('hermesBudgetMsgs').value || 0
    }
  };
}
window.saveHermes = async function () {
  try {
    await fetch('/api/hermes/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectHermesConfig()) });
    const key = document.getElementById('hermesKey').value.trim();
    if (key) {
      await fetch('/api/hermes/creds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creds: { HERMES_API_KEY: key } }) });
      document.getElementById('hermesKey').value = '';
    }
    addChatMessage('ai', '💾 Hermes 配置已保存。');
    refreshHermes();
  } catch (e) { addChatMessage('ai', '⚠️ 保存失败：' + e.message); }
};
window.startHermes = async function () {
  try {
    const r = await fetch('/api/hermes/start', { method: 'POST' }); const d = await r.json();
    if (!r.ok) return addChatMessage('ai', '⚠️ ' + (d.error || '启动失败'));
    addChatMessage('ai', '▶️ Hermes 已启动（隔离 sidecar，受限额约束）。'); renderHermes(d.hermes);
  } catch (e) { addChatMessage('ai', '⚠️ ' + e.message); }
};
window.stopHermes = async function () {
  try { const r = await fetch('/api/hermes/stop', { method: 'POST' }); const d = await r.json(); addChatMessage('ai', '⏹️ Hermes 已停止。'); if (d.hermes) renderHermes(d.hermes); }
  catch (e) { addChatMessage('ai', '⚠️ ' + e.message); }
};

window.destroyProject = async function () {
  if (!currentProject) return alert('请先选择项目');
  if (!confirm('❗将彻底擦除此项目的本地文件、云端备份并删除容器，且吊销该项目。不可逆，确定？')) return;
  addChatMessage('ai', '💥 正在物理销毁项目…');
  const ok = await projectApi('/api/project/destroy', '✨ 项目已彻底销毁，隐私数据与容器残留已清空。');
  if (ok) {
    if (term) { term.clear(); term.write('\r\n\x1b[31m[System] 项目已安全擦除，连接断开。\x1b[0m\r\n'); }
    // 从本地列表移除并刷新
    projects = projects.filter((p) => p.projectId !== currentProject);
    currentProject = null;
    refreshProjectSelect();
    wsIntentionalClose = true; wsHasConnected = false;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (ws) { try { ws.close(); } catch (e) {} }
  }
};

// ===================================================================
// 布局 / Tab
// ===================================================================
window.toggleSettings = function () {
  const m = $('settingsModal');
  if (!m) return;
  m.classList.toggle('show');
};
window.closeSettings = function () { const m = $('settingsModal'); if (m) m.classList.remove('show'); };
// 设置弹层：切换左侧栏分区
window.selectSettingsSection = function (key) {
  document.querySelectorAll('.settings-nav button').forEach((b) => b.classList.toggle('active', b.dataset.sec === key));
  document.querySelectorAll('.settings-section').forEach((s) => s.classList.toggle('active', s.dataset.sec === key));
};

window.switchTab = function (tab) {
  if (window.innerWidth > 768) return;
  if (tab !== 'chat') setKeyboardMode(false);
  currentTab = tab;
  ['chat', 'terminal', 'preview'].forEach((t) => {
    const panel = $(t + 'Panel'); const item = $('tab-' + t);
    if (panel) panel.classList.toggle('active', t === tab);
    if (item) item.classList.toggle('active', t === tab);
  });
  if (tab === 'terminal') {
    setTimeout(fitTerminal, 100);
    // 切到终端即聚焦（用户手势触发，移动端可弹出键盘）
    setTimeout(() => { try { if (term) term.focus(); } catch (e) {} }, 120);
  }
};

function setKeyboardMode(active) {
  document.body.classList.toggle('keyboard-open', !!active);
}

function initMobileInputGuards() {
  const input = $('chatInput');
  if (!input) return;
  input.addEventListener('focus', () => setKeyboardMode(true));
  input.addEventListener('blur', () => setTimeout(() => setKeyboardMode(false), 120));
}

window.handleResizeLayout = function () {
  const isMobile = window.innerWidth <= 768;
  ['chat', 'terminal', 'preview'].forEach((t) => {
    const panel = $(t + 'Panel');
    if (panel && !isMobile) panel.style.display = 'flex';
  });
  if (isMobile) window.switchTab(currentTab);
  fitTerminal();
};

// 动态加载 Xterm + fit 插件（避免被墙 CDN 阻塞核心控制流）
function loadScriptOnce(src, cb) {
  const s = document.createElement('script');
  s.src = src;
  s.onload = cb;
  s.onerror = () => setTimeout(() => loadScriptOnce(src, cb), 5000);
  document.head.appendChild(s);
}
// fit 插件是可选增强：加载成功就挂上自适应；失败/慢都不影响终端本身
function attachFitAddon() {
  try {
    if (term && !fitAddon && typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      fitTerminal();
    }
  } catch (e) {}
}
function loadXtermDynamically() {
  // 全部走本地 /vendor/（随 conduit 一起提供），不依赖外部 CDN（国内/VPN 下 CDN 时常不可达）
  if (!document.getElementById('xterm-css')) {
    const link = document.createElement('link');
    link.id = 'xterm-css'; link.rel = 'stylesheet';
    link.href = '/vendor/xterm.css';
    document.head.appendChild(link);
  }
  const start = () => {
    initTerminal(); // 终端先跑起来，绝不依赖 fit 插件
    if (typeof FitAddon === 'undefined') {
      const s = document.createElement('script');
      s.src = '/vendor/xterm-addon-fit.js';
      s.onload = attachFitAddon;
      document.head.appendChild(s);
    } else {
      attachFitAddon();
    }
  };
  if (typeof Terminal === 'undefined') {
    loadScriptOnce('/vendor/xterm.js', start);
  } else {
    start();
  }
}

// ===================================================================
// 启动
// ===================================================================
document.addEventListener('DOMContentLoaded', async () => {
  window.addEventListener('resize', window.handleResizeLayout);
  initMobileInputGuards();
  renderPreviewPathOptions([]);
  // 检查是否已登录
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) { await enterApp(); return; }
  } catch (e) {}
  showAuth();
});
