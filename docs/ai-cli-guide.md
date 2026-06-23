# AI 工具指南：Claude Code / Codex / DeepSeek

平台不绑定你用哪家模型，采用 **BYO（自带凭证）**：你出 Key 或会员号，平台只提供隔离运行环境。

## 绑定方式

### A. API Key（最简单）
在【设置】→「模型 / 账号」填对应 Key，点【保存并注入】，Key 会作为环境变量注入你的容器（不回显、不外泄给浏览器）：
- **Anthropic**（Claude Code）
- **OpenAI**（Codex）
- **DeepSeek**（见下）

### B. 会员号（OAuth 设备码登录）
适合已有 Claude/Codex 订阅的用户：
1. 先【激活并连接沙箱】。
2. 切到终端，运行：
   - Claude：`claude`（首次会提示登录）
   - Codex：`codex login`
3. 按提示在手机/电脑完成设备码授权。
4. 凭证写入挂载的 `~/.claude` / `~/.codex`，**跨重启保留**。

## DeepSeek 怎么用
DeepSeek 是 OpenAI 兼容的 **chat** 接口：
- 填好 DeepSeek API Key 后，平台会自动写好 claude-code-router 配置，让对话模式用 `ccr code` 调 DeepSeek；模型可选 `deepseek-chat` 或 `deepseek-reasoner`。
- Codex 仍走 OpenAI/Codex 账号，不再把 DeepSeek 写入 Codex 配置。
- **注意**：DeepSeek 回答里可能自称「Claude」之类——那是它在模仿所运行 CLI 的系统提示，并不代表你真在用 Claude。你用的就是你绑定的那个模型。

## GLM / 智谱 怎么用
和 DeepSeek 一样**只需填 Key、不用手动改配置**：
- 在【设置 > 模型/账号】填 **GLM（智谱）API Key**（智谱开放平台获取）→ 保存。
- 对话模型下拉选 **GLM / 智谱**，模型可选 `glm-4.6`/`glm-4.5`/`glm-4-flash` 等（也能自定义）。
- 平台会自动写好 claude-code-router 配置，对话经 `ccr code` 调 GLM（OpenAI 兼容）。
- 其它 OpenAI 兼容模型（Kimi/通义等）原理相同，后续可按同样方式加为内置项；如急用可联系管理员加 provider。

> 说明：GLM 走的是「内置 OpenAI 兼容接入」，首次用建议拿自己的 Key 验证一下回复正常。

## 对话 vs 终端
- **对话模式**：headless 方式跑 AI（`claude -p` / `ccr code -p` / `codex exec`），回成气泡，并保留对话历史。
- **终端模式**：你直接操作交互式 CLI，能看到 yes/no 选项框。

## 让 AI 知道你在做什么
在【设置】→「模型 / 账号」里的「项目说明」写一句话（如「仿淘宝商城前端，HTML/CSS/JS」），会写入项目根的 `CLAUDE.md` / `AGENTS.md`，AI 每次都能读到上下文。

## 用量与成本
用量计在**你自己**的账号上。1C1G 适合轻量任务；同时跑多个 AI CLI 容易爆内存，建议一次跑一个。
