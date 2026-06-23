# Git 指南：把代码保存到你自己的仓库

沙箱是**临时**的，到期会清理。务必用 Git 把代码推到你自己的仓库（GitHub/GitLab 等）。

## 最快方式：GitHub 一键（OAuth）
如果管理员配置了 GitHub OAuth，【配置】抽屉里会有「GitHub 一键」：
1. 点【用 GitHub 连接】→ 跳到 GitHub 授权 → 同意后自动回来（显示 `已连接：@你的用户名`）。
2. 想要新仓库：填仓库名 →【建仓】，会自动创建并填好 PR 目标。
3. 点【🚀 一键提交并开 PR】：平台在云端帮你 `commit → push` 到一个分支，并开好 Pull Request，返回链接。

> 安全：你的 GitHub 授权令牌只存在平台服务端，**不进沙箱容器、不回显**；push 用临时带令牌的地址，**不会**写进工作区的 `.git/config`。随时可【断开 GitHub】。

### 管理员：如何启用 GitHub 一键
在 GitHub 注册一个 OAuth App（Settings → Developer settings → OAuth Apps → New OAuth App）：
- **Homepage URL**：`https://你的域名`
- **Authorization callback URL**：`https://你的域名/api/github/oauth/callback`

把 `client id/secret` 填进 `conduit.env` 的 `GITHUB_OAUTH_CLIENT_ID/SECRET`，并设 `PUBLIC_BASE_URL=https://你的域名`，重启 conduit。不配置则该功能自动隐藏，用户仍可用下面的手动命令。

## 手动方式一：Git 助手（一键复制命令）
【配置】抽屉底部有「Git 助手」：
1. 在输入框填你的仓库地址，如 `https://github.com/你/你的仓库.git`。
2. 点【🔄 刷新】：显示当前分支、远程、未提交改动数，并生成对应命令。
3. 点【📋 复制全部 Git 命令】，到终端粘贴执行即可。

Git 助手是**只读**的：它只看状态、生成命令，**不保存你的 token、也不替你 push**（更安全）。

## 手动命令

### 第一次推送（新仓库）
```bash
git init
git add .
git commit -m "update"
git branch -M main
git remote add origin https://github.com/你/你的仓库.git
git push -u origin main
```

### 之后每次更新
```bash
git add .
git commit -m "update"
git push
```

### 拉取最新
```bash
git pull origin main
```

## 免密推送（绑定 GitHub）
在【配置】→「绑定 GitHub」填用户名 + PAT（需 repo 权限），平台会配置 git 凭证，`push/pull` 免密。

> PAT 获取：GitHub → Settings → Developer settings → Personal access tokens。最小权限给 `repo`。

## 提醒
- **到期前一定要 push**，否则保留期过后代码会被销毁。
- 备份保留期内即使容器停了，也可以恢复后再 push，见 [expiration-backup.md](expiration-backup.md)。
- 平台**不**默认拿你的 GitHub token，也不自动 push；自动备份需你显式授权（后续功能）。
