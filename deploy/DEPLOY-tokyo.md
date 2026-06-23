# 服务器部署清单（Linux / Docker）

目标服务器：`<SERVER_IP>` · Ubuntu 24.04 · 4vCPU/16G 建议 · 目录根 `/opt/ai-sandbox`
（Docker / Node20 / PM2 / UFW / fail2ban / `ai-sandbox-net` / 静态 IP 均已就绪。）

> 全程 root 或 `sudo`。命令里的 `your.domain.com` / `admin` / 密码请替换。

---

## 0. 上线前必做（一次性）
- [ ] **GCP 预算提醒**：Billing → Budgets & alerts，设 $50/$100，50%/80%/100% 告警（代码管不到，必须手动）。
- [ ] 准备一个域名解析到 `<SERVER_IP>`（用于 HTTPS；没有也能先用 IP 跑，但 cookie Secure 需 HTTPS）。

## 1. 放代码
```bash
sudo mkdir -p /opt/ai-sandbox/{app,workspaces,backups,logs,data,secrets,community}
# 把本仓库内容放到 /opt/ai-sandbox/app（git clone 或 scp）
cd /opt/ai-sandbox/app
npm run install-all
```

## 2. 构建镜像并真容器验证（关键一步）
```bash
npm run build:image                 # = docker build -t sandbox-image:latest sandbox
sudo bash deploy/harden-network.sh  # 阻断容器访问云元数据/SMTP（防窃取 GCP 令牌）
bash deploy/verify-docker.sh        # 构建+起容器+核对 1C1G/pids/cap-drop/网络 + claude/codex 就位
```
`verify-docker.sh` 应输出 **✅ 全部验证通过**。若元数据那项 FAIL，说明 harden 没生效，重跑第 2 步的 harden。

## 3. 配置环境
```bash
cp deploy/conduit.env.example /opt/ai-sandbox/secrets/conduit.env
chmod 600 /opt/ai-sandbox/secrets/conduit.env
# 编辑：ADMIN_USERS=你的管理员名；确认 AI_SANDBOX_* 指向 /opt/ai-sandbox/...
# 重要：注册走「邮箱激活码」，必须填 SMTP_*（QQ/163/Gmail 应用专用密码即可），否则用户收不到激活码。
nano /opt/ai-sandbox/secrets/conduit.env
```

## 4. 创建首个管理员（自动激活，免邮箱）
```bash
set -a; source /opt/ai-sandbox/secrets/conduit.env; set +a
node deploy/bootstrap-admin.js admin '一个强密码'
# 管理员账号已自动激活，可直接登录。普通用户走网页注册 + 邮箱激活码。
```

## 5. 常驻 Conduit（systemd）
```bash
sudo cp deploy/conduit.service /etc/systemd/system/conduit.service
sudo systemctl daemon-reload && sudo systemctl enable --now conduit
sudo journalctl -u conduit -f      # 应看到 "Running on http://localhost:8080" 与 cleanup 配置行
```

## 6. HTTPS 反代（WebSocket 直通）
```bash
sudo apt-get install -y nginx
sudo cp deploy/nginx-conduit.conf /etc/nginx/sites-available/conduit
sudo ln -s /etc/nginx/sites-available/conduit /etc/nginx/sites-enabled/
sudo nano /etc/nginx/sites-available/conduit      # 改 server_name 为你的域名
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.com           # 自动签发证书 + 80→443 跳转
sudo nginx -t && sudo systemctl reload nginx
```

## 7. 防火墙
```bash
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
# 关键：放行 Docker 容器网段 → 宿主 8080，否则容器内 agent 连不回 conduit
#       （表现为：激活沙箱后一直离线/掉线，agent 日志 connect ETIMEDOUT 172.17.0.1:8080）
sudo ufw allow from 172.16.0.0/12 to any port 8080 proto tcp
# 不要对公网开放 8080；公网入口只走 80/443 → nginx → 127.0.0.1:8080
sudo ufw status

# iptables（harden-network.sh 的规则）默认重启会丢，需持久化：
echo "iptables-persistent iptables-persistent/autosave_v4 boolean true" | sudo debconf-set-selections
echo "iptables-persistent iptables-persistent/autosave_v6 boolean true" | sudo debconf-set-selections
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
sudo netfilter-persistent save
```
> 还要在 **GCP 云防火墙(VPC)** 放行 `tcp:80,443`（控制台 VPC network → Firewall，或 Cloud Shell 跑 `gcloud compute firewall-rules create allow-web --allow=tcp:80,tcp:443 --source-ranges=0.0.0.0/0`）。VM 上的 gcloud 可能因服务账号 scope 不足而失败，那就用控制台/Cloud Shell。
>
> 注：容器用 `--restart=no`（到期/重启不自启，交给生命周期管），所以**服务器重启后，用户重新点一次【激活并连接】**即可拉起自己的容器，属预期行为。

## 8. 冒烟验证
```bash
# 后端管道 + 鉴权 + 配额（本机直连 8080）
PORT=8080 node test-conduit.js            # 期望 16/16 通过（需要一个在线 agent；见下）
```
> 注意：`test-conduit.js` 的「逐字回显」一项依赖一个连到 demo 项目的在线 agent。生产环境 agent 在容器内、由用户点【激活并连接】拉起，所以这步可只看前 5 项 + 鉴权/配额/预览/后台是否过；端到端遥控请走浏览器手测（下）。

**浏览器手测（手机或电脑）**：
1. 打开 `https://your.domain.com` → 用 `admin` 登录。
2. 进 `/admin.html` 确认能看后台、生成邀请码。
3. 新建项目 →【激活并连接沙箱】→ `docker ps` 应出现 `sandbox_admin_<项目>`（免费档限额 1C/1G）。
4. 终端里 `claude`（或绑定 Key 后）跑一条；`echo hi` 看逐字回显。
5. 起 `python3 -m http.server 3000` → 切【预览】看到页面 → 点「🔗 分享」拿到带过期的链接。
6. `docker inspect sandbox_admin_<项目> -f '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.CapDrop}} {{.HostConfig.NetworkMode}}'` 复核加固。

## 9. 生命周期自检（可选，验证自动清理）
临时把清理间隔与期限调小，观察自动停止/备份/销毁：
```bash
# 在 conduit.env 临时设 FREE_RUN_DAYS=0 RETENTION_DAYS=0 CLEANUP_INTERVAL_MS=30000，重启 conduit
sudo systemctl restart conduit
# 30s 内 journalctl 应出现 [Cleanup] EXPIRE+BACKUP / DESTROY；验证后改回正常值再重启
```

---

## 回滚 / 运维
```bash
sudo systemctl restart conduit          # 重启
sudo systemctl stop conduit             # 停服
docker ps --filter "name=sandbox_"      # 看所有用户容器
docker rm -f $(docker ps -aq --filter "name=sandbox_")   # 紧急清空所有沙箱容器
```
管理员后台 `/admin.html` 可一键：关闭注册/创建、封禁用户、停止/销毁项目、撤销预览、生成邀请码。
