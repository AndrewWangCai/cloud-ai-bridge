// 运营数据埋点（docx §10）：失败登录、预览点击、网络出站、平均使用时长、流失漏斗。
// 轻量持久化到 data/metrics.json（内存累加 + 周期落盘 + 退出 flush）。重启丢失少量未落盘增量可接受。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AI_SANDBOX_DATA_DIR
  ? path.resolve(process.env.AI_SANDBOX_DATA_DIR)
  : path.resolve(__dirname, '../data');
const FILE = path.join(DATA_DIR, 'metrics.json');
const FLUSH_MS = parseInt(process.env.METRICS_FLUSH_MS || '30000', 10);

// 漏斗阶段：用户从注册一路走到备份，看在哪一步流失
const FUNNEL_STAGES = ['register', 'createProject', 'activate', 'terminal', 'git', 'preview', 'backup'];

function blank() {
  return {
    counters: {
      failedLogins: 0,
      registerBlockedIp: 0,
      previewClicks: 0,
      egressKills: 0,     // 因出站流量超限被强停的容器次数（§5.2）
      oomKills: 0         // 容器 OOM 被杀次数（§10，判断 1C1G 是否够用）
    },
    funnel: FUNNEL_STAGES.reduce((o, s) => ((o[s] = 0), o), {}),
    session: { totalMs: 0, count: 0 }, // 平均使用时长（WS 连接时长）= totalMs/count
    container: { totalMs: 0, count: 0 } // 容器平均运行时长 = totalMs/count
  };
}

let state = blank();
let dirty = false;

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const o = JSON.parse(fs.readFileSync(FILE, 'utf8') || '{}');
      const base = blank();
      state = {
        counters: { ...base.counters, ...(o.counters || {}) },
        funnel: { ...base.funnel, ...(o.funnel || {}) },
        session: { ...base.session, ...(o.session || {}) },
        container: { ...base.container, ...(o.container || {}) }
      };
    }
  } catch (e) { console.error('[Metrics] load 失败:', e.message); }
}
function flush() {
  if (!dirty) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    dirty = false;
  } catch (e) { console.error('[Metrics] flush 失败:', e.message); }
}

function bump(key, n = 1) {
  if (!(key in state.counters)) state.counters[key] = 0;
  state.counters[key] += n; dirty = true;
}
function recordFunnel(stage) {
  if (!(stage in state.funnel)) return;
  state.funnel[stage] += 1; dirty = true;
}
function recordSessionDuration(ms) {
  if (!(ms > 0)) return;
  state.session.totalMs += ms; state.session.count += 1; dirty = true;
}
function recordContainerRuntime(ms) {
  if (!(ms > 0)) return;
  state.container.totalMs += ms; state.container.count += 1; dirty = true;
}

function snapshot() {
  const avgMin = state.session.count ? +(state.session.totalMs / state.session.count / 60000).toFixed(1) : 0;
  const avgContMin = state.container.count ? +(state.container.totalMs / state.container.count / 60000).toFixed(1) : 0;
  return {
    counters: { ...state.counters },
    funnel: FUNNEL_STAGES.map((s) => ({ stage: s, count: state.funnel[s] })),
    avgSessionMin: avgMin,
    sessionCount: state.session.count,
    avgContainerMin: avgContMin,
    containerRunCount: state.container.count
  };
}

load();
const timer = setInterval(flush, FLUSH_MS);
if (timer.unref) timer.unref();
process.on('exit', flush);

module.exports = { bump, recordFunnel, recordSessionDuration, recordContainerRuntime, snapshot, flush, FUNNEL_STAGES };
