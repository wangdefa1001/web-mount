#!/usr/bin/env bash
# 把当前插件目录接到 GitHub 仓库上（只为拿到 .git），并把现有文件作为一次提交。
# 用法： bash scripts/init-repo.sh [远程地址]
# 场景：插件目录是解压出来的、还不是 git 仓库，想以后用 git 管理。

set -e

REMOTE="${1:-https://github.com/wangdefa1001/web-mount.git}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v git >/dev/null 2>&1 || { echo "缺少 git，请先安装：pacman -S git / pkg install git"; exit 1; }

if [ -d .git ]; then
  echo "==> 这里已经是 git 仓库，跳过初始化"
else
  echo "==> 克隆远端以取得 .git（不会动你现在的文件）"
  TMP="$(mktemp -d)"
  git clone --quiet "$REMOTE" "$TMP/repo"
  mv "$TMP/repo/.git" "$ROOT/.git"
  rm -rf "$TMP"
  # 本地配置不入库
  if [ -f .gitignore ] && ! grep -q '^config/config\.json' .gitignore; then
    echo "config/config.json" >> .gitignore
  fi
  echo "==> .git 已就位"
fi

VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -1)"
git add -A
if git diff --cached --quiet; then
  echo "==> 没有变化，无需提交"
  exit 0
fi

git -c user.name="${GIT_AUTHOR_NAME:-wangdefa1001}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-wangdefa1001@users.noreply.github.com}" \
    commit -m "更新到 ${VER:-latest}"

echo
git --no-pager log --oneline -1
echo
echo "==> 已提交。推送到 GitHub："
echo "    git push -u origin main"
echo
echo "第一次推送会要求输入用户名和密码 —— 密码请填 Personal Access Token，不是账号密码。"
