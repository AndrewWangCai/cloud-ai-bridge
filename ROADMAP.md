# Cloud AI Bridge — 项目清单 / Roadmap

> 一份"免得后期忘记"的总清单：产品定位、商业模式、生命周期、已完成、待办、注意事项。

## 产品定位
手机 / 浏览器当遥控器，远程操控**云端隔离 Docker 沙箱**里的 AI 编程工具（Claude Code / Codex / DeepSeek），写代码、跑服务、预览网页、git 同步。计划在 GitHub **半开放**。

## 商业模式
- **免费档**：1 核 1G 临时 Docker 沙箱，供用户跑 AI 编程。
- **生命周期**：运行 **5 天** → 到期自动**停止 + 备份** → **备份保留期**（其间用户可 `git push` 把代码取回自己仓库）→ 超过保留期**彻底销毁**（容器 / workspace / 备份全清）。
- 用户随时可用自己的 GitHub 账号 **git push / pull** 同步代码。
- **AI 用量**：用户**自带 API Key**（Anthropic / OpenAI / DeepSeek）或会员号登录；平台不替用户买额度。
- **盈利**：① 付费**扩容**（更高 CPU / 内存 / 更长时长）；② **售卖 token**（模型用量）。

## 生命周期参数（已实现，可在 conduit.env 配）
| 参数 | 默认 | 含义 |
|---|---|---|
| `FREE_RUN_DAYS` | 5 | 运行期（天） |
| `RETENTION_DAYS` | 10 | 备份保留期（其间可 push git） |
| `MAX_RUNNING_FREE` | 1 | 同时运行的免费项目上限 |
| `MAX_CREATE_PER_DAY` | 1 | 每日新建项目上限 |
| 容器限额 | 1 CPU / 1G / pids 256 | 免费档；付费档预留 tier 机制 |

## 已完成 ✅
- 账号（注册 / 登录 / 会话）、**邀请码注册**、每日配额、封禁、全局开关（注册 / 创建 / 免费档）
- **多租户**：每用户每项目独立 Docker 沙箱（隔离 + 加固：1C1G / pids / cap-drop / no-new-priv / 专用网络）
- **真·遥控**：指令逐字进容器 PTY；Claude Code / Codex / DeepSeek 三条路
- **DeepSeek 接入**：经 claude-code-router(ccr)，用户只有 DeepSeek key 也能用 Claude Code 界面
- **GitHub 绑定**（PAT）：免密 clone / push 同步代码
- **生命周期 + 自动备份 / 销毁**（CleanupWorker 定时扫描）
- **网页实时预览** + **可过期分享链接**（preview token，默认 30 分钟）
- **管理员后台 `/admin.html`**：用户 / 项目 / 容器总览、生成 / 禁用邀请码、封禁用户、停止 / 销毁项目、撤销预览、运行时开关
- **安全**：跨用户越权 + 路径穿越防护；密钥不回显；出网加固（封云元数据 HTTP / SMTP，放行 DNS）；读库失败不清空（防数据丢失）
- **部署套件**：verify-docker.sh / systemd / nginx / update.sh / bootstrap-admin.js / harden-network.sh
- 终端**自托管 xterm**（public/vendor，不依赖外部 CDN）
- **对话模式 Phase 1**：左侧气泡式对话（headless 跑 AI，沙箱内自动执行），可选模型 Claude/Codex/DeepSeek；AI 记忆默认 `--continue` 续上次（存于 bind 挂载的 `~/.claude`，跨容器重建/重进网页保留）。终端模式保留给想 Yes/No 手动批准的人。

## 待办 / TODO 📋
> 完整规格见 `docs/AI_Sandbox_MVP_planning_v2.docx`（v2 整合版，含激活可观测 / Hermes / 多 AI 聊天 / 计费成本模型等）。
- [ ] **🔴 SandboxActivationManager（激活可观测）**（docx 列为第一优先）：把激活每步（auth/quota/workspace/docker/container/agent/ws）的失败原因落库 `activationFailureReason`，前端 + Admin 可见、可重试——别再黑盒返回 500。我们这几天卡的"激活不了"就是缺它。
- [ ] **项目说明 → CLAUDE.md / AGENTS.md**：让 AI 知道在做什么项目（Claude Code 自动读 CLAUDE.md，Codex 读 AGENTS.md）。
- [ ] **对话历史 UI 重载**：重进网页时把上次气泡也加载回来（AI 记忆已持久，这是 UI 层补全）。
- [ ] **48h 公开测试 TTL**：docx 建议公开默认 48 小时、5 天作内测配置（现默认 `FREE_RUN_DAYS=5`）。
- [ ] **备份下载入口** + 到期前提醒 push 到 git。
- [ ] **盈利系统**：扩容档位 + token 售卖与计量（MVP 不做，后续）
- [ ] **付费档位编排**：orchestrator 已有 tier 雏形，接计费后开放更高配置 / 更长时长
- [ ] **会话持久化**：目前存内存，conduit 重启即掉登录 → 落盘 / Redis，避免重启全员掉线
- [ ] **管理员页面增强**：服务器 CPU / 内存 / 磁盘监控、最近错误日志、按用户用量统计
- [ ] **半开源准备**：完善 README / 加 LICENSE / 贡献指南；确认 data、secrets、workspaces、backups 均不入库（已 .gitignore）
- [ ] **国内访问**：香港入口（免 VPN）——待迁移 / 反代
- [ ] **备份下载入口**：用户在保留期内一键下载 tar
- [ ] **到期前提醒**：临到期提醒用户 push 到 git
- [ ] **防滥用**：注册 IP 限频（文档已列，未实现）
- [ ] **密钥加密存储**：目前明文存 users.json(0600) → 静态加密 / KMS
- [ ] **对话体验**：在保留 Yes/No 安全批准的前提下，电脑端加终端折叠 / 展开开关

## 已知注意事项 ⚠️
- 会话存内存：conduit 重启 → 所有人需重新登录（见 TODO 持久化）。
- 容器 `restart=no`：服务器重启后用户需重新【激活并连接】（交给生命周期管，预期行为）。
- **改 users.json 必须用 root**（与 conduit 同权限）；已加保护：读不了会报错+备份，绝不再以空库覆盖清数据。
- **DeepSeek 不能直连 codex**（codex 0.140 砍了 chat 协议）→ 走 ccr（Claude Code 外壳 + DeepSeek 模型）。
- 预览 / 分享链接依赖容器内有 web 服务在监听（端口 1024–32768，排除 3456=ccr）。
- 邀请码 / 账号数据由 conduit(root) 持有，生成邀请码请走 `/admin.html` 或 `sudo`，勿用普通用户跑脚本。
