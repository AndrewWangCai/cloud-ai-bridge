const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const child_process = require('child_process');
const net = require('net');

let pty = null;
try {
  pty = require('node-pty');
} catch (err) {
  console.warn('[Agent Warning] node-pty not available (missing build tools). Falling back to child_process.spawn.', err.message);
}

// 从环境变量读取配置
const CONDUIT_URL = process.env.CONDUIT_URL || 'ws://localhost:8080';
const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || 'default-sandbox-token';
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';

console.log(`[Agent] Starting Sandbox Agent...`);
console.log(`[Agent] Conduit URL: ${CONDUIT_URL}`);
console.log(`[Agent] Workspace: ${WORKSPACE_DIR}`);

let ws = null;
let ptyProcess = null;
let rawProcess = null; // 用于原生进程回退
let portMonitorInterval = null;
let lastActivePorts = [];
let lastPreviewPaths = [];
let lastPreviewPathScanAt = 0;
let customEnv = {}; // 存放从 Conduit 传来的动态用户环境变量 (API Key 等)

// Shell 代次：每次 initPty 自增；旧 shell 的退出回调若代次不匹配则忽略，
// 从根本上消除"多个 initPty 互相 kill → 各自又调度重启"的指数级 fork 风暴。
let shellGen = 0;
let recentRestarts = [];

// 重启节流：10s 内重启超过 6 次判定为失控，暂停 30s 并提示，避免无限刷进程
function scheduleRestart(reason) {
  const now = Date.now();
  recentRestarts = recentRestarts.filter((t) => now - t < 10000);
  recentRestarts.push(now);
  if (recentRestarts.length > 6) {
    recentRestarts = [];
    console.warn('[Agent] Shell 反复退出，暂停自动重启 30s。');
    sendToConduit('output', '\r\n[Agent] Shell 反复退出，已暂停自动重启 30s（请检查运行环境）。\r\n');
    setTimeout(initPty, 30000);
    return;
  }
  setTimeout(initPty, 1000);
}

// 初始化默认 Shell 进程 (bash / powershell)
function initPty() {
  const myGen = ++shellGen; // 本次 shell 的代次

  if (ptyProcess) { try { ptyProcess.kill(); } catch (e) {} ptyProcess = null; }
  if (rawProcess) { try { rawProcess.kill(); } catch (e) {} rawProcess = null; }

  // 安全检查：工作区被物理删除（如触发销毁）时自动重建，防止子进程因找不到 CWD 瞬间挂掉死循环
  if (!fs.existsSync(WORKSPACE_DIR)) {
    try {
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      console.log(`[Agent] Re-created missing workspace directory: ${WORKSPACE_DIR}`);
    } catch (err) {
      console.error('[Agent Error] Failed to auto-create workspace dir:', err.message);
    }
  }

  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';

  if (pty) {
    // 1. node-pty 可用：伪终端（容器内 Linux 的正常路径）
    try {
      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: WORKSPACE_DIR,
        // LANG/LC_ALL 放最后以覆盖继承值：UTF-8 locale，否则中文输入会被 readline 逐字节误读（触发 Tab 补全/乱码）
        env: { ...process.env, ...customEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
      });
      console.log(`[Agent] Spawned interactive PTY shell: ${shell} (PID: ${ptyProcess.pid})`);

      ptyProcess.onData((data) => sendToConduit('output', data));
      ptyProcess.onExit(({ exitCode }) => {
        if (myGen !== shellGen) return; // 已被新的 initPty 取代，忽略
        console.log(`[Agent] PTY Shell exited with code ${exitCode}`);
        // Windows 无头环境下 ConPTY 可能 AttachConsole 失败（-1073741510）：弃用 node-pty 转原生
        if (process.platform === 'win32' && exitCode === -1073741510) {
          console.warn('[Agent] ConPTY AttachConsole failed. Falling back to raw child_process.');
          pty = null;
          scheduleRestart('conpty-fail');
          return;
        }
        sendToConduit('output', '\r\n[Agent] PTY Shell session closed. Restarting shell...\r\n');
        scheduleRestart('pty-exit');
      });
      return;
    } catch (ptyError) {
      console.error('[Agent] PTY spawn failed, falling back to raw spawn:', ptyError.message);
    }
  }

  // 2. 原生 child_process 回退（不支持 tty resize，但能基本读写）
  rawProcess = child_process.spawn(shell, [], {
    cwd: WORKSPACE_DIR,
    env: { ...process.env, ...customEnv, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    windowsHide: true
  });
  console.log(`[Agent] Spawned raw fallback shell: ${shell} (PID: ${rawProcess.pid})`);
  sendToConduit('output', '\r\n[Agent Warning] Running in raw shell fallback mode (no TTY resize).\r\n\r\n');

  rawProcess.stdout.on('data', (data) => sendToConduit('output', data.toString()));
  rawProcess.stderr.on('data', (data) => sendToConduit('output', data.toString()));
  rawProcess.on('error', (err) => console.error('[Agent] raw shell error:', err.message));
  rawProcess.on('exit', (code) => {
    if (myGen !== shellGen) return; // 被新的 initPty 取代（我们主动 kill 的），忽略，避免级联重启
    console.log(`[Agent] Raw shell exited with code ${code}, restarting...`);
    scheduleRestart('raw-exit');
  });
}

