// 本地开发/MOCK 启动器（无需 Docker）：
// 1) 用 auth 模块创建一个 dev 账号 + demo 项目，拿到该项目的私有 channelToken
// 2) 启动 Conduit（它会从 users.json 加载到 dev/demo）
// 3) 用 demo 的 channelToken 在宿主机本地启动一个 Sandbox Agent
// 浏览器里用 dev / devpass 登录，选 demo 项目，点【激活并连接】即可遥控本机 shell。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const auth = require('./conduit/src/auth');

const DEV_USER = 'dev';
const DEV_PASS = 'devpass';
const DEV_PROJECT = 'demo';

(async () => {
  let user = auth.getUserById(DEV_USER);
  if (!user) {
    user = await auth.registerUser(DEV_USER, DEV_PASS, { activated: true });
    console.log(`[Dev] Created dev account: ${DEV_USER} / ${DEV_PASS}`);
  }
  const proj = auth.getOrCreateProject(user, DEV_PROJECT);
  const channelToken = proj.channelToken;

  // 生成一个可用邀请码，方便在浏览器里测试"邀请码注册"流程
  const invite = auth.createInvite('dev auto invite');
  console.log(`[Dev] Invite code (用于注册新账号): ${invite.code}`);

  const workspacePath = path.join(__dirname, 'workspace', 'users', DEV_USER, DEV_PROJECT);
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
    console.log(`[Dev] Created workspace at ${workspacePath}`);
  }

  console.log('[Dev] Login with  dev / devpass , project: demo');
  console.log('[Dev] Starting Conduit Server and local Sandbox Agent...');

  const conduit = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, 'conduit'),
    stdio: 'inherit',
    env: { ...process.env, PORT: process.env.PORT || 8080 }
  });

  let agent = null;
  setTimeout(() => {
    agent = spawn('node', ['src/index.js'], {
      cwd: path.join(__dirname, 'sandbox/agent'),
      stdio: 'inherit',
      env: {
        ...process.env,
        CONDUIT_URL: `ws://localhost:${process.env.PORT || 8080}`,
        SANDBOX_TOKEN: channelToken,
        WORKSPACE_DIR: workspacePath
        // 不设 SANDBOX_IN_CONTAINER → agent 上报 127.0.0.1，预览反代走本机
      }
    });
    agent.on('close', (code) => {
      console.log(`[Dev] Sandbox Agent exited with code ${code}`);
      conduit.kill();
      process.exit(code);
    });
  }, 1000);

  conduit.on('close', (code) => {
    console.log(`[Dev] Conduit Server exited with code ${code}`);
    if (agent) agent.kill();
    process.exit(code);
  });

  process.on('SIGINT', () => {
    console.log('\n[Dev] Shutting down services...');
    conduit.kill();
    if (agent) agent.kill();
    process.exit(0);
  });
})();
