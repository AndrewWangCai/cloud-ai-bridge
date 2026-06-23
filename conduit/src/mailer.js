// 邮件发送（注册激活码）。基于 nodemailer + SMTP，兼容 QQ/163/Gmail 应用密码或专业邮件服务。
// 未配置 SMTP 时进入「dev 模式」：不真发，只打印激活码到控制台，方便本地/测试跑通。
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { console.warn('[Mailer] nodemailer 未安装，邮件功能不可用'); }

const HOST = process.env.SMTP_HOST || '';
const PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SECURE = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === '1' : PORT === 465;
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.SMTP_FROM || USER;
const APP_NAME = process.env.MAIL_APP_NAME || 'Cloud AI Bridge';

let transporter = null;
function isConfigured() { return !!(nodemailer && HOST && USER && PASS); }
function getTransporter() {
  if (!transporter && isConfigured()) {
    transporter = nodemailer.createTransport({ host: HOST, port: PORT, secure: SECURE, auth: { user: USER, pass: PASS } });
  }
  return transporter;
}

// 发送激活码。返回 { sent:true } 或 { dev:true, code }（dev 模式回传 code 仅用于本地/测试）
async function sendActivationCode(email, code) {
  if (!isConfigured()) {
    console.log(`[Mailer DEV] 未配置 SMTP，激活码（${email}）= ${code}`);
    return { dev: true, code };
  }
  const subject = `${APP_NAME} 注册激活码：${code}`;
  const text = `欢迎注册 ${APP_NAME}。\n\n你的激活码是：${code}\n\n15 分钟内有效。如果不是你本人操作，请忽略本邮件。`;
  const html = `<p>欢迎注册 <b>${APP_NAME}</b>。</p><p>你的激活码是：<b style="font-size:20px;letter-spacing:2px;">${code}</b></p><p>15 分钟内有效。如果不是你本人操作，请忽略本邮件。</p>`;
  await getTransporter().sendMail({ from: `"${APP_NAME}" <${FROM}>`, to: email, subject, text, html });
  return { sent: true };
}

// 发送找回密码的验证码
async function sendResetCode(email, code) {
  if (!isConfigured()) {
    console.log(`[Mailer DEV] 未配置 SMTP，重置码（${email}）= ${code}`);
    return { dev: true, code };
  }
  const subject = `${APP_NAME} 找回密码验证码：${code}`;
  const text = `你正在重置 ${APP_NAME} 的登录密码。\n\n验证码：${code}\n\n15 分钟内有效。如果不是你本人操作，请忽略本邮件，你的密码不会被更改。`;
  const html = `<p>你正在重置 <b>${APP_NAME}</b> 的登录密码。</p><p>验证码：<b style="font-size:20px;letter-spacing:2px;">${code}</b></p><p>15 分钟内有效。如果不是你本人操作，请忽略本邮件，你的密码不会被更改。</p>`;
  await getTransporter().sendMail({ from: `"${APP_NAME}" <${FROM}>`, to: email, subject, text, html });
  return { sent: true };
}

// 启动时验证 SMTP（不阻塞）；失败只告警
async function verify() {
  if (!isConfigured()) { console.log('[Mailer] 未配置 SMTP（注册激活码将以 dev 模式打印到控制台）'); return; }
  try { await getTransporter().verify(); console.log(`[Mailer] SMTP 就绪：${USER}@${HOST}:${PORT}`); }
  catch (e) { console.warn('[Mailer] SMTP 验证失败：' + e.message); }
}

module.exports = { isConfigured, sendActivationCode, sendResetCode, verify };