// 建立与 Conduit Server 的 WebSocket 连接
function connectToConduit() {
  const wsUrl = `${CONDUIT_URL}/agent?token=${SANDBOX_TOKEN}`;
  console.log(`[Agent] Connecting to Conduit Server: ${wsUrl}`);

  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[Agent] Connected to Conduit Server.');
    // 首次连上后发送当前状态，并上报自身容器 IP（供 Conduit 反代预览，替代不可靠的 remoteAddress）
    sendToConduit('status', { pid: ptyProcess ? ptyProcess.pid : null, status: 'ready', ip: getLocalIp() });
    // 发送当前端口状态
    scanPorts().then(ports => {
      lastActivePorts = ports;
      sendToConduit('ports', ports);
      sendPreviewPathsIfChanged(true);
    });
  });

  ws.on('message', (message) => {
    try {
      const packet = JSON.parse(message.toString());
      handleMessage(packet);
    } catch (err) {
      console.error('[Agent] Failed to parse websocket message:', err);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[Agent] Connection closed (${code}: ${reason.toString()}). Reconnecting in 3s...`);
    setTimeout(connectToConduit, 3000);
  });

  ws.on('error', (err) => {
    console.error('[Agent] WebSocket Error:', err.message);
  });
}

// 处理来自 Conduit (即手机端通过管道转发) 的指令
function handleMessage(packet) {
  const { event, data } = packet;
  
  switch (event) {
    case 'init-env': {
      // 仅在 Key 真正变化时才重启 Shell，避免误杀正在运行的 AI 会话
      let changed = false;
      for (const [k, v] of Object.entries(data || {})) {
        if (customEnv[k] !== v) { customEnv[k] = v; changed = true; }
      }
      // codex 0.140 不支持直连 DeepSeek：清掉会致 codex 报错的旧配置
      cleanupStaleCodexConfig();
      // 绑定 OpenAI 兼容模型 → 预热 ccr 服务（提前启动，首条对话不再等冷启动）
      for (const prov of Object.keys(CCR_PROVIDERS)) {
        if (envValue(CCR_PROVIDERS[prov].keyEnv)) { ensureCcrReady(prov).catch(() => {}); break; }
      }
      // 绑定了 GitHub token → 配置 git 免密（credential.helper store + user）
      if (customEnv.GITHUB_TOKEN) configureGit();
      // 填了项目说明 → 写 CLAUDE.md / AGENTS.md，让 AI 知道在做什么项目
      if (customEnv.PROJECT_BRIEF) writeProjectBrief();
      console.log('[Agent] init-env keys:', Object.keys(data || {}), '| restart:', changed);
      if (changed) initPty();
      break;
    }

    case 'input':
      // 往伪终端写入输入
      if (ptyProcess) {
        ptyProcess.write(data);
      } else if (rawProcess) {
        rawProcess.stdin.write(data);
      }
      break;

    case 'resize':
      // 调整伪终端大小
      if (ptyProcess && data && typeof data.cols === 'number' && typeof data.rows === 'number') {
        try {
          ptyProcess.resize(data.cols, data.rows);
        } catch (e) {
          console.error('[Agent] Failed to resize pty:', e.message);
        }
      }
      break;

    case 'chat':
      // 对话模式：headless 跑一次 AI 工具，回干净文本（沙箱内自动执行）
      runChat(data);
      break;

    case 'get-chat-history': {
      // 兼容旧前端：回当前对话的消息
      const c = ensureConversation();
      sendToConduit('chat-history', c.messages);
      break;
    }
    case 'list-conversations':
      sendConvList();
      break;
    case 'new-conversation':
    case 'new-chat': // 兼容旧「新对话」按钮
      newConversation(data && data.title);
      sendConvList();
      sendCurrentConv();
      console.log('[Agent] new conversation:', currentConvId);
      break;
    case 'switch-conversation':
      if (data && data.id && conversations[data.id]) {
        currentConvId = data.id; saveConversations();
      }
      sendConvList();
      sendCurrentConv();
      break;
    case 'rename-conversation':
      if (data && data.id && conversations[data.id] && data.title) {
        conversations[data.id].title = String(data.title).slice(0, 40); saveConversations();
      }
      sendConvList();
      break;
    case 'delete-conversation':
      if (data && data.id && conversations[data.id]) {
        delete conversations[data.id];
        if (currentConvId === data.id) currentConvId = null;
        ensureConversation(); saveConversations();
      }
      sendConvList();
      sendCurrentConv();
      break;

    case 'oauth-callback': {
      // 会员登录回调投递：手机浏览器跳到容器内 localhost:PORT/callback 收不到，
      // 由 agent 在容器内 curl 该回调，喂给正在等待的 CLI 本地登录服务。
      try {
        const u = new URL(String((data && data.url) || ''));
        const local = 'http://127.0.0.1:' + (u.port || '1455') + u.pathname + u.search;
        child_process.exec('curl -s -m 12 ' + JSON.stringify(local), { timeout: 14000 }, (e, o, se) => {
          sendToConduit('chat-reply', { role: 'system', text: e
            ? ('回调投递失败：' + String(se || e.message).slice(-300) + '（登录服务可能已超时，请重新点登录再试）')
            : '已把授权回调投递给容器内登录服务，请看【终端】是否提示登录成功，再回设置点“我已完成登录”。' });
        });
      } catch (err) {
        sendToConduit('chat-reply', { role: 'system', text: '回调链接解析失败，请粘贴完整的 callback 链接（含 ?code=...）。' });
      }
      break;
    }

    case 'restart-shell':
      console.log('[Agent] Force restarting shell...');
      initPty();
      break;

    case 'start-static-server': // 一键起常驻静态服务器：伺服 /workspace，跨对话不被回收
      startStaticServer();
      break;

    default:
      console.warn(`[Agent] Unknown event received: ${event}`);
  }
}

// 常驻静态服务器：把网页所在目录用 python http.server 伺服在固定端口（独立进程，不随对话结束被杀）
const STATIC_PREVIEW_PORT = Number(process.env.STATIC_PREVIEW_PORT || 8765);
let staticServerProc = null, staticServeDir = null;
function reportPortsNow() {
  scanPorts().then((ports) => { lastActivePorts = ports; sendToConduit('ports', ports); }).catch(() => {});
}
function relWs(p) { const r = path.relative(WORKSPACE_DIR, p); return r ? r : '/'; }
// 智能选目录：根目录有 html 就伺服根；否则优先 dist/build/public 等，再扫一级子目录找含 index.html / 任意 html 的
function pickServeDir() {
  const root = WORKSPACE_DIR;
  const hasHtml = (dir) => { try { return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.html')); } catch (e) { return false; } };
  const hasIndex = (dir) => { try { return fs.existsSync(path.join(dir, 'index.html')); } catch (e) { return false; } };
  if (hasHtml(root)) return root;
  for (const name of ['dist', 'build', 'public', 'out', 'site', 'www', 'docs']) {
    const d = path.join(root, name); if (fs.existsSync(d) && hasHtml(d)) return d;
  }
  try {
    const subs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => path.join(root, e.name));
    const withIndex = subs.find(hasIndex); if (withIndex) return withIndex;
    const withHtml = subs.find(hasHtml); if (withHtml) return withHtml;
  } catch (e) {}
  return root; // 兜底
}
function startStaticServer() {
  const serveDir = pickServeDir();
  if (staticServerProc && staticServerProc.exitCode === null) {
    if (staticServeDir === serveDir) { // 同目录 → 复用
      sendToConduit('chat-reply', { role: 'assistant', text: `🌐 静态服务器已在运行：端口 ${STATIC_PREVIEW_PORT}（伺服 ${relWs(serveDir)}）。切【预览】选 ${STATIC_PREVIEW_PORT} 刷新即可。` });
      reportPortsNow(); return;
    }
    try { process.kill(-staticServerProc.pid); } catch (e) { try { staticServerProc.kill(); } catch (e2) {} } // 目录变了(文件生成到新子目录) → 重启
    staticServerProc = null;
  }
  try {
    // 绑 0.0.0.0：Conduit 反代要连容器 eth0 IP，绑 127.0.0.1 会被拒
    staticServerProc = child_process.spawn('python3', ['-m', 'http.server', String(STATIC_PREVIEW_PORT), '--bind', '0.0.0.0', '--directory', serveDir], { cwd: serveDir, env: process.env, stdio: 'ignore', detached: true });
    staticServerProc.unref();
    staticServeDir = serveDir;
    staticServerProc.on('exit', () => { staticServerProc = null; });
    console.log('[Agent] static server started on', STATIC_PREVIEW_PORT, '->', serveDir);
    sendToConduit('chat-reply', { role: 'assistant', text: `🌐 已启动静态服务器，端口 ${STATIC_PREVIEW_PORT}，伺服目录 ${relWs(serveDir)}。切【预览】选 ${STATIC_PREVIEW_PORT} 刷新即可（有 index.html 直接出首页，否则路径填文件名如 about.html）。` });
    setTimeout(reportPortsNow, 800); // 让预览端口列表尽快出现 8765
  } catch (e) {
    staticServerProc = null;
    sendToConduit('chat-reply', { role: 'assistant', text: '启动静态服务器失败：' + e.message });
  }
}

// codex 0.140+ 删除了 chat-completions 自定义 provider 支持，DeepSeek 仅 chat 协议 → 直连不可行。
// 因此不再自动给 codex 写 DeepSeek 配置（会让 codex 加载失败）。这里清掉历史遗留的破配置，
// 让 codex 能正常用（OpenAI key / 登录）。DeepSeek 待后续加翻译代理(LiteLLM)再启用。
function cleanupStaleCodexConfig() {
  try {
    const cfgPath = path.join(os.homedir(), '.codex', 'config.toml');
    if (fs.existsSync(cfgPath)) {
      const content = fs.readFileSync(cfgPath, 'utf8');
      if (content.includes('Cloud AI Bridge') || content.includes('model_providers.deepseek')) {
        fs.rmSync(cfgPath, { force: true });
        console.log('[Agent] Removed stale DeepSeek codex config (codex 0.140 不支持直连 DeepSeek).');
      }
    }
  } catch (e) {
    console.error('[Agent] cleanupStaleCodexConfig failed:', e.message);
  }
}

// 经 claude-code-router(ccr) 路由 Claude Code 到 OpenAI 兼容后端的供应商表（可扩展）
const CCR_PROVIDERS = {
  deepseek: { keyEnv: 'DEEPSEEK_API_KEY', base: 'https://api.deepseek.com/chat/completions', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat', transformer: ['deepseek'] },
  glm: { keyEnv: 'GLM_API_KEY', base: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', models: ['glm-5.2', 'glm-4.6', 'glm-4.5-air', 'glm-4-flash'], defaultModel: 'glm-5.2', transformer: null },
  kimi: { keyEnv: 'MOONSHOT_API_KEY', base: 'https://api.moonshot.cn/v1/chat/completions', models: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'], defaultModel: 'kimi-k2-0905-preview', transformer: null },
  qwen: { keyEnv: 'DASHSCOPE_API_KEY', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen2.5-72b-instruct'], defaultModel: 'qwen-plus', transformer: null }
};
// 写 ccr 配置：让 `ccr code` 用指定供应商(DeepSeek/GLM…)跑 Claude Code
function writeCcrConfig(provider, preferredModel) {
  try {
    const prov = CCR_PROVIDERS[provider] || CCR_PROVIDERS.deepseek;
    const key = envValue(prov.keyEnv);
    if (!key) return;
    const selectedModel = sanitizeModelId(preferredModel) || prov.defaultModel;
    const models = Array.from(new Set([selectedModel, ...prov.models]));
    const dir = path.join(os.homedir(), '.claude-code-router');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = { name: provider, api_base_url: prov.base, api_key: key, models };
    if (prov.transformer) p.transformer = { use: prov.transformer };
    const cfg = { Providers: [p], Router: { default: `${provider},${selectedModel}` } };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    console.log(`[Agent] Wrote claude-code-router config for ${provider} -> ~/.claude-code-router/config.json`);
  } catch (e) {
    console.error('[Agent] writeCcrConfig failed:', e.message);
  }
}

// ccr 服务生命周期：预热 + 仅在 provider/model 变化时重启加载新配置（避免每次对话冷启动 & 切模型路由错）
let ccrConfigKey = null; // 当前已加载到运行中服务的 provider|model
const CCR_PORT = Number(process.env.CCR_PORT || 3456); // ccr 路由服务默认监听端口
function ccrCmd(sub) {
  return new Promise((resolve) => { try { child_process.exec('ccr ' + sub, { timeout: 25000 }, () => resolve()); } catch (e) { resolve(); } });
}
// 轮询 ccr 服务端口，等它真正监听上再放行 —— 避免首条 `ccr code` 抢跑触发 "service not running" 提示
function waitCcrPort(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const probe = () => {
      const sock = net.connect({ host: '127.0.0.1', port: CCR_PORT }, () => { sock.destroy(); resolve(true); });
      sock.setTimeout(1500);
      const retry = () => { try { sock.destroy(); } catch (e) {} if (Date.now() >= deadline) resolve(false); else setTimeout(probe, 250); };
      sock.on('error', retry);
      sock.on('timeout', retry);
    };
    probe();
  });
}
async function ensureCcrReady(provider, model) {
  writeCcrConfig(provider, model);
  const key = provider + '|' + (sanitizeModelId(model) || '');
  if (ccrConfigKey === key) return;               // 服务已在跑且配置正确 → 直接用，不冷启动
  await ccrCmd(ccrConfigKey ? 'restart' : 'start'); // 配置变了重启加载；首次启动预热
  const ready = await waitCcrPort(12000);         // 等端口真就绪，首条也不再抢跑
  ccrConfigKey = key;
  console.log('[Agent] ccr ready:', key, 'port=' + (ready ? 'up' : 'timeout'));
}

// 写项目说明到 /workspace/CLAUDE.md + AGENTS.md：Claude Code 自动读 CLAUDE.md，Codex 读 AGENTS.md
function writeProjectBrief() {
  try {
    const brief = customEnv.PROJECT_BRIEF;
    if (!brief) return;
    const START = '<!-- CAB-LOCKS-START -->';
    const END = '<!-- CAB-LOCKS-END -->';
    const keepLockBlock = (file) => {
      try {
        if (!fs.existsSync(file)) return '';
        const cur = fs.readFileSync(file, 'utf8');
        const s = cur.indexOf(START);
        const e = cur.indexOf(END);
        if (s >= 0 && e >= s) return '\n\n' + cur.slice(s, e + END.length).trim() + '\n';
      } catch (e) {}
      return '';
    };
    const body = '# 项目说明（由用户在 Cloud AI Bridge 填写）\n\n' + brief + '\n';
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      const fp = path.join(WORKSPACE_DIR, name);
      fs.writeFileSync(fp, body + keepLockBlock(fp));
    }
    console.log('[Agent] Wrote project brief -> /workspace/CLAUDE.md, AGENTS.md');
  } catch (e) {
    console.error('[Agent] writeProjectBrief failed:', e.message);
  }
}

// 绑定 GitHub：配置 git 免密（credential store + 身份），让 clone/push 不再输密码
function configureGit() {
  try {
    const home = os.homedir();
    const token = customEnv.GITHUB_TOKEN;
    if (!token) return;
    const user = customEnv.GIT_USERNAME || 'x-access-token';
    const email = customEnv.GIT_EMAIL || `${user}@users.noreply.github.com`;
    // 凭证（仅 github.com）；600 权限
    fs.writeFileSync(
      path.join(home, '.git-credentials'),
      `https://${encodeURIComponent(user)}:${encodeURIComponent(token)}@github.com\n`,
      { mode: 0o600 }
    );
    // 全局 git 配置
    const cfg = `[credential]\n\thelper = store\n[user]\n\tname = ${customEnv.GIT_USERNAME || user}\n\temail = ${email}\n[init]\n\tdefaultBranch = main\n`;
    fs.writeFileSync(path.join(home, '.gitconfig'), cfg);
    console.log('[Agent] Configured git credentials for GitHub (user:', customEnv.GIT_USERNAME || '(token-only)', ')');
  } catch (e) {
    console.error('[Agent] configureGit failed:', e.message);
  }
}

