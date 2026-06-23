# Hermes 云端秘书（架构与扩展）

> 本版交付的是**平台侧治理 + 隔离骨架**（docx §7）：默认关闭、用户级、严格限额、跨用户隔离、可审计、可被管理员一键停。
> 真实 agent 逻辑与外部消息连接器是**可插拔扩展点**——平台只提供受治理的隔离运行时，用户自带模型 Key 与连接器凭证。

## 连接器（含 QQ / 微信）
内置连接器开关已含：Telegram、飞书、Slack、Discord、Email、**QQ**、**微信**（默认全关，需各自填凭证）。
平台只提供「开关 + 最小授权凭证注入 + 限额」，**真实收发逻辑在 agent 扩展点实现**。各平台现实约束：
- **QQ**：用腾讯 **QQ 官方机器人**（QQ 开放平台注册，拿 AppID/Token/Secret，填 `QQ_BOT_APPID/QQ_BOT_TOKEN/QQ_BOT_SECRET`）。个人 QQ 号没有官方机器人 API，不要用第三方协议库（封号风险 + 违规）。
- **微信**：**个人微信无官方开放 bot API**（第三方 hook 违规且易封），不建议接。可行的是**微信公众号/企业微信**（公众号 `WECHAT_APPID/WECHAT_TOKEN/WECHAT_SECRET`，企业微信走应用回调）。所以"微信连接器"实际指公众号/企业微信，不是个人微信。
- 其余（Telegram/Slack/Discord/飞书）走各自官方 Bot API。

> 即：开关和凭证位已经预留好，但**真正能收发**还需要在 agent 里实现对应 SDK 调用；且 QQ/微信受官方平台规则约束（个人号不可用）。

## 定位
Hermes 不是 MVP 主链路，而是「用户级云端秘书 / 个人 agent」的托管层。平台**只**负责：
- 给每个用户一个**独立加固的 sidecar 容器**（`hermes_<userId>`）；
- 提供模型/连接器**凭证注入**、**预算/工具权限**约束、**审计**与**紧急停止**；
- 保证**跨用户隔离**：Hermes 永远拿不到其他用户的项目、也没有平台管理员权限。

## 数据模型（`user.hermes`，见 `conduit/src/auth.js`）
```
enabled, provider, status(OFF/RUNNING/STOPPED/ERROR),
budgets:{ tokensPerDay, messagesPerDay, tasksPerDay },
connectors:{ telegram, feishu, slack, discord, email },   // 默认全 false
tools:{ readFiles(默认true), writeFiles, runCommands, sendMessages },  // 默认只读
usage:{ day, tokens, messages, tasks },                    // 按天自动重置
creds:{ HERMES_API_KEY, HERMES_BASE_URL, HERMES_MODEL, <各连接器凭证> }  // 不回显
```
对外只暴露 `publicHermes()`（`has*` 布尔，不回显原始 key）。

## 隔离与安全（与沙箱同档，绝不放大权限）
容器创建（`orchestrator.startHermes`）：
- `cap-drop=ALL`、`no-new-privileges`、`pids-limit`、内存/CPU 限额（免费档）、专用网络、`restart=no`、日志限额；
- **绝不** privileged / host network / 挂 docker.sock；
- 只挂载该用户**独立**的 `~/.hermes` 目录（记忆与项目 workspace 分开存储）；
- 出站流量守卫（`EGRESS_LIMIT_MB`）与磁盘守卫同样覆盖 `hermes_` 容器；
- 仅注入**已开启**连接器的凭证（最小授权）。

## 限额与审计
- **预算**：`hermesWithinBudget()` / `recordHermesUsage()` 按天重置；真实 agent 应在每次调用前查预算、调用后回报用量。
- **工具权限**：通过 `HERMES_TOOL_READ/WRITE/EXEC/SEND` 环境变量透传，运行时须自我约束（默认只读）。
- **审计**：`[HermesAudit]` 记录 start/stop/bind-creds/admin-stop（谁、何时、用哪些连接器）。

## API
用户：
- `GET  /api/hermes` — 当前配置（脱敏）+ 功能总开关
- `POST /api/hermes/config` — 改 provider/budgets/connectors/tools（白名单合并）
- `POST /api/hermes/creds` — 绑定模型/连接器凭证（不回显）
- `POST /api/hermes/start` — 需已选 provider + 绑定模型 Key；起隔离 sidecar
- `POST /api/hermes/stop` — 停止并删除该用户 sidecar

管理员：
- `/api/admin/overview` 含 `hermes`（所有启用用户概览）
- `POST /api/admin/hermes/:userId/stop` — 一键停某用户 Hermes

平台总开关：环境变量 `HERMES_FEATURE_ENABLED=0` 可整体关闭。

## 如何接入「真实 agent」
当前 sidecar 跑一个占位工作负载（保活槽位）。把它替换为真实 agent：
1. 在镜像里加入 agent 程序（或单独 hermes 镜像），读取注入的：
   - `HERMES_PROVIDER` / `HERMES_API_KEY` / `HERMES_BASE_URL` / `HERMES_MODEL`
   - `HERMES_TOOL_*`（权限）、`HERMES_BUDGET_*`（预算）
   - 各连接器 token（仅已开启的会注入）
2. 把 `orchestrator.startHermes` 里的 `Cmd`（占位 `sleep infinity`）改成启动 agent。
3. agent 须：调用前查预算、调用后通过回调把用量回报给 conduit（扩展一个 `POST /api/hermes/usage` 内部接口并 `recordHermesUsage`）。

## 如何加一个连接器（以 Telegram 为例）
1. `auth.js` 的 `HERMES_CONNECTORS` 已含 `telegram`；凭证键 `TELEGRAM_BOT_TOKEN` 已在 `HERMES_CRED_KEYS`。
2. 前端连接器开关已自动渲染；用户开启并填 token 保存即可。
3. 在 agent 内实现 Telegram **长轮询**（无需公网 webhook）：仅当 `connectors.telegram` 开启且 `tools.sendMessages` 允许时才发消息。
4. 遵守限额：每条消息计入 `messagesPerDay`；群发/SMTP/爬虫/内网访问一律禁止（出站守卫兜底）。

## 安全红线（docx §7）
- Hermes **绝不**拥有跨用户全局权限、**不**默认读取所有用户项目、**不**能拿平台管理员权限；
- 不能让用户借 Hermes 绕过容器安全限制；
- 连接器一律走用户授权、最小权限、单独开关。
