const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// 寻找 Edge 或 Chrome 的执行文件路径
const possiblePaths = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env.PROGRAMFILES, 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'], 'Google\\Chrome\\Application\\chrome.exe')
];

let executablePath = '';
for (const p of possiblePaths) {
  if (p && fs.existsSync(p)) {
    executablePath = p;
    break;
  }
}

if (!executablePath) {
  console.error("Error: Edge or Chrome executable not found!");
  process.exit(1);
}

console.log("Using browser at:", executablePath);

const artifactDir = 'C:\\Users\\Lenovo\\.gemini\\antigravity\\brain\\886b63a4-ee21-466f-8692-e77b14b0c76b';

async function run() {
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  // 监听 console 错误
  page.on('console', msg => {
    console.log(`[Browser Console ${msg.type()}] ${msg.text()}`);
  });

  page.on('pageerror', err => {
    console.error(`[Browser Page Error] ${err.toString()}`);
  });

  console.log("Navigating to http://localhost:8080/...");
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true }); // 模拟手机 iPhone X 视口
  
  // 使用 domcontentloaded 避免因为被墙的 CDN 资源未加载完而长时间挂起
  await page.goto('http://localhost:8080/', { waitUntil: 'domcontentloaded' });
  console.log("Loaded. Saving initial screenshot...");
  
  const initialPath = path.join(artifactDir, 'screenshot_initial.png');
  await page.screenshot({ path: initialPath });
  console.log("Initial screenshot saved to:", initialPath);

  console.log("Waiting for settings trigger selector...");
  await page.waitForSelector('.settings-trigger', { timeout: 10000 });

  console.log("Clicking settings drawer trigger (.settings-trigger)...");
  await page.evaluate(() => {
    const el = document.querySelector('.settings-trigger');
    if (el) el.click();
  });
  
  console.log("Waiting 1 second for drawer animation...");
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const afterClickPath = path.join(artifactDir, 'screenshot_drawer_opened.png');
  await page.screenshot({ path: afterClickPath });
  console.log("Drawer opened screenshot saved to:", afterClickPath);

  // 输入一些文本到 textarea，触发 handleInputKey
  console.log("Typing in chat textarea...");
  await page.evaluate(() => {
    const input = document.getElementById('chatInput');
    if (input) {
      input.value = 'Hello Sandbox!';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  
  // 截图看输入内容
  const afterTypingPath = path.join(artifactDir, 'screenshot_typing.png');
  await page.screenshot({ path: afterTypingPath });
  console.log("Typing screenshot saved to:", afterTypingPath);

  await browser.close();
  console.log("Browser closed. Automation verification finished successfully!");
}

run().catch(err => {
  console.error("Automation error:", err);
  process.exit(1);
});
