// 端到端 UI 回归（puppeteer-core，iPhone 视口）：登录 → 进应用 → 连接 → 发指令 → 切 Tab。
// 截图存 ./screenshots。需先运行：PORT=<port> node start-dev.js
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const BASE = `http://localhost:${PORT}/`;

const possiblePaths = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
].filter(Boolean);

let executablePath = '';
for (const p of possiblePaths) { if (fs.existsSync(p)) { executablePath = p; break; } }
if (!executablePath) { console.error('未找到 Edge/Chrome'); process.exit(1); }

const shotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir, { recursive: true });
const shot = (name) => path.join(shotDir, name);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('[E2E] browser:', executablePath, '| target:', BASE);
  const browser = await puppeteer.launch({
    executablePath, headless: true, protocolTimeout: 90000,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('[Page Error]', err.toString()));
  page.on('dialog', async (d) => { console.log('[Dialog]', d.message()); await d.accept(); });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

  console.log('STEP 1: 登录页');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await wait(1200);
  await page.screenshot({ path: shot('1_login.png') });

  console.log('STEP 2: 输入并登录 (dev/devpass)');
  await page.evaluate(() => {
    document.getElementById('authUser').value = 'dev';
    document.getElementById('authPass').value = 'devpass';
  });
  await page.evaluate(() => window.doAuth());
  await wait(2500);
  await page.screenshot({ path: shot('2_app_home.png') });

  console.log('STEP 3: 打开配置');
  await page.evaluate(() => window.toggleSettings());
  await wait(800);
  await page.screenshot({ path: shot('3_settings.png') });

  console.log('STEP 4: 连接沙箱');
  await page.evaluate(() => window.connect());
  await wait(4000);
  await page.screenshot({ path: shot('4_connected.png') });

  console.log('STEP 5: 发送遥控指令');
  await page.evaluate(() => {
    const i = document.getElementById('chatInput');
    i.value = 'echo "hello from phone"';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => window.sendChatInstruction());
  await wait(3000);
  await page.screenshot({ path: shot('5_chat_output.png') });

  console.log('STEP 6: 终端 Tab');
  await page.evaluate(() => window.switchTab('terminal'));
  await wait(1000);
  await page.screenshot({ path: shot('6_terminal.png') });

  console.log('STEP 7: 预览 Tab');
  await page.evaluate(() => window.switchTab('preview'));
  await wait(1000);
  await page.screenshot({ path: shot('7_preview.png') });

  console.log('STEP 8: 管理员后台');
  await page.setViewport({ width: 900, height: 1100 });
  await page.goto(BASE + 'admin.html', { waitUntil: 'domcontentloaded' });
  await wait(1500);
  await page.screenshot({ path: shot('8_admin.png'), fullPage: true });

  console.log('[E2E] done. screenshots ->', shotDir);
  await browser.close();
}

run().catch((err) => { console.error('E2E failed:', err); process.exit(1); });