// 探测自身 IP：容器内取 eth0（宿主 Linux 可直连），本地 mock 则回报 127.0.0.1
function getLocalIp() {
  if (process.env.SANDBOX_IN_CONTAINER !== '1') return '127.0.0.1';
  const ifaces = os.networkInterfaces();
  const eth0 = (ifaces.eth0 || []).find((a) => a.family === 'IPv4' && !a.internal);
  if (eth0) return eth0.address;
  for (const name of Object.keys(ifaces)) {
    const a = (ifaces[name] || []).find((x) => x.family === 'IPv4' && !x.internal);
    if (a) return a.address;
  }
  return '127.0.0.1';
}

// 向 Conduit 发送消息的辅助函数
function sendToConduit(event, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event, data }));
  }
}

// ===== 对话模式：headless 跑一次 AI 工具，回干净文本 =====
let chatProc = null;
// 多会话：每个对话独立消息历史 + 独立 AI 会话 ID（用 claude/ccr --session-id 隔离上下文）
const crypto = require('crypto');
const CONV_FILE = path.join(os.homedir(), '.config', 'cab_conversations.json');
const CHAT_HISTORY_FILE_OLD = path.join(os.homedir(), '.config', 'cab_chat_history.json'); // 旧单一历史，迁移用
let conversations = {};     // id -> { id, title, sessionId, messages:[], createdAt, lastAt }
let currentConvId = null;

