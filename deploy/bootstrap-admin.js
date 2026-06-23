// 创建首个管理员账号（自动激活，绕过邮箱激活流程）。
// 必须用与 Conduit 相同的数据目录环境运行，确保写到同一个 users.json：
//   set -a; source /opt/ai-sandbox/secrets/conduit.env; set +a
//   node deploy/bootstrap-admin.js <用户名> <密码>
// 完成后确认 ADMIN_USERS 含该用户名，并重启 conduit。
const auth = require('../conduit/src/auth');

(async () => {
  const [, , username, password] = process.argv;
  if (!username || !password) {
    console.error('用法: node deploy/bootstrap-admin.js <用户名> <密码>');
    process.exit(1);
  }
  try {
    if (auth.getUserById(username)) {
      console.log(`账号已存在：${username}（跳过创建）`);
    } else {
      await auth.registerUser(username, password, { activated: true });
      console.log(`✅ 已创建账号（已激活）：${username}`);
    }
    const admins = (process.env.ADMIN_USERS || 'dev');
    if (!admins.split(',').map((s) => s.trim().toLowerCase()).includes(username.toLowerCase())) {
      console.log(`⚠️  当前 ADMIN_USERS="${admins}" 不含 ${username}。请在 conduit.env 设 ADMIN_USERS=${username} 后重启 conduit，才能进 /admin.html。`);
    } else {
      console.log(`管理员身份 OK（ADMIN_USERS 含 ${username}）。重启 conduit 后访问 /admin.html。`);
    }
    process.exit(0);
  } catch (e) {
    console.error('失败：', e.message);
    process.exit(1);
  }
})();
