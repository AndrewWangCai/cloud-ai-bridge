const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

let Docker = null;
try {
  Docker = require('dockerode');
} catch (e) {
  console.warn('[Orchestrator Warning] dockerode not found, running in MOCK mode.');
}

const IMAGE_TAG = 'sandbox-image:latest';
const SANDBOX_DIR = path.resolve(__dirname, '../../sandbox');
const NETWORK = process.env.SANDBOX_NETWORK || 'ai-sandbox-net';
const GB = 1024 * 1024 * 1024;

// 资源档位：免费档可经 env 调整（宿主内存够就调高，避免 AI 生成时容器内 OOM 杀掉 agent → 掉线）
const FREE_MEM_GB = Number(process.env.FREE_MEM_GB || 2); // 默认 2G（1G 无 swap 跑 ccr+claude-code 易 OOM）
const FREE_CPUS = Number(process.env.FREE_CPUS || 1);
const TIERS = {
  free: { memory: Math.round(FREE_MEM_GB * GB), nanoCpus: Math.round(FREE_CPUS * 1e9), pids: 256 },
  plus: { memory: 4 * GB, nanoCpus: 2 * 1e9, pids: 1024 }
};
function tierLimits(tier) { return TIERS[tier] || TIERS.free; }

// 解析 docker 的人类可读体积 "3.4MB" / "1.2kB" / "512B" / "2GiB" => 字节
function parseSize(s) {
  const m = String(s || '').trim().match(/^([\d.]+)\s*([kKmMgGtT]?i?)B?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]); const u = m[2].toLowerCase().replace('i', '');
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[u] || 1;
  return Math.round(n * mult);
}

class DockerOrchestrator {
  constructor() {
    this.mode = 'MOCK';
    this.docker = null;
    this.imageReady = false;

    if (Docker) {
      const socketPath = process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
      try {
        this.docker = new Docker({ socketPath });
      } catch (err) {
        console.warn('[Orchestrator] Docker init error, MOCK mode:', err.message);
        this.docker = null;
      }
    }
  }

  // 每次按需探测 Docker 是否可用，避免构造期 ping 的竞态（Docker 可能后启动）
  async detectMode() {
    if (!this.docker) return 'MOCK';
    try {
      await this.docker.ping();
      return 'DOCKER';
    } catch (e) {
      return 'MOCK';
    }
  }

  // 确保 sandbox 镜像存在，缺失则自动 docker build
  async ensureImage() {
    if (this.mode !== 'DOCKER' || this.imageReady) return;
    const images = await this.docker.listImages({ filters: JSON.stringify({ reference: [IMAGE_TAG] }) });
    if (images && images.length) {
      this.imageReady = true;
      return;
    }
    await this.buildImage();
    this.imageReady = true;
  }

  buildImage() {
    return new Promise((resolve, reject) => {
      console.log(`[Orchestrator] Building image ${IMAGE_TAG} from ${SANDBOX_DIR} (首次构建较慢，请耐心等待)...`);
      const p = spawn('docker', ['build', '-t', IMAGE_TAG, SANDBOX_DIR], { stdio: 'inherit' });
      p.on('error', (err) => reject(new Error('无法执行 docker build，请确认 Docker 已安装并在 PATH 中: ' + err.message)));
      p.on('close', (code) => {
        if (code === 0) { console.log('[Orchestrator] Image build complete.'); resolve(); }
        else reject(new Error(`docker build 失败 (exit ${code})。请手动运行: docker build -t ${IMAGE_TAG} ${SANDBOX_DIR}`));
      });
    });
  }

  // 确保专用 Docker 网络存在（不存在则创建）
  async ensureNetwork() {
    if (this.mode !== 'DOCKER') return;
    try {
      const nets = await this.docker.listNetworks({ filters: JSON.stringify({ name: [NETWORK] }) });
      if (nets && nets.find((n) => n.Name === NETWORK)) return;
      console.log(`[Orchestrator] Creating docker network: ${NETWORK}`);
      await this.docker.createNetwork({ Name: NETWORK, Driver: 'bridge' });
    } catch (err) {
      console.warn('[Orchestrator] ensureNetwork failed (将回退到默认网络):', err.message);
    }
  }

