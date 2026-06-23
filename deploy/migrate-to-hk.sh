#!/usr/bin/env bash
# 一键把东京实例整机克隆到香港(asia-east2)。
# 用法（建议在 GCP Cloud Shell 跑，gcloud 已就绪）：
#   gcloud config set project <你的项目ID>
#   bash deploy/migrate-to-hk.sh
# 可用环境变量覆盖默认值（见下）。注意：会先「停止」东京机以保证数据一致 → 有停机时间。
set -euo pipefail

SRC_INSTANCE="${SRC_INSTANCE:-ai-sandbox-tokyo}"   # 改成你的源实例名（或用环境变量覆盖）
SRC_ZONE="${SRC_ZONE:-asia-northeast1-a}"
DST_INSTANCE="${DST_INSTANCE:-ai-sandbox-hk-01}"
DST_ZONE="${DST_ZONE:-asia-east2-a}"          # 香港
DST_REGION="${DST_REGION:-asia-east2}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-4}"
IMAGE_NAME="${IMAGE_NAME:-sandbox-img-$(date +%Y%m%d-%H%M%S)}"
IP_NAME="${IP_NAME:-sandbox-hk-ip}"

echo "==> 1/4 停止源实例 $SRC_INSTANCE（保证磁盘一致；有停机）"
gcloud compute instances stop "$SRC_INSTANCE" --zone="$SRC_ZONE"

echo "==> 2/4 创建整机映像 $IMAGE_NAME（含系统+/opt/ai-sandbox 全部数据+Docker 镜像）"
gcloud compute machine-images create "$IMAGE_NAME" \
  --source-instance="$SRC_INSTANCE" --source-instance-zone="$SRC_ZONE"

echo "==> 3/4 预留香港静态外网 IP（已存在则复用）"
gcloud compute addresses create "$IP_NAME" --region="$DST_REGION" >/dev/null 2>&1 || true
HK_IP="$(gcloud compute addresses describe "$IP_NAME" --region="$DST_REGION" --format='value(address)')"
echo "    香港静态 IP = $HK_IP"

echo "==> 4/4 用映像在香港($DST_ZONE)新建实例 $DST_INSTANCE"
gcloud compute instances create "$DST_INSTANCE" \
  --source-machine-image="$IMAGE_NAME" \
  --zone="$DST_ZONE" --machine-type="$MACHINE_TYPE" \
  --address="$HK_IP"

cat <<EOF

✅ 克隆完成。香港新机：$DST_INSTANCE  公网 IP：$HK_IP

收尾（仍需手动，脚本不便代劳）：
  1) DNS：把域名 A 记录指到 $HK_IP（没域名就直接用 IP）
  2) ssh 进新机：sudo bash /opt/ai-sandbox/app/deploy/harden-network.sh   # iptables 出网加固重跑
  3) 编辑 /opt/ai-sandbox/secrets/conduit.env：PUBLIC_BASE_URL / GITHUB_OAUTH_CALLBACK 改成新域名
     （并在 GitHub OAuth App 后台同步回调 URL）
  4) sudo systemctl restart conduit  → 浏览器注册/登录/建项目/激活 做冒烟验证
  5) 确认无误后：删东京实例 $SRC_INSTANCE 和映像 $IMAGE_NAME 省钱
     （若验证失败，东京机还在，重启它即可回滚）

防火墙：VPC 放行 80/443 的规则是全网生效，新机自动适用（确认新机带相同网络标签）。
EOF