function genConvId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function genSessionId() {
  try { return crypto.randomUUID(); }
  catch (e) { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); }
}
function saveConversations() {
  try {
    const dir = path.dirname(CONV_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONV_FILE, JSON.stringify({ conversations, current: currentConvId }));
  } catch (e) { console.error('[Agent] saveConversations:', e.message); }
}
function newConversation(title) {
  const id = genConvId();
  conversations[id] = { id, title: title || ('对话 ' + (Object.keys(conversations).length + 1)), sessionId: genSessionId(), messages: [], createdAt: Date.now(), lastAt: Date.now() };
  currentConvId = id;
  saveConversations();
  return conversations[id];
}
function ensureConversation() {
  if (currentConvId && conversations[currentConvId]) return conversations[currentConvId];
  const ids = Object.keys(conversations);
  if (ids.length) { currentConvId = ids[ids.length - 1]; return conversations[currentConvId]; }
  return newConversation();
}
function loadConversations() {
  try {
    if (fs.existsSync(CONV_FILE)) {
      const o = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8')) || {};
      conversations = o.conversations || {};
      currentConvId = o.current || null;
    }
    // 迁移旧单一历史 → 默认对话
    if (!Object.keys(conversations).length && fs.existsSync(CHAT_HISTORY_FILE_OLD)) {
      const old = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE_OLD, 'utf8')) || [];
      const c = newConversation('历史对话');
      c.messages = Array.isArray(old) ? old : [];
      saveConversations();
    }
  } catch (e) { conversations = {}; currentConvId = null; }
  ensureConversation();
}
function pushChat(role, text) {
  const conv = ensureConversation();
  conv.messages.push({ role, text: String(text).slice(0, 8000), ts: Date.now() });
  if (conv.messages.length > 120) conv.messages = conv.messages.slice(-120);
  // 用首条用户消息自动命名
  if (role === 'user' && /^对话 \d+$/.test(conv.title) && conv.messages.filter((m) => m.role === 'user').length === 1) {
    const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 20);
    if (t) conv.title = t;
  }
  conv.lastAt = Date.now();
  saveConversations();
}
function conversationList() {
  return Object.values(conversations).sort((a, b) => b.lastAt - a.lastAt)
    .map((c) => ({ id: c.id, title: c.title, count: c.messages.length, lastAt: c.lastAt }));
}
function sendConvList() { sendToConduit('conversations', { list: conversationList(), current: currentConvId }); }
function sendCurrentConv() {
  const c = ensureConversation();
  sendToConduit('conversation', { id: c.id, title: c.title, messages: c.messages });
}

