# 沙箱镜像：Node 运行时 + AI 编程 CLI（Claude Code / Codex）+ Sandbox Agent。
# 用 node:22 以满足较新 CLI 的引擎要求。
FROM node:22-bullseye-slim

ENV DEBIAN_FRONTEND=noninteractive

# 基础系统依赖：Python3、Git，以及编译 node-pty 所需的构建工具链
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    python3-pip \
    python3-dev \
    git \
    curl \
    ca-certificates \
    openssh-client \
    procps \
    iproute2 \
    && rm -rf /var/lib/apt/lists/*

# 预装 AI 编程 CLI（全局）。用户既可注入 API Key，也可在终端里跑 `claude login` / `codex login`
# claude-code-router(ccr)：把 Claude Code 路由到 DeepSeek 等任意模型（解决 codex 0.140 不支持 DeepSeek 的问题）
RUN npm install -g @anthropic-ai/claude-code @openai/codex @musistudio/claude-code-router && npm cache clean --force

# 复用基础镜像自带的非 root 用户 node (uid/gid 1000)，避免再 groupadd/useradd 冲突
# 工作区、Agent 目录、以及凭证持久化目录（挂载点）
RUN mkdir -p /workspace /opt/agent \
    /home/node/.claude /home/node/.codex /home/node/.config && \
    chown -R node:node /workspace /opt/agent /home/node

# 复制 Sandbox Agent 源码（不复制 node_modules，容器内重新编译 node-pty）
COPY --chown=node:node agent/package.json agent/package-lock.json* /opt/agent/
COPY --chown=node:node agent/src /opt/agent/src

USER node
WORKDIR /opt/agent
# 显式走官方 registry（避免 lock 里残留的镜像源在海外服务器解析失败）
RUN npm install --only=production --registry=https://registry.npmjs.org/ --no-audit --no-fund && npm cache clean --force

# 运行环境变量（SANDBOX_TOKEN 由编排器在创建容器时按项目注入）
ENV CONDUIT_URL=ws://host.docker.internal:8080
ENV WORKSPACE_DIR=/workspace
ENV SANDBOX_IN_CONTAINER=1

WORKDIR /workspace
EXPOSE 3000-3010

ENTRYPOINT ["node", "/opt/agent/src/index.js"]
