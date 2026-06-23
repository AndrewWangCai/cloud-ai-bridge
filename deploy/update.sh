#!/usr/bin/env bash
# 一键更新：git pull → 装依赖 → 重建镜像 → 重启 Conduit。
# 用「普通用户」运行（不要 sudo；git pull 需要你的部署密钥，重启服务时脚本内部自动用 sudo）：
#   bash deploy/update.sh
# 选项： SKIP_BUILD=1 跳过镜像重建（仅改了后端/前端时更快）
#        SKIP_PULL=1  跳过 git pull（本地已是最新）
# 注：改了 agent/镜像后，现有容器仍用旧镜像；让某容器用新镜像需 docker rm -f <容器> 后重新【激活】。
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
IMAGE="sandbox-image:latest"

step(){ echo -e "\n\033[36m==> $*\033[0m"; }
die(){ echo -e "\033[31m错误：$*\033[0m"; exit 1; }

# 1) 拉取最新代码
if [ "${SKIP_PULL:-0}" = "1" ]; then
  step "跳过 git pull（SKIP_PULL=1）"
elif [ -d .git ]; then
  step "git pull"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "  ⚠️ 工作区有未提交改动，可能导致 pull 冲突："
    git status --short
  fi
  git pull --ff-only || die "git pull 失败（可能有本地改动/冲突），请手动处理后重试"
else
  step "非 git 仓库，跳过 pull（请手动同步代码）"
fi

# 2) 依赖（package.json 变了才需要，但跑一遍很快/幂等）
step "安装依赖 (npm run install-all)"
npm run install-all || die "依赖安装失败"

# 3) 重建沙箱镜像（Docker 层缓存命中时很快；只影响之后新建的容器）
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  step "跳过镜像重建（SKIP_BUILD=1）"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  step "重建镜像 $IMAGE"
  docker build -t "$IMAGE" "$HERE/sandbox" || die "镜像构建失败"
else
  step "Docker 不可用，跳过镜像重建"
fi

# 4) 重启 Conduit（systemd 优先，pm2 兜底）
step "重启 Conduit"
if [ -f /etc/systemd/system/conduit.service ]; then
  sudo systemctl restart conduit && echo "  systemd: conduit 已重启"
  sudo systemctl --no-pager --lines=5 status conduit || true
elif command -v pm2 >/dev/null 2>&1 && pm2 describe conduit >/dev/null 2>&1; then
  pm2 restart conduit && echo "  pm2: conduit 已重启"
else
  echo "  ⚠️ 未找到 conduit 的 systemd/pm2 服务，请手动重启 Conduit。"
fi

echo -e "\n\033[32m✅ 更新完成。\033[0m"
echo "提示：Conduit 重启后内存会话清空（用户需重新登录）；正在运行的用户容器会自动重连，无需重建。"
echo "      新镜像仅对之后【激活并连接】新建的容器生效；要让现有容器用新镜像，需在后台/CLI 销毁后重启。"