function envValue(key) {
  return customEnv[key] || process.env[key] || '';
}
function normalizeChatTool(tool) {
  return ['claude', 'codex', 'deepseek', 'glm', 'kimi', 'qwen'].includes(tool) ? tool : 'deepseek';
}
function sanitizeModelId(model) {
  const m = String(model || '').trim();
  return /^[A-Za-z0-9_.:/-]{1,100}$/.test(m) ? m : '';
}
function normalizeRequestedModel(tool, model) {
  return sanitizeModelId(model);
}
function dirHasAnyFile(dir, depth = 0) {
  try {
    if (!fs.existsSync(dir) || depth > 3) return false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.cache')) continue;
      const fp = path.join(dir, entry.name);
      if (entry.isFile() && fs.statSync(fp).size > 0) return true;
      if (entry.isDirectory() && dirHasAnyFile(fp, depth + 1)) return true;
    }
  } catch (e) {}
  return false;
}
function hasStoredToolLogin(tool) {
  if (tool === 'claude') return dirHasAnyFile(path.join(os.homedir(), '.claude'));
  if (tool === 'codex') return dirHasAnyFile(path.join(os.homedir(), '.codex'));
  return false;
}
function hasCredentialForChat(tool) {
  if (tool === 'deepseek') return !!envValue('DEEPSEEK_API_KEY');
  if (tool === 'glm') return !!envValue('GLM_API_KEY');
  if (tool === 'kimi') return !!envValue('MOONSHOT_API_KEY');
  if (tool === 'qwen') return !!envValue('DASHSCOPE_API_KEY');
  if (tool === 'codex') return !!envValue('OPENAI_API_KEY') || hasStoredToolLogin('codex');
  return !!envValue('ANTHROPIC_API_KEY') || hasStoredToolLogin('claude');
}
function missingCredentialReply(tool) {
  if (hasCredentialForChat(tool)) return '';
  if (tool === 'deepseek') return 'DeepSeek is not connected yet. Bind a DeepSeek API Key in Settings > Model / Account, then send again.';
  if (tool === 'glm') return 'GLM/智谱 is not connected yet. Bind a GLM API Key in Settings > Model / Account, then send again.';
  if (tool === 'kimi') return 'Kimi/Moonshot is not connected yet. Bind a Moonshot API Key in Settings > Model / Account, then send again.';
  if (tool === 'qwen') return 'Qwen/通义 is not connected yet. Bind a DashScope API Key in Settings > Model / Account, then send again.';
  if (tool === 'codex') return 'Codex is not connected yet. Bind an OpenAI API Key, or finish codex login in Terminal and mark Codex as completed in Settings.';
  return 'Claude is not connected yet. Bind an Anthropic API Key, or finish claude login in Terminal and mark Claude as completed in Settings.';
}
function friendlyRuntimeError(tool, stderrText) {
  const raw = String(stderrText || '').trim();
  if (!raw) return '';
  const accountPattern = new RegExp([
    'api\\s*error', 'apierror', 'status\\s*code:?\\s*400',
    'APIError', 'not\\s+logged\\s+in', 'no\\s+api\\s+key', 'invalid\\s+(api\\s+)?key',
    'authentication', 'unauthorized'
  ].join('|'), 'i');
  if (accountPattern.test(raw)) {
    return 'The account or API Key is not connected. ' + missingCredentialReply(tool) + ' If you just changed a key, reconnect the sandbox and try again.';
  }
  return '';
}

