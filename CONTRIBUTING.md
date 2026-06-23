# 贡献指南 / Contributing

感谢关注 Cloud AI Bridge。本项目是**半开放**的：欢迎对低风险层贡献，安全核心层只接受 owner 审核的改动。

## ✅ 欢迎外部 PR 的部分（低风险）
- 前端 / 移动端体验：`conduit/public/`（页面、空状态、错误提示、表单体验）
- 管理后台 UI：`conduit/public/admin.html`（页面与状态卡片；危险动作必须走受控 API，不要绕过）
- 预览 UI：端口检测、二维码、倒计时、刷新/撤销按钮（**不要改 proxy 核心安全校验**）
- Sandbox Agent / 镜像：`sandbox/`（在不破坏隔离与安全参数的前提下）
- 文档 / 模板 / 新手教程：`docs/`、`templates/`、README

## 🔒 仅 owner 审核的安全核心（见 CODEOWNERS）
改这些请先开 issue 讨论；未经 owner 审核不合并：
- 容器创建与安全参数：`conduit/src/orchestrator.js`、`sandbox/Dockerfile`
- 鉴权 / 会话 / WebSocket 鉴权 / 预览代理 / 生命周期 / 凭证存储：`conduit/src/index.js`、`conduit/src/auth.js`
- 部署与加固：`deploy/`

## PR 红线（务必遵守）
- **不要提交任何密钥 / 真实配置 / 用户数据**：`.env`、`data/`、`backups/`、`workspaces/`、`logs/`、API Key、真实服务器 IP/域名。
- 不要修改容器安全默认值（禁 `--privileged` / host network / 挂 docker.sock / 放开 cap）。
- 不要把任意 docker 参数暴露给用户、不要让用户绕过隔离。
- 提交需附 README/验证说明；尽量小而聚焦。

## 不应公开的内容（即使仓库后续公开）
- `docs/AI_Sandbox_MVP_planning_v2.docx`（含规划/服务器细节）、任何带真实环境值的部署文件 → 应保留在私有侧或脱敏后再公开。

## 本地开发
```bash
npm run install-all
node start-dev.js     # MOCK 模式（无需 Docker）；浏览器 dev/devpass 登录
npm run test:conduit  # 管道/鉴权/配额自检
```

## License
贡献即表示同意你的代码以本项目的双许可（MIT OR Apache-2.0）发布。
