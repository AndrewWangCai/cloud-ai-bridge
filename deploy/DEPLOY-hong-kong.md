# 香港服务器部署清单

这套程序没有运行时 `REGION=tokyo` 之类的硬编码。要改到香港，本质是把 Conduit 部署到香港地域的服务器，并把域名、OAuth 回调和防火墙指到新机器。

## 迁移步骤

1. 在云厂商选择香港地域新建 Ubuntu 24.04 服务器，规格可沿用现有建议：4 vCPU / 16G 起步，目录根 `/opt/ai-sandbox`。
2. 将域名 A 记录切到香港服务器公网 IP；如果临时用新域名，也同步更新下面的 `PUBLIC_BASE_URL`。
3. 按 `deploy/DEPLOY-tokyo.md` 的 1-7 步部署代码、构建镜像、启用 systemd、配置 Nginx/HTTPS 和 UFW。
4. 编辑 `/opt/ai-sandbox/secrets/conduit.env`：
   - `PUBLIC_BASE_URL=https://你的香港域名`
   - `GITHUB_OAUTH_CALLBACK=https://你的香港域名/api/github/oauth/callback`（通常可留空自动拼，但换域名后 GitHub OAuth App 也要同步）
   - SMTP、管理员、配额等按原环境复制。
5. 在 GitHub OAuth App 后台把 Authorization callback URL 改为香港域名：`https://你的香港域名/api/github/oauth/callback`。
6. 重启服务：`sudo systemctl restart conduit`，再用浏览器注册/登录、新建项目、激活沙箱做冒烟验证。

## 迁移数据

如果要把旧服务器项目一起搬过去，停旧服务后复制这些目录到香港服务器同路径：

```bash
/opt/ai-sandbox/data
/opt/ai-sandbox/workspaces
/opt/ai-sandbox/backups
/opt/ai-sandbox/community
/opt/ai-sandbox/secrets/conduit.env
```

复制完确认权限，再重启 Conduit。用户容器不会跨机器迁移；到香港后用户重新点【激活并连接沙箱】即可在新机重新拉起容器。