function isCcrServiceNotice(text) {
  return /service\s+not\s+running,?\s+starting\s+service/i.test(String(text || ''));
}

function cleanChatStdout(tool, text) {
  let out = String(text || '');
  if (CCR_PROVIDERS[tool]) {
    out = out.replace(/service\s+not\s+running,?\s+starting\s+service\.{0,3}/ig, '');
  }
  return out;
}

// stream-json 解析（纯函数抽到独立模块，便于单测）
const { streamDeltaText, streamFullText, streamStepLabels } = require('./stream-parse');

function runChat(data) {
  const text = (data && data.text) ? String(data.text) : '';
  const tool = normalizeChatTool((data && data.tool) || 'deepseek');
  const model = normalizeRequestedModel(tool, data && data.model);
  const operator = data && data.operatorUserId ? String(data.operatorUserId) : '';
  if (!text.trim()) return;
  if (chatProc) {
    sendToConduit('chat-reply', { role: 'system', text: 'The previous message is still running. Please wait for it to finish.' });
    return;
  }
  const credentialError = missingCredentialReply(tool);
  if (credentialError) {
    sendToConduit('chat-reply', { role: 'system', text: credentialError });
    return;
  }
  pushChat('user', text);
  const conv = ensureConversation();
  const lockPrompt = operator
    ? 'Current Cloud AI Bridge operator is @' + operator + '. Before editing files, read LOCKS.md. Only edit files locked by @' + operator + '; do not edit files locked by others. If the task needs those files, explain the conflict and stop.\n\nUser request:\n' + text
    : text;

  // opts: { session, stream }。stream=true 用 stream-json 边生成边显示；失败自动回退非流式/无会话
  const spawnOnce = (opts) => {
    const useSession = !!opts.session, useStream = !!opts.stream && tool !== 'codex';
    const sessionArgs = (useSession && tool !== 'codex' && conv.sessionId) ? ['--session-id', conv.sessionId] : [];
    const modelArgs = model ? ['--model', model] : [];
    const streamArgs = useStream ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'] : [];
    let cmd, args;
    if (tool === 'codex') {
      cmd = 'codex';
      args = ['exec', '--full-auto', ...modelArgs, lockPrompt];
    } else if (CCR_PROVIDERS[tool]) {
      cmd = 'ccr'; // 配置与服务由 ensureCcrReady 提前备好
      args = ['code', '-p', '--dangerously-skip-permissions', ...streamArgs, ...sessionArgs, lockPrompt];
    } else {
      cmd = 'claude';
      args = ['-p', '--dangerously-skip-permissions', ...streamArgs, ...sessionArgs, ...modelArgs, lockPrompt];
    }
    console.log('[Agent] chat(' + tool + (model ? '/' + model : '') + ', conv=' + conv.id + ', session=' + (sessionArgs.length ? 'on' : 'off') + ', stream=' + (useStream ? 'on' : 'off') + ')');

    let out = '', err = '', routeNoticeSent = false;
    let lineBuf = '', streamedText = '', fullText = '';
    try {
      chatProc = child_process.spawn(cmd, args, {
        cwd: WORKSPACE_DIR,
        env: { ...process.env, ...customEnv, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
      });
    } catch (e) {
      sendToConduit('chat-reply', { role: 'system', text: 'Failed to start: ' + e.message });
      chatProc = null; return;
    }
    const killer = setTimeout(() => { if (chatProc) { try { chatProc.kill('SIGKILL'); } catch (e) {} } }, 10 * 60 * 1000);
    chatProc.stdout.on('data', (d) => {
      const chunk = d.toString();
      out += chunk;
      if (!useStream) {
        // 非流式：原样转发（codex 等本身边吐边显示）
        let displayChunk = chunk;
        if (CCR_PROVIDERS[tool] && isCcrServiceNotice(chunk)) {
          displayChunk = cleanChatStdout(tool, chunk);
          if (!routeNoticeSent) { routeNoticeSent = true; sendToConduit('chat-delta', { role: 'assistant', text: '正在启动模型路由服务，首次可能需要几秒...\n' }); }
        }
        if (displayChunk) sendToConduit('chat-delta', { role: 'assistant', text: displayChunk });
        return;
      }
      // 流式：按行解析 stream-json，取文字增量边显示
      lineBuf += chunk;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx); lineBuf = lineBuf.slice(idx + 1);
        const s = line.trim(); if (!s) continue;
        if (CCR_PROVIDERS[tool] && isCcrServiceNotice(s)) { if (!routeNoticeSent) { routeNoticeSent = true; sendToConduit('chat-delta', { role: 'assistant', text: '正在启动模型路由服务，首次可能需要几秒...\n' }); } continue; }
        let obj; try { obj = JSON.parse(s); } catch (e) { continue; } // 非 JSON 行忽略
        const dt = streamDeltaText(obj);
        if (dt) { streamedText += dt; sendToConduit('chat-delta', { role: 'assistant', text: dt }); }
        for (const step of streamStepLabels(obj)) sendToConduit('chat-step', { text: step }); // 实时步骤：写文件/装依赖/起服务…
        const ft = streamFullText(obj);
        if (ft) fullText = ft; // 只在非空时更新，避免被纯工具调用的空 assistant 覆盖
      }
    });
    chatProc.stderr.on('data', (d) => { err += d.toString(); });
    chatProc.on('error', (e) => { clearTimeout(killer); chatProc = null; sendToConduit('chat-reply', { role: 'system', text: 'Execution error: ' + e.message }); });
    chatProc.on('close', (code) => {
      clearTimeout(killer);
      chatProc = null;
      // 流式失败/不被支持（退出码非0且没拿到任何文字）→ 回退非流式
      if (useStream && code !== 0 && !streamedText.trim() && !fullText.trim()) {
        return spawnOnce({ session: useSession, stream: false });
      }
      // 非流式时 --session-id 失败 → 回退无会话
      if (!useStream && useSession && tool !== 'codex' && code !== 0 && !out.trim()) {
        return spawnOnce({ session: false, stream: false });
      }
      let reply;
      if (useStream) {
        reply = (fullText.trim() || streamedText.trim()) || friendlyRuntimeError(tool, err) || (err.trim() ? ('Warning: ' + err.trim().slice(-1000)) : '(No output, exit code ' + code + ')');
      } else {
        const cleanOut = cleanChatStdout(tool, out).trim();
        const friendly = friendlyRuntimeError(tool, err);
        const routeOnly = routeNoticeSent && !cleanOut && !friendly;
        reply = cleanOut || friendly || (routeOnly ? '模型路由服务已启动，请再发送一次。' : (err.trim() ? ('Warning: ' + err.trim().slice(-1000)) : '(No output, exit code ' + code + ')'));
      }
      pushChat('assistant', reply);
      sendToConduit('chat-reply', { role: 'assistant', text: reply });
    });
  };

  const startOpts = { session: true, stream: tool !== 'codex' };
  // ccr 供应商：先确保服务已用正确配置就绪（预热则秒回），再发起；其余直接发起
  if (CCR_PROVIDERS[tool]) ensureCcrReady(tool, model).then(() => spawnOnce(startOpts)).catch(() => spawnOnce(startOpts));
  else spawnOnce(startOpts);
}


