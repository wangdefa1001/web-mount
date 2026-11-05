#!/usr/bin/env bash
# 用一个新版本的 zip 更新当前插件目录，并提交（可选自动推送）。
# 用法： bash scripts/publish.sh <web-mount.zip> ["提交说明"]
#
# 做的事：
#   1. 备份本地 config/config.json（zip 里是示例配置，不能覆盖线上配置）
#   2. 解压 zip 覆盖到插件目录
#   3. 还原 config/config.json
#   4. git add / commit
#   5. 尝试 git push（没配凭据就只提交，提示你手动推）

set -e

ZIP="${1:-}"
MSG="${2:-}"
if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then
  echo "用法: bash scripts/publish.sh <web-mount.zip> [\"提交说明\"]"
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v git >/dev/null 2>&1 || { echo "缺少 git，请先安装"; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "缺少 unzip，请先安装：pacman -S unzip / pkg install unzip"; exit 1; }
[ -d .git ] || { echo "当前目录不是 git 仓库，先执行： bash scripts/init-repo.sh"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1) 备份线上配置
if [ -f config/config.json ]; then
  cp config/config.json "$TMP/config.json"
  echo "==> 已备份本地 config/config.json"
fi

# 2) 解压
unzip -q -o "$ZIP" -d "$TMP/src"
SRC="$TMP/src/web-mount"
[ -d "$SRC" ] || SRC="$TMP/src"
[ -f "$SRC/index.js" ] || { echo "zip 里没找到 index.js，确认下压缩包结构"; exit 1; }

# 3) 覆盖（不动本地 config.json）
( cd "$SRC" && tar cf - --exclude=config/config.json . ) | tar xf - -C "$ROOT"
echo "==> 文件已覆盖"

# 4) 还原配置
if [ -f "$TMP/config.json" ]; then
  cp "$TMP/config.json" config/config.json
  echo "==> 已还原本地 config/config.json"
fi

# 5) 提交
git add -A
if git diff --cached --quiet; then
  echo "==> 内容没有变化，跳过提交"
  exit 0
fi

VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -1)"
git commit -m "${MSG:-更新到 ${VER:-latest}}"
git --no-pager log --oneline -1

# 6) 尝试推送
echo
echo "==> 尝试推送…"
if GIT_TERMINAL_PROMPT=0 git push 2>/dev/null; then
  echo "==> 已推送到 GitHub"
else
  echo "==> 推送未成功（多半是没配凭据）。本地已提交，稍后手动执行："
  echo "    git push"
fi

echo
echo "提示：插件文件已更新，若 Yunzai 正在运行，重启一次或等热重载生效。"
