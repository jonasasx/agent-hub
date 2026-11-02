# Выкладка сборки Agent Hub desktop в ленту обновлений хаба (design D16).
# Порядок: установщик и blockmap -> latest.yml под временным именем -> mv. Лента меняется атомарно и только
# после того, как установщик уже лежит на хабе. Секретов скрипт не требует (ssh-ключ пользователя).
#
# Запуск из корня репозитория после `npm run dist -w desktop`:
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\publish-update.ps1 -Target user@hub-host [-RemoteDir /home/user/agent-hub/desktop-updates]
param(
  [Parameter(Mandatory)][string]$Target,
  [string]$RemoteDir = '/home/ubuntu/agent-hub/desktop-updates'
)
$ErrorActionPreference = 'Stop'

$desktop = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content -Raw -Encoding UTF8 (Join-Path $desktop 'package.json') | ConvertFrom-Json
$version = $pkg.version
$release = Join-Path $desktop 'release'
$exe = Join-Path $release "Agent-Hub-Setup-$version.exe"
$blockmap = "$exe.blockmap"
$latest = Join-Path $release 'latest.yml'

foreach ($f in @($exe, $blockmap, $latest)) {
  if (-not (Test-Path $f)) { throw "Нет файла $f — сначала npm run dist -w desktop" }
}
$feedVersion = (Select-String -Path $latest -Pattern '^version:\s*(\S+)').Matches[0].Groups[1].Value
if ($feedVersion -ne $version) { throw "latest.yml описывает $feedVersion, а package.json — $version" }

function Invoke-Native([string]$exePath, [string[]]$arguments) {
  & $exePath @arguments
  if ($LASTEXITCODE -ne 0) { throw "$exePath $($arguments -join ' ') -> код $LASTEXITCODE" }
}

$tmpName = "latest.yml.tmp-$([guid]::NewGuid().ToString('N'))"
Write-Host "Выкладка $version на ${Target}:$RemoteDir"
Invoke-Native 'ssh' @($Target, "mkdir -p '$RemoteDir'")
Invoke-Native 'scp' @($exe, $blockmap, "${Target}:$RemoteDir/")
Invoke-Native 'scp' @($latest, "${Target}:$RemoteDir/$tmpName")
Invoke-Native 'ssh' @($Target, "mv -f '$RemoteDir/$tmpName' '$RemoteDir/latest.yml' && ls -la '$RemoteDir'")
Write-Host "Готово: лента отдаёт $version (GET /api/desktop/updates/latest.yml с cookie ah_session)"
