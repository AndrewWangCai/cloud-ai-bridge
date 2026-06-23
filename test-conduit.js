// 端到端自检（配合 `node start-dev.js`）。覆盖：鉴权、逐字遥控、路径穿越、备份、
// 预览 token、管理员后台、邮箱激活注册、每日配额、封禁。
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const HOST = 'localhost';
const PORT = process.env.PORT || 8080;
const DEV_USER = 'dev';
const DEV_PASS = 'devpass';
const DEMO = 'demo';

function request(method, path, body, jar) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 };
    if (jar && jar.cookie) headers.Cookie = jar.cookie;
    if (jar && jar.ip) headers['X-Forwarded-For'] = jar.ip;
    const req = http.request({ hostname: HOST, port: PORT, path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc && sc.length && jar) jar.cookie = sc[0].split(';')[0];
        let parsed = buf; try { parsed = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function getHtml(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: HOST, port: PORT, path }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function runTests() {
  console.log('[Test] full pipeline (auth + lifecycle + invite + quota + preview + admin)...\n');
  const admin = {}; // cookie jar
  const tester = { ip: `10.77.${Date.now() % 200}.2` };
  try {
    console.log('[1] static page'); assert((await getHtml('/')).body.includes('Cloud AI Bridge'), '首页失败'); console.log('  OK');

    console.log('[2] login dev (admin)');
    let r = await request('POST', '/api/auth/login', { username: DEV_USER, password: DEV_PASS }, admin);
    if (r.status !== 200) r = await request('POST', '/api/auth/register', { username: DEV_USER, password: DEV_PASS }, admin);
    assert(r.status === 200 && admin.cookie, '登录失败');
    assert(r.body.isAdmin === true, 'dev 应为管理员'); console.log('  OK (isAdmin)');

    console.log('[3] auth gate (no cookie -> 401)');
    assert((await request('GET', '/api/projects', null, {})).status === 401, '鉴权闸门失效'); console.log('  OK');

    console.log('[4] ensure demo + lifecycle fields');
    await request('POST', '/api/projects', { projectId: DEMO }, admin);
    const list = await request('GET', '/api/projects', null, admin);
    const demo = list.body.projects.find((p) => p.projectId === DEMO);
    assert(demo && demo.expiresAt && demo.retentionUntil && demo.status, 'demo 生命周期字段缺失'); console.log('  OK', demo.status, demo.expiresAt.slice(0, 10));

    console.log('[5] start sandbox (demo)');
    assert((await request('POST', '/api/sandbox/start', { projectId: DEMO }, admin)).status === 200, '启动失败'); console.log('  OK');

    console.log('[6] WS verbatim echo');
    const wsc = new WebSocket(`ws://${HOST}:${PORT}/client?projectId=${DEMO}`, { headers: { Cookie: admin.cookie } });
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('WS 超时')), 5000); wsc.on('open', () => { clearTimeout(t); res(); }); wsc.on('error', rej); });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('PTY echo 超时')), 8000);
      wsc.on('message', (m) => { try { const p = JSON.parse(m.toString()); if (p.event === 'output' && p.data.includes('Pipeline working')) { clearTimeout(t); res(); } } catch (e) {} });
      wsc.send(JSON.stringify({ event: 'input', data: '\r\n' }));
      setTimeout(() => wsc.send(JSON.stringify({ event: 'input', data: 'echo "Pipeline working!"\r\n' })), 600);
    });
    wsc.close(); console.log('  OK (verbatim)');

    console.log('[7] bind creds');
    assert((await request('POST', '/api/creds', { projectId: DEMO, creds: { ANTHROPIC_API_KEY: 'sk-ant-test' } }, admin)).body.bound.includes('ANTHROPIC_API_KEY'), '绑定失败'); console.log('  OK');

    console.log('[8] backup demo');
    assert((await request('POST', '/api/backup/save', { projectId: DEMO }, admin)).status === 200, '备份失败'); console.log('  OK');

    console.log('[9] path-traversal guard');
    assert((await request('POST', '/api/backup/save', { projectId: '../../etc' }, admin)).status === 400, '未拦截 ../../etc'); console.log('  OK');

    console.log('[10] preview token');
    const pv = await request('POST', '/api/preview', { projectId: DEMO, port: 3000 }, admin);
    assert(pv.status === 200 && pv.body.url && pv.body.expiresAt, '预览 token 失败'); console.log('  OK', pv.body.url);

    console.log('[11] admin overview');
    const ov = await request('GET', '/api/admin/overview', null, admin);
    assert(ov.status === 200 && ov.body.users && ov.body.settings, '后台失败'); console.log('  OK users=' + ov.body.users.length);

    console.log('[12] register requires email (no email -> 400)');
    const u = 'tester_' + Date.now();
    assert((await request('POST', '/api/auth/register', { username: u, password: 'pass123' }, { ip: `10.78.${Date.now() % 200}.3` })).status === 400, '无邮箱竟可注册'); console.log('  OK');

    console.log('[13] register + email activation flow');
    const email = u + '@example.com';
    const reg = await request('POST', '/api/auth/register', { username: u, password: 'pass123', email }, tester);
    assert(reg.status === 200 && reg.body.pendingActivation && reg.body.devCode, '注册/发码失败');
    // 未激活不能登录
    const preLogin = await request('POST', '/api/auth/login', { username: u, password: 'pass123' }, {});
    assert(preLogin.status === 403 && preLogin.body.code === 'NOT_ACTIVATED', '未激活竟可登录');
    // 错误激活码被拒
    assert((await request('POST', '/api/auth/activate', { email, code: '000000' }, {})).status === 400, '错误激活码竟通过');
    // 正确激活码 → 激活并签发会话
    const act = await request('POST', '/api/auth/activate', { email, code: reg.body.devCode }, tester);
    assert(act.status === 200 && tester.cookie, '激活失败'); console.log('  OK', u);

    console.log('[14] collaboration room + file locks');
    const invite = await request('POST', '/api/room/collaborators', { projectId: DEMO, username: u }, admin);
    assert(invite.status === 200 && invite.body.collaborators.includes(u), '协作者邀请失败');
    const rooms = await request('GET', '/api/rooms', null, tester);
    assert(rooms.status === 200 && rooms.body.rooms.some((x) => x.ownerId === DEV_USER && x.projectId === DEMO && x.role === 'member'), '协作者房间列表缺失');
    const deniedLocks = await request('GET', `/api/room/locks?projectId=${DEMO}`, null, tester);
    assert(deniedLocks.status === 403, '协作者未带 owner 竟可访问同名房间');
    const aLock = await request('POST', '/api/room/lock', { projectId: DEMO, files: ['src/a.js', 'src/b.js'] }, admin);
    assert(aLock.status === 200 && aLock.body.granted.length === 2, '房主锁定失败');
    const bLock = await request('POST', '/api/room/lock', { owner: DEV_USER, projectId: DEMO, files: ['src/b.js', 'src/c.js', '../secret.txt'] }, tester);
    assert(bLock.status === 200, '协作者锁定请求失败');
    assert(bLock.body.granted.includes('src/c.js') && !bLock.body.granted.includes('../secret.txt'), '协作者锁定授予不正确');
    assert(bLock.body.conflicts.some((x) => x.file === 'src/b.js' && x.by === DEV_USER), '锁冲突未返回');
    const locks = await request('GET', `/api/room/locks?owner=${DEV_USER}&projectId=${DEMO}`, null, tester);
    assert(locks.status === 200 && locks.body.locks['src/a.js'] && locks.body.locks['src/c.js'], '锁列表不完整');
    const lockDoc = path.join(__dirname, 'workspace', 'users', DEV_USER, DEMO, 'LOCKS.md');
    assert(fs.existsSync(lockDoc), 'LOCKS.md 未写入');
    const lockText = fs.readFileSync(lockDoc, 'utf8');
    assert(lockText.includes('src/a.js') && lockText.includes('src/c.js') && !lockText.includes('secret.txt'), 'LOCKS.md 内容异常');
    const collabWs = new WebSocket(`ws://${HOST}:${PORT}/client?projectId=${DEMO}&owner=${DEV_USER}`, { headers: { Cookie: tester.cookie } });
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('协作 WS 超时')), 5000); collabWs.on('open', () => { clearTimeout(t); res(); }); collabWs.on('error', rej); });
    collabWs.close();
    const removed = await request('POST', '/api/room/collaborators', { projectId: DEMO, username: u, remove: true }, admin);
    assert(removed.status === 200 && !removed.body.collaborators.includes(u), '移除协作者失败');
    const afterRemove = await request('GET', `/api/room/locks?owner=${DEV_USER}&projectId=${DEMO}`, null, tester);
    assert(afterRemove.status === 403, '移除后协作者仍可访问房间');
    console.log('  OK');

    console.log('[15] daily create quota (2nd -> 429)');
    assert((await request('POST', '/api/projects', { projectId: 'p1' }, tester)).status === 200, 'p1 创建失败');
    assert((await request('POST', '/api/projects', { projectId: 'p2' }, tester)).status === 429, '每日配额未生效'); console.log('  OK');

    console.log('[16] ban tester -> denied (session killed)');
    assert((await request('POST', `/api/admin/users/${u}/ban`, { banned: true }, admin)).status === 200, '封禁失败');
    // 封禁即时清掉会话：旧 cookie 失效 → 401（会话没了）或 403（仍被识别为封禁）都算拦截成功
    assert([401, 403].includes((await request('GET', '/api/auth/me', null, tester)).status), '封禁后仍可访问'); console.log('  OK');

    console.log('[17] destroy throwaway');
    const tw = 'throwaway_' + Date.now();
    await request('POST', '/api/projects', { projectId: tw }, admin);
    assert((await request('POST', '/api/project/destroy', { projectId: tw }, admin)).status === 200, '销毁失败'); console.log('  OK');

    console.log('\n🎉 All tests passed!');
    process.exit(0);
  } catch (err) {
    console.error('\n🚨 Failed:', err.message);
    process.exit(1);
  }
}
setTimeout(runTests, 2000);
