#!/usr/bin/env bash
# 在「东京沙箱服务器」上以 root 运行，限制所有 Docker 容器的出网，防止滥用 / 窃取云元数据。
# 幂等：重复运行不会重复插入规则。
# 注意：这是宿主机 iptables 规则，不在平台代码里——属于部署加固。
set -euo pipefail

ins() {  # ins <rule...>  —— 不存在才插入到 DOCKER-USER 链
  if ! iptables -C DOCKER-USER "$@" 2>/dev/null; then
    iptables -I DOCKER-USER "$@"
    echo "  + inserted: $*"
  else
    echo "  = exists:   $*"
  fi
}

echo "[harden] 元数据 169.254.169.254：放行 DNS(53)，仅封 HTTP 元数据（防窃取 GCP 令牌）"
# 注意：GCP 的 DNS 解析器也在 169.254.169.254 上（与元数据同 IP）。若全量 DROP 会把容器 DNS 一起堵死，
# 导致容器无法解析任何域名（构建/运行都报 EAI_AGAIN）。所以必须放行 53，只封其余(主要是 80 的元数据 API)。
# ins 用 -I(顶部插入)，因此先插 DROP、再插 ACCEPT，最终 ACCEPT 在 DROP 之上、优先生效。
ins -d 169.254.169.254 -j DROP
ins -d 169.254.169.254 -p udp --dport 53 -j ACCEPT
ins -d 169.254.169.254 -p tcp --dport 53 -j ACCEPT

echo "[harden] 阻止容器外发 SMTP（防垃圾邮件滥用）"
ins -p tcp --dport 25  -j DROP
ins -p tcp --dport 465 -j DROP
ins -p tcp --dport 587 -j DROP

# ---------------------------------------------------------------------------
# 可选：阻断容器访问宿主内网 RFC1918（默认注释，谨慎开启）。
# 风险：agent 需要经 host.docker.internal(宿主网关) 连回 Conduit；若全量 DROP 172.16/12
# 会切断这条链路。开启前请先 ACCEPT 宿主网关 IP + Conduit 端口(8080)，再 DROP 其余。
#
#   HOST_GW=172.18.0.1            # 改成 ai-sandbox-net 的网关 IP（docker network inspect 查）
#   ins -d "$HOST_GW" -p tcp --dport 8080 -j ACCEPT
#   ins -d 10.0.0.0/8     -j DROP
#   ins -d 172.16.0.0/12  -j DROP
#   ins -d 192.168.0.0/16 -j DROP
# ---------------------------------------------------------------------------

echo "[harden] 完成。持久化：apt-get install -y iptables-persistent && netfilter-persistent save"
