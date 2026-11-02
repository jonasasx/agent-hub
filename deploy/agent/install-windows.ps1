# Installs or updates the Agent Hub agent on Windows (X1, HP) — design.md D17.
# Registers the scheduled task "Agent Hub Agent": at startup, LogonType S4U under the current user
# (works after a reboot without logon), no execution time limit. The task runs `node supervisor.mjs`,
# which forks the agent over IPC: Stop-ScheduledTask terminates the supervisor and the agent exits with it;
# a crashed agent is restarted by the supervisor after 5 s.
#
# Run from an elevated PowerShell in the repository root after
# `npm ci; npm run build -w shared; npm run build -w agent`:
#   powershell -ExecutionPolicy Bypass -File deploy\agent\install-windows.ps1 -HubUrl wss://<hub>/ws/agent  # first install: asks for the token
#   powershell -ExecutionPolicy Bypass -File deploy\agent\install-windows.ps1                  # update, keeps agent.env
#   powershell -ExecutionPolicy Bypass -File deploy\agent\install-windows.ps1 -NewToken        # replace the token (hidden input)
#   powershell -ExecutionPolicy Bypass -File deploy\agent\install-windows.ps1 -Uninstall
# The token comes from Vaultwarden «Agent Hub — agent token <id>»; it is written only to agent.env (ACL: this user).
param(
    [string]$Token,
    [string]$HubUrl = '',
    [string]$VaultRoot = "$env:USERPROFILE\vault",
    [string]$Source = (Join-Path $PSScriptRoot '..\..\agent\dist'),
    # The account as DOMAIN\user or COMPUTER\user. Not $env:USERDOMAIN: in an SSH session it is WORKGROUP and
    # Register-ScheduledTask fails with 0x80070534 (found on X1).
    [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
    # Overrides for a trial install next to the real one (tests); defaults are the production values.
    [string]$TaskName = 'Agent Hub Agent',
    [string]$State = (Join-Path $env:USERPROFILE '.agent-hub'),
    # Ask for a new token even if agent.env exists (after `runner:token` reissued it).
    [switch]$NewToken,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$App = Join-Path $State 'app'
$EnvFile = Join-Path $State 'agent.env'

$principalCheck = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell (registering an S4U task needs administrator rights).'
}

# Stops the task and every process started from the app directory: supervisor/agent node processes and,
# from installs before the supervisor, the run-agent.cmd loop. Otherwise two agents with one token would
# keep replacing each other (4409).
function Stop-Agent {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName }
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe'" |
        # Windows paths are case-insensitive: the command line may spell the user directory differently.
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($App, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
    Stop-Agent
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Task '$TaskName' removed. $State is kept (agent.env, logs)."
    return
}

$node = (Get-Command node -ErrorAction Stop).Source
$nodeMajor = [int]((& $node -p 'process.versions.node').Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node.js 22+ required, found $nodeMajor (winget install OpenJS.NodeJS.LTS)" }
$Source = (Resolve-Path $Source).Path
if (-not (Test-Path (Join-Path $Source 'agent.mjs'))) { throw "No agent build in $Source (npm run build -w agent)" }

Stop-Agent

New-Item -ItemType Directory -Force -Path $App | Out-Null
foreach ($f in 'agent.mjs', 'agent.mjs.map', 'supervisor.mjs', 'supervisor.mjs.map', 'package.json', 's4u-check.mjs') {
    Copy-Item -Force (Join-Path $Source $f) (Join-Path $App $f)
}
Push-Location $App
try {
    & npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed in $App" }
}
finally { Pop-Location }

# The previous launcher (cmd loop) is replaced by supervisor.mjs.
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $App 'run-agent.cmd')

if (-not $Token -and ($NewToken -or -not (Test-Path $EnvFile))) {
    # Hidden input: the token never lands in the shell history or on the command line.
    $secure = Read-Host -AsSecureString 'Agent token (Vaultwarden «Agent Hub — agent token <id>»)'
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if (-not $Token) { throw 'No token entered.' }
}
if ($Token) {
    if (-not $HubUrl -and (Test-Path $EnvFile)) {
        $HubUrl = (Get-Content $EnvFile | Where-Object { $_ -like 'HUB_URL=*' } | Select-Object -First 1) -replace '^HUB_URL=', ''
    }
    if (-not $HubUrl) { throw 'A new token needs -HubUrl wss://<hub>/ws/agent.' }
    @(
        "HUB_URL=$HubUrl"
        "AGENT_TOKEN=$Token"
        "VAULT_ROOT=$VaultRoot"
    ) | Set-Content -Path $EnvFile -Encoding Ascii
}
# Only this user (and nobody else, administrators included) can read the token.
& icacls $EnvFile /inheritance:r /grant:r "${env:USERNAME}:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed for $EnvFile" }

$supervisor = Join-Path $App 'supervisor.mjs'
$action = New-ScheduledTaskAction -Execute $node -Argument "--env-file=`"$EnvFile`" `"$supervisor`"" -WorkingDirectory $App
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
# Restart-on-failure (999 is the Task Scheduler maximum) covers the supervisor; the agent itself is
# restarted by the supervisor. ExecutionTimeLimit 0 = no limit.
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5

$task = Get-ScheduledTask -TaskName $TaskName
Write-Output "Task '$TaskName': $($task.State), logon type $($task.Principal.LogonType), user $($task.Principal.UserId)"
$log = Join-Path $State 'agent.log'
if (Test-Path $log) { Get-Content $log -Tail 5 }