  buildEnv(token, creds) {
    const env = [
      'CONDUIT_URL=ws://host.docker.internal:8080',
      `SANDBOX_TOKEN=${token}`,
      'WORKSPACE_DIR=/workspace'
    ];
    if (creds && creds.ANTHROPIC_API_KEY) env.push(`ANTHROPIC_API_KEY=${creds.ANTHROPIC_API_KEY}`);
    if (creds && creds.OPENAI_API_KEY) env.push(`OPENAI_API_KEY=${creds.OPENAI_API_KEY}`);
    if (creds && creds.DEEPSEEK_API_KEY) env.push(`DEEPSEEK_API_KEY=${creds.DEEPSEEK_API_KEY}`);
    if (creds && creds.GITHUB_TOKEN) env.push(`GITHUB_TOKEN=${creds.GITHUB_TOKEN}`);
    if (creds && creds.GIT_USERNAME) env.push(`GIT_USERNAME=${creds.GIT_USERNAME}`);
    if (creds && creds.GIT_EMAIL) env.push(`GIT_EMAIL=${creds.GIT_EMAIL}`);
    return env;
  }

  async startSandbox({ userId, projectId, token, creds, resourceTier, projectDir, userConfigDir, claudeDir, codexDir }) {
    this.mode = await this.detectMode();
    const containerName = `sandbox_${userId}_${projectId}`;
    const limits = tierLimits(resourceTier);

    if (this.mode === 'MOCK') {
      console.log(`[Orchestrator MOCK] 本地进程沙箱（start-dev.js 拉起），workspace=${projectDir}`);
      return { status: 'mock_running', containerId: 'mock-' + containerName };
    }

    await this.ensureImage();
    await this.ensureNetwork();

    try {
      const containerInfo = await this.getContainerByName(containerName);
      if (containerInfo) {
        const container = this.docker.getContainer(containerInfo.Id);
        // 检查旧容器里烧录的 SANDBOX_TOKEN 是否仍等于当前 channelToken。
        // 账号/项目重建后 token 会变，旧容器拿作废 token 连 conduit 会被一直拒（socket hang up）。
        let envToken = null;
        try {
          const ins = await container.inspect();
          const e = (ins.Config.Env || []).find((x) => x.startsWith('SANDBOX_TOKEN='));
          envToken = e ? e.slice('SANDBOX_TOKEN='.length) : null;
        } catch (e) {}
        if (envToken === token) {
          if (containerInfo.State === 'running') {
            console.log(`[Orchestrator] ${containerName} already running.`);
            return { status: 'running', containerId: containerInfo.Id };
          }
          console.log(`[Orchestrator] ${containerName} exists (${containerInfo.State}), starting...`);
          await container.start();
          return { status: 'started', containerId: containerInfo.Id };
        }
        // token 变了 → 自愈：强制删除旧容器，下面重建（workspace 是 bind 挂载，代码不丢）
        console.log(`[Orchestrator] ${containerName} token mismatch -> removing & recreating`);
        await container.remove({ force: true });
      }

      // 全新创建
      console.log(`[Orchestrator] Creating sandbox for user=${userId} project=${projectId}`);
      [projectDir, userConfigDir, claudeDir, codexDir].forEach((d) => {
        if (d && !fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        // 让容器内 node 用户(uid/gid 1000) 能写入 bind 挂载目录。
        // conduit 以 root 运行(systemd)时生效；非 root / Windows 下忽略。
        try { if (d) fs.chownSync(d, 1000, 1000); } catch (e) {}
      });

      const fmt = (p) => path.resolve(p).replace(/\\/g, '/');
      const container = await this.docker.createContainer({
        Image: IMAGE_TAG,
        name: containerName,
        Env: this.buildEnv(token, creds),
        HostConfig: {
          Binds: [
            `${fmt(projectDir)}:/workspace`,
            `${fmt(userConfigDir)}:/home/node/.config`,
            `${fmt(claudeDir)}:/home/node/.claude`,    // claude login OAuth 持久化
            `${fmt(codexDir)}:/home/node/.codex`        // codex login OAuth 持久化
          ],
          ExtraHosts: ['host.docker.internal:host-gateway'],
          NetworkMode: NETWORK,                     // 专用网络隔离
          Memory: limits.memory,                    // 免费档 1GB
          MemorySwap: limits.memory,                // 等于 Memory => 禁用 swap
          NanoCpus: limits.nanoCpus,                // 免费档 1 CPU
          PidsLimit: limits.pids,                   // 限制进程数，防 fork 炸弹
          CapDrop: ['ALL'],                         // 丢弃所有 Linux capability
          SecurityOpt: ['no-new-privileges:true'],  // 禁止提权
          RestartPolicy: { Name: 'no' },
          LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } } // 限制容器日志，防爆盘 (docx §5.2)
          // 注意：绝不设置 Privileged / NetworkMode:host / 挂载 docker.sock
        }
      });

      console.log(`[Orchestrator] Starting container: ${containerName}`);
      await container.start();
      const inspectData = await container.inspect();
      return { status: 'created_and_started', containerId: inspectData.Id };
    } catch (err) {
      console.error('[Orchestrator Error] container lifecycle:', err.message);
      throw err;
    }
  }

  async stopSandbox({ userId, projectId }) {
    this.mode = await this.detectMode();
    const containerName = `sandbox_${userId}_${projectId}`;
    if (this.mode === 'MOCK') return { status: 'mock_stopped' };
    try {
      const info = await this.getContainerByName(containerName);
      if (info && info.State === 'running') {
        await this.docker.getContainer(info.Id).stop();
        return { status: 'stopped' };
      }
      return { status: 'not_running' };
    } catch (err) {
      console.error('[Orchestrator Error] stop:', err.message);
      throw err;
    }
  }

  async removeSandbox({ userId, projectId }) {
    this.mode = await this.detectMode();
    const containerName = `sandbox_${userId}_${projectId}`;
    if (this.mode === 'MOCK') return { status: 'mock_removed' };
    try {
      const info = await this.getContainerByName(containerName);
      if (info) {
        await this.docker.getContainer(info.Id).remove({ force: true });
        return { status: 'removed' };
      }
      return { status: 'not_found' };
    } catch (err) {
      console.error('[Orchestrator Error] remove:', err.message);
      throw err;
    }
  }

  async getContainerByName(name) {
    const containers = await this.docker.listContainers({ all: true });
    return containers.find((c) => c.Names.includes(`/${name}`));
  }

  // ===== Hermes 云端秘书：每用户独立加固 sidecar，默认关闭、严格隔离（docx §7）=====
  buildHermesEnv(hermes) {
    const c = hermes.creds || {};
    const env = ['HERMES_MODE=1', 'WORKSPACE_DIR=/hermes'];
    if (hermes.provider) env.push(`HERMES_PROVIDER=${hermes.provider}`);
    if (c.HERMES_API_KEY) env.push(`HERMES_API_KEY=${c.HERMES_API_KEY}`);
    if (c.HERMES_BASE_URL) env.push(`HERMES_BASE_URL=${c.HERMES_BASE_URL}`);
    if (c.HERMES_MODEL) env.push(`HERMES_MODEL=${c.HERMES_MODEL}`);
    // 仅注入「已开启」连接器的凭证（最小授权）
    const map = { telegram: ['TELEGRAM_BOT_TOKEN'], feishu: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'], slack: ['SLACK_BOT_TOKEN'], discord: ['DISCORD_BOT_TOKEN'], email: ['EMAIL_SMTP'], qq: ['QQ_BOT_APPID', 'QQ_BOT_TOKEN', 'QQ_BOT_SECRET'], wechat: ['WECHAT_APPID', 'WECHAT_TOKEN', 'WECHAT_SECRET'] };
    for (const [conn, keys] of Object.entries(map)) {
      if (hermes.connectors && hermes.connectors[conn]) for (const k of keys) if (c[k]) env.push(`${k}=${c[k]}`);
    }
    // 工具权限（默认只读）+ 预算，透传给运行时自我约束
    const t = hermes.tools || {};
    env.push(`HERMES_TOOL_READ=${t.readFiles ? 1 : 0}`, `HERMES_TOOL_WRITE=${t.writeFiles ? 1 : 0}`,
      `HERMES_TOOL_EXEC=${t.runCommands ? 1 : 0}`, `HERMES_TOOL_SEND=${t.sendMessages ? 1 : 0}`);
    const b = hermes.budgets || {};
    env.push(`HERMES_BUDGET_TOKENS=${b.tokensPerDay || 0}`, `HERMES_BUDGET_MESSAGES=${b.messagesPerDay || 0}`, `HERMES_BUDGET_TASKS=${b.tasksPerDay || 0}`);
    return env;
  }

  async startHermes({ userId, hermes, hermesDir }) {
    this.mode = await this.detectMode();
    const containerName = `hermes_${userId}`;
    const limits = tierLimits('free'); // Hermes 也走免费档限额（绝不放大权限）
    if (this.mode === 'MOCK') {
      console.log(`[Orchestrator MOCK] Hermes 占位运行时 user=${userId}（真实 agent 后续接入）`);
      return { status: 'mock_running', containerId: 'mock-' + containerName };
    }
    await this.ensureImage();
    await this.ensureNetwork();
    // 已存在则重建（确保拿到最新配置/凭证）
    const existing = await this.getContainerByName(containerName);
    if (existing) { try { await this.docker.getContainer(existing.Id).remove({ force: true }); } catch (e) {} }
    if (hermesDir && !fs.existsSync(hermesDir)) { fs.mkdirSync(hermesDir, { recursive: true }); try { fs.chownSync(hermesDir, 1000, 1000); } catch (e) {} }
    const fmt = (p) => path.resolve(p).replace(/\\/g, '/');
    const container = await this.docker.createContainer({
      Image: IMAGE_TAG,
      name: containerName,
      Env: this.buildHermesEnv(hermes),
      // 镜像默认 ENTRYPOINT 是沙箱 agent；Hermes 不跑 agent，需覆盖 Entrypoint。
      // 占位工作负载：保持运行时槽位存活，真实 Hermes agent 在此处接入（读取注入的权限/预算/连接器 env）。
      Entrypoint: ['sh', '-c', 'echo "[hermes] runtime slot active (placeholder; drop real agent here)"; exec sleep infinity'],
      Cmd: [],
      HostConfig: {
        // Hermes memory 与项目 workspace 分开存储（docx §7），仅挂自己的 hermes 目录
        Binds: hermesDir ? [`${fmt(hermesDir)}:/hermes`] : [],
        NetworkMode: NETWORK,
        Memory: limits.memory, MemorySwap: limits.memory, NanoCpus: limits.nanoCpus, PidsLimit: limits.pids,
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } }
        // 同沙箱：绝不 privileged / host net / docker.sock；出站/磁盘守卫同样覆盖 hermes_ 容器
      }
    });
    await container.start();
    const ins = await container.inspect();
    return { status: 'created_and_started', containerId: ins.Id };
  }

  async stopHermes({ userId }) {
    this.mode = await this.detectMode();
    const containerName = `hermes_${userId}`;
    if (this.mode === 'MOCK') return { status: 'mock_stopped' };
    try {
      const info = await this.getContainerByName(containerName);
      if (info) { await this.docker.getContainer(info.Id).remove({ force: true }); return { status: 'stopped' }; }
      return { status: 'not_found' };
    } catch (err) { console.error('[Orchestrator Error] stopHermes:', err.message); throw err; }
  }

  // 取所有 sandbox 容器的实时 CPU/内存/网络IO + 运行时长（docker stats + docker ps 快照）
  async getStats() {
    if (this.mode !== 'DOCKER') return [];
    const sh = (cmd) => new Promise((resolve) =>
      exec(cmd, { timeout: 9000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim())));
    const [statsOut, psOut] = await Promise.all([
      sh('docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}|{{.NetIO}}"'),
      sh('docker ps --format "{{.Names}}|{{.Status}}"')
    ]);
    // name => "Up 3 hours" 运行时长
    const mine = (l) => /sandbox_|hermes_/.test(l);
    const uptime = {};
    psOut.split('\n').filter(mine).forEach((l) => {
      const [name, status] = l.split('|'); if (name) uptime[name.trim()] = (status || '').trim();
    });
    return statsOut.split('\n').filter(mine).map((l) => {
      const [name, cpu, mem, memPct, pids, netIO] = l.split('|');
      // NetIO 形如 "1.2kB / 3.4MB" = 入站 / 出站
      const txStr = (netIO || '').split('/')[1] || '';
      return { name, cpu, mem, memPct, pids, netIO: (netIO || '').trim(), txBytes: parseSize(txStr), uptime: uptime[name] || '' };
    });
  }

  // 扫描已退出的 sandbox/hermes 容器中被 OOM 杀掉的（§10 判断 1C1G 是否够用）
  async getOomKilled() {
    if (this.mode !== 'DOCKER') return [];
    const sh = (cmd) => new Promise((resolve) =>
      exec(cmd, { timeout: 9000 }, (e, o) => resolve(e ? '' : String(o).trim())));
    const names = (await sh('docker ps -a --filter status=exited --format "{{.Names}}"'))
      .split('\n').map((n) => n.trim()).filter((n) => /sandbox_|hermes_/.test(n));
    const out = [];
    for (const name of names) {
      const ins = await sh(`docker inspect ${name} --format "{{.State.OOMKilled}}|{{.State.FinishedAt}}|{{.Id}}"`);
      const [oom, fin, id] = ins.split('|');
      if ((oom || '').trim() === 'true') out.push({ name, finishedAt: (fin || '').trim(), id: (id || '').trim() });
    }
    return out;
  }

  // 取容器最近日志（激活诊断用，脱敏由调用方处理）
  async getLogs({ userId, projectId, tail = 20 }) {
    if (this.mode !== 'DOCKER' || !this.docker) return '';
    try {
      const info = await this.getContainerByName(`sandbox_${userId}_${projectId}`);
      if (!info) return '(no container)';
      const buf = await this.docker.getContainer(info.Id).logs({ stdout: true, stderr: true, tail });
      // dockerode 返回带 8 字节流头的 Buffer，简单去掉不可见头
      return buf.toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(-1500);
    } catch (e) {
      return '(logs error: ' + e.message + ')';
    }
  }
}

module.exports = new DockerOrchestrator();
