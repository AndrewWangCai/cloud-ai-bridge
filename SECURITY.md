# 安全策略 / Security Policy

## 报告漏洞
请**不要**在公开 issue 里贴漏洞细节。请私下联系维护者（GitHub 私信 owner / 邮件），并附：
- 影响范围与复现步骤
- 受影响文件 / 端点
- 可能的修复建议（可选）

我们会尽快确认，并在修复后与你协调披露时间。

## 本项目的安全边界（设计取舍）
- **容器隔离**：每个用户每个项目一个容器，`cap-drop=ALL`、`no-new-privileges`、`pids-limit`、内存/CPU 限额、专用网络、`restart=no`；**绝不**使用 `--privileged` / host network / 挂载 `docker.sock`。
- **出网加固**：`deploy/harden-network.sh` 阻断容器访问云元数据 `169.254.169.254` 与外发 SMTP，防窃取云令牌。
- **凭证**：`channelToken` 服务端私有，浏览器永不可见；API Key 以 0600 权限存 `data/users.json`（明文，建议生产侧叠加 KMS/静态加密）。
- **会话**：httpOnly cookie；会话文件 0600，仅 conduit 进程用户可读写。
- **越权防护**：跨用户访问拦截 + `projectId` 路径穿越（sanitizeId）防护。

## 不在威胁模型内（已知取舍）
- 单机原型，未做高可用/抗 DDoS；公网入口需自备 HTTPS 反代与防火墙。
- API Key 明文存储（见上）；多租户隔离依赖 Docker，不抵御内核 0day 级逃逸。

## 公开仓库注意
切勿提交真实密钥 / 用户数据 / 真实服务器 IP/域名（见 [CONTRIBUTING.md](CONTRIBUTING.md) 红线）。
