#!/usr/bin/env bash
# 在「东京沙箱服务器」上真 Docker 验证：构建镜像 → 起一个加固容器 → inspect 核对安全参数
# → 确认 claude/codex/node/git 就位 →（可选）出网/元数据测试 → 清理。
# 用法： bash deploy/verify-docker.sh         （首次会构建镜像）
#        SKIP_BUILD=1 bash deploy/verify-docker.sh
set -uo pipefail

IMAGE="sandbox-image:latest"
NET="${SANDBOX_NETWORK:-ai-sandbox-net}"
NAME="sandbox_verify_$$"
WS="$(mktemp -d)"
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # 仓库根目录
FAILS=0

green(){ echo -e "  \033[32mPASS\033[0m $*"; }
red(){ echo -e "  \033[31mFAIL\033[0m $*"; FAILS=$((FAILS+1)); }
have(){ command -v "$1" >/dev/null 2>&1; }
# check <描述> <实际值> <期望子串>
check(){ if echo "$2" | grep -q -- "$3"; then green "$1 -> $2"; else red "$1 (实际: '$2' 期望含: '$3')"; fi; }

cleanup(){ docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "$WS" 2>/dev/null; }
trap cleanup EXIT

echo "==> 0. 前置检查"
have docker || { echo "缺少 docker"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker 守护进程不可用（sudo? 在 docker 组?）"; exit 1; }
green "docker 可用：$(docker --version)"

echo "==> 1. 构建镜像"
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "  跳过构建（SKIP_BUILD=1）"
else
  docker build -t "$IMAGE" "$HERE/sandbox" || { echo "镜像构建失败"; exit 1; }
fi
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "镜像不存在：$IMAGE"; exit 1; }
green "镜像就绪：$IMAGE"

echo "==> 2. 确保网络 $NET"
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --driver bridge "$NET" >/dev/null
green "网络就绪：$NET"

echo "==> 3. 起一个加固容器（参数与编排器一致；entrypoint 改 sleep 便于检查）"
docker run -d --name "$NAME" \
  --network "$NET" \
  --memory=1g --memory-swap=1g \
  --cpus=1 \
  --pids-limit=256 \
  --restart=no \
  --security-opt=no-new-privileges:true \
  --cap-drop=ALL \
  -v "$WS":/workspace \
  --entrypoint sleep \
  "$IMAGE" infinity >/dev/null || { echo "容器启动失败"; exit 1; }
green "容器已启动：$NAME"

echo "==> 4. inspect 核对安全加固"
check "Memory=1GB"          "$(docker inspect -f '{{.HostConfig.Memory}}' "$NAME")"        "1073741824"
check "MemorySwap=1GB(禁swap)" "$(docker inspect -f '{{.HostConfig.MemorySwap}}' "$NAME")"  "1073741824"
check "NanoCpus=1"          "$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$NAME")"       "1000000000"
check "PidsLimit=256"       "$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$NAME")"      "256"
check "CapDrop=ALL"         "$(docker inspect -f '{{.HostConfig.CapDrop}}' "$NAME")"        "ALL"
check "no-new-privileges"   "$(docker inspect -f '{{.HostConfig.SecurityOpt}}' "$NAME")"    "no-new-privileges"
check "NetworkMode=$NET"    "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$NAME")"    "$NET"
check "RestartPolicy=no"    "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$NAME")" "no"
# 红线：绝不应出现
PRIV="$(docker inspect -f '{{.HostConfig.Privileged}}' "$NAME")"
[ "$PRIV" = "false" ] && green "Privileged=false" || red "Privileged 必须为 false（实际 $PRIV）"
BINDS="$(docker inspect -f '{{.HostConfig.Binds}}' "$NAME")"
echo "$BINDS" | grep -q "docker.sock" && red "检测到挂载 docker.sock（危险！）" || green "未挂载 docker.sock"
echo "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$NAME")" | grep -qx "host" && red "NetworkMode=host（危险！）" || green "未使用 host 网络"

echo "==> 5. 镜像内 AI 工具与运行时"
check "node"  "$(docker exec "$NAME" sh -lc 'node --version' 2>&1)"        "v"
check "git"   "$(docker exec "$NAME" sh -lc 'git --version' 2>&1)"         "git version"
check "claude (Claude Code)" "$(docker exec "$NAME" sh -lc 'command -v claude || echo MISSING' 2>&1)" "claude"
check "codex"                "$(docker exec "$NAME" sh -lc 'command -v codex  || echo MISSING' 2>&1)" "codex"
check "agent 源码"            "$(docker exec "$NAME" sh -lc 'ls /opt/agent/src/index.js' 2>&1)"        "index.js"
check "非 root 用户"          "$(docker exec "$NAME" sh -lc 'whoami' 2>&1)"                            "node"

echo "==> 6. 出网/元数据（需先跑 deploy/harden-network.sh 才会拦截元数据）"
META="$(docker exec "$NAME" sh -lc 'curl -s -m 3 -o /dev/null -w "%{http_code}" http://169.254.169.254/ 2>/dev/null; echo "(exit=$?)"' 2>&1)"
if echo "$META" | grep -q "exit=0" && ! echo "$META" | grep -q "000"; then
  red "容器可访问云元数据 169.254.169.254（请运行 deploy/harden-network.sh 阻断）-> $META"
else
  green "云元数据不可达（已加固或网络隔离）-> $META"
fi
NET_OUT="$(docker exec "$NAME" sh -lc 'curl -s -m 5 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/ 2>/dev/null; echo " (exit=$?)"' 2>&1)"
check "可访问公网(npm registry)" "$NET_OUT" "200"

echo ""
if [ "$FAILS" -eq 0 ]; then
  echo -e "\033[32m✅ 全部验证通过。容器加固与镜像内容符合预期。\033[0m"
  exit 0
else
  echo -e "\033[31m❌ 有 $FAILS 项未通过，请按上面提示修复。\033[0m"
  exit 1
fi
