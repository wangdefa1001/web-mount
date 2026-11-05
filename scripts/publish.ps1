# 用新版本的 zip 更新当前仓库目录并提交（Windows 版）。
# 用法： .\scripts\publish.ps1 D:\Downloads\web-mount.zip "更新到 v1.5.0"
param(
  [Parameter(Mandatory = $true)][string]$Zip,
  [string]$Message = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path (Join-Path $Root ".git"))) {
  throw "当前目录不是 git 仓库。先在仓库根执行 git clone，或参考 README 的「更新与发布」。"
}
if (-not (Test-Path $Zip)) { throw "找不到 zip：$Zip" }

$tmp = Join-Path $env:TEMP ("wm-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null

$conf = Join-Path $Root "config\config.json"
$hasConf = Test-Path $conf
if ($hasConf) {
  Copy-Item $conf (Join-Path $tmp "config.json") -Force
  Write-Host "==> 已备份本地 config.json"
}

Expand-Archive -Path $Zip -DestinationPath (Join-Path $tmp "src") -Force
$src = Join-Path $tmp "src\web-mount"
if (-not (Test-Path $src)) { $src = Join-Path $tmp "src" }
if (-not (Test-Path (Join-Path $src "index.js"))) { throw "zip 里没找到 index.js，确认压缩包结构" }

Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($src.Length).TrimStart('\')
  if ($rel -eq "config\config.json") { return }
  $dest = Join-Path $Root $rel
  $dir = Split-Path -Parent $dest
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Copy-Item $_.FullName $dest -Force
}
Write-Host "==> 文件已覆盖"

if ($hasConf) {
  Copy-Item (Join-Path $tmp "config.json") $conf -Force
  Write-Host "==> 已还原本地 config.json"
}

git add -A
$staged = git diff --cached --name-only
if (-not $staged) {
  Write-Host "==> 内容没有变化，跳过提交"
  Remove-Item -Recurse -Force $tmp
  exit 0
}

if (-not $Message) { $Message = "更新 $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
git commit -m $Message
git log --oneline -1

Write-Host ""
Write-Host "==> 本地已提交，推送："
Write-Host "    git push"

Remove-Item -Recurse -Force $tmp