// 端口扫描器：定期读取 Linux /proc/net/tcp 探测本地监听的端口
function normalizeRoutePath(route) {
  let out = String(route || '/').trim();
  if (!out) out = '/';
  if (!out.startsWith('/')) out = '/' + out;
  return out.replace(/\/+/g, '/');
}

function routeFromPreviewFile(rel) {
  const clean = rel.replace(/\\/g, '/');
  const ext = path.extname(clean);
  const noExt = clean.slice(0, -ext.length);
  const parts = noExt.split('/');

  if (ext === '.html') {
    const htmlPath = clean.replace(/^(public|static)\//, '');
    const htmlNoExt = htmlPath.slice(0, -ext.length);
    const htmlParts = htmlNoExt.split('/');
    if (htmlParts[htmlParts.length - 1] === 'index') {
      const base = htmlParts.slice(0, -1).join('/');
      return normalizeRoutePath(base || '/');
    }
    return normalizeRoutePath(htmlPath);
  }

  const pagesIdx = parts.findIndex((p, i) => p === 'pages' && (i === 0 || parts[i - 1] === 'src'));
  if (pagesIdx >= 0) {
    const routeParts = parts.slice(pagesIdx + 1);
    if (!routeParts.length || routeParts.some((p) => p.startsWith('_') || p.startsWith('[') || p === 'api')) return null;
    if (routeParts[routeParts.length - 1] === 'index') routeParts.pop();
    return normalizeRoutePath(routeParts.join('/') || '/');
  }

  const appIdx = parts.findIndex((p, i) => p === 'app' && (i === 0 || parts[i - 1] === 'src'));
  if (appIdx >= 0 && parts[parts.length - 1] === 'page') {
    const routeParts = parts.slice(appIdx + 1, -1).filter((p) => !p.startsWith('('));
    if (routeParts.some((p) => p.startsWith('['))) return null;
    return normalizeRoutePath(routeParts.join('/') || '/');
  }

  return null;
}

function discoverPreviewPaths() {
  const routes = new Set(['/']);
  const skipDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo']);
  const routeExts = new Set(['.html', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte']);
  let visited = 0;

  function walk(dir, depth) {
    if (depth > 5 || visited > 900 || routes.size >= 40) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (visited > 900 || routes.size >= 40) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const ext = path.extname(entry.name);
      if (!routeExts.has(ext)) continue;
      const rel = path.relative(WORKSPACE_DIR, full).replace(/\\/g, '/');
      const route = routeFromPreviewFile(rel);
      if (route) routes.add(route);
    }
  }

  walk(WORKSPACE_DIR, 0);
  return [...routes].sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b))).slice(0, 40);
}

function sendPreviewPathsIfChanged(force = false) {
  const now = Date.now();
  if (!force && now - lastPreviewPathScanAt < 5000) return;
  lastPreviewPathScanAt = now;
  const paths = discoverPreviewPaths();
  const changed = JSON.stringify(paths) !== JSON.stringify(lastPreviewPaths);
  if (force || changed) {
    lastPreviewPaths = paths;
    sendToConduit('preview-paths', paths);
  }
}

async function scanPorts() {
  const ports = new Set();
  
  // 仅在非 Windows 环境（Linux 容器）下读取 /proc/net/tcp
  if (process.platform !== 'win32') {
    const paths = ['/proc/net/tcp', '/proc/net/tcp6'];
    for (const filePath of paths) {
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n');
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(/\s+/);
            // parts[1]: local_address (IP:PORT in hex)
            // parts[3]: connection state (0A is TCP_LISTEN)
            const state = parts[3];
            if (state === '0A') { 
              const localAddr = parts[1];
              const portHex = localAddr.split(':')[1];
              if (portHex) {
                const portDec = parseInt(portHex, 16);
                // 只上报"像 dev server"的端口：>1024、<32768（排除临时高位端口）、非 3456(ccr 路由)。
                // 8080 在容器内是空闲的（conduit 在宿主机），允许它，方便 `http.server 8080` 直接预览。
                if (portDec > 1024 && portDec < 32768 && portDec !== 3456) {
                  ports.add(portDec);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error(`[Agent] Error scanning ports in ${filePath}:`, err.message);
      }
    }
  } else {
    // Windows 模拟环境下，暂时不上报，或仅上报 Mock 数据
  }
  
  return Array.from(ports).sort((a, b) => a - b);
}

// 启动端口监听定时器
function startPortMonitor() {
  if (portMonitorInterval) clearInterval(portMonitorInterval);
  
  portMonitorInterval = setInterval(async () => {
    const currentPorts = await scanPorts();
    // 检查端口是否有变化
    const hasChanged = currentPorts.length !== lastActivePorts.length ||
      currentPorts.some((val, index) => val !== lastActivePorts[index]);
      
    if (hasChanged) {
      lastActivePorts = currentPorts;
      console.log(`[Agent] Active listening ports changed:`, currentPorts);
      sendToConduit('ports', currentPorts);
    }
    sendPreviewPathsIfChanged(false);
  }, 1500);
}

// 启动入口
function start() {
  loadConversations();
  initPty();
  connectToConduit();
  startPortMonitor();
}

// 优雅退出处理
process.on('SIGTERM', () => {
  console.log('[Agent] SIGTERM received. Cleaning up...');
  if (portMonitorInterval) clearInterval(portMonitorInterval);
  if (ptyProcess) ptyProcess.kill();
  if (ws) ws.close();
  process.exit(0);
});

start();
