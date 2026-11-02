# Agent Hub: connect this Windows machine (change `multi-user`, design M5, spec runner-enrollment «Установщик»).
# The hub serves this file at /install.ps1 with __HUB_URL__ replaced by its public address; the window
# «Подключить машину» shows:
#   irm https://hub.example.com/install.ps1 | iex; Install-AgentHub <code>
# Remove:
#   irm https://hub.example.com/install.ps1 | iex; Uninstall-AgentHub
# Everything goes to %USERPROFILE%\.agent-hub (Node, agent, agent.env with an ACL of this user only, logs,
# bin\agent-hub.cmd); `claude` comes from its official installer. Autostart is the scheduled task "Agent Hub Agent":
# at startup, LogonType S4U under the current user (works after a reboot without logon), no time limit; it runs
# `node supervisor.mjs`, which forks the agent over IPC and restarts it (design D17). Only registering the task needs
# administrator rights: the installer asks for elevation (UAC) for that step alone. If the S4U task does not start
# within 20 s or fails to log on (a domain account without a domain controller), it is re-registered at logon of this user (Interactive).
# A trial install next to the real one: Install-AgentHub <code> -TaskName 'Agent Hub Agent TEST' -State <dir>.

function Install-AgentHub {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)][string]$Code,
        [string]$HubUrl = $(if ($env:AGENT_HUB_URL) { $env:AGENT_HUB_URL } else { '__HUB_URL__' }),
        [string]$State = (Join-Path $env:USERPROFILE '.agent-hub'),
        [string]$TaskName = 'Agent Hub Agent',
        # DOMAIN\user or COMPUTER\user; not $env:USERDOMAIN (WORKGROUP over SSH, 0x80070534 on X1).
        [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
        [string]$NodeDist = $(if ($env:AGENT_HUB_NODE_DIST) { $env:AGENT_HUB_NODE_DIST } else { 'https://nodejs.org/dist/latest-v22.x' }),
        [int]$WaitSec = 40
    )
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-AgentHubInstall -Code $Code -HubUrl $HubUrl -State $State -TaskName $TaskName -User $User -NodeDist $NodeDist -WaitSec $WaitSec
    }
    catch {
        Write-Host ''
        Write-Host "Ошибка: $($_.Exception.Message)" -ForegroundColor Red
        $global:LASTEXITCODE = 1
    }
}

function Uninstall-AgentHub {
    [CmdletBinding()]
    param(
        [string]$State = (Join-Path $env:USERPROFILE '.agent-hub'),
        [string]$TaskName = 'Agent Hub Agent'
    )
    $ErrorActionPreference = 'Stop'
    try {
        $app = Join-Path $State 'app'
        Invoke-AgentHubElevated -State $State -Name 'unregister' -Body @"
`$t = Get-ScheduledTask -TaskName $(Format-AgentHubLiteral $TaskName) -ErrorAction SilentlyContinue
if (`$t) {
    Stop-ScheduledTask -TaskName $(Format-AgentHubLiteral $TaskName) -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $(Format-AgentHubLiteral $TaskName) -Confirm:`$false
}
"@
        Stop-AgentHubProcesses -App $app
        Start-Sleep -Seconds 1
        if (Test-Path $State) { Remove-Item -Recurse -Force $State }
        Write-Host "Агент Agent Hub удалён (задача '$TaskName', $State). ~\.claude и транскрипты сессий не тронуты."
        $global:LASTEXITCODE = 0
    }
    catch {
        Write-Host "Ошибка: $($_.Exception.Message)" -ForegroundColor Red
        $global:LASTEXITCODE = 1
    }
}

# ---------- helpers ----------

function Format-AgentHubLiteral([string]$s) { "'" + $s.Replace("'", "''") + "'" }

function Write-AgentHubStep([string]$s) { Write-Host ''; Write-Host "==> $s" -ForegroundColor Cyan }

# Every node.exe / cmd.exe started from the app directory (supervisor, agent, the cmd loop of old installs).
function Stop-AgentHubProcesses([string]$App) {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($App, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# Runs a generated script with administrator rights: in a child PowerShell when this one is elevated, otherwise
# through UAC (Start-Process -Verb RunAs). The script writes 'ok' or the error into <State>\<Name>.result.
function Invoke-AgentHubElevated([string]$State, [string]$Name, [string]$Body) {
    New-Item -ItemType Directory -Force -Path $State | Out-Null
    $file = Join-Path $State "$Name.ps1"
    $result = Join-Path $State "$Name.result"
    Remove-Item -Force -ErrorAction SilentlyContinue $result
    $text = @"
`$ErrorActionPreference = 'Stop'
try {
$Body
    'ok' | Set-Content -Encoding UTF8 -Path $(Format-AgentHubLiteral $result)
}
catch { `$_.Exception.Message | Set-Content -Encoding UTF8 -Path $(Format-AgentHubLiteral $result) }
"@
    # UTF-8 with BOM: Windows PowerShell 5.1 reads a file without BOM in the ANSI code page (paths may be Cyrillic).
    [IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding $true))
    $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$file`"")
    $admin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($admin) {
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs -Wait -PassThru -NoNewWindow
    }
    else {
        Write-Host 'Нужны права администратора для задачи планировщика — подтвердите запрос Windows.'
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs -Verb RunAs -Wait -PassThru -WindowStyle Hidden
    }
    $null = $p
    $r = if (Test-Path $result) { (Get-Content -Raw -Encoding UTF8 $result).Trim() } else { 'не выполнено (запрос прав отклонён?)' }
    Remove-Item -Force -ErrorAction SilentlyContinue $file, $result
    if ($r -ne 'ok') { throw "шаг с правами администратора не прошёл: $r" }
}

# A native command at statement level (output straight to the console: `claude setup-token` stays interactive).
# Windows PowerShell 5.1 turns stderr of a native command into errors under ErrorActionPreference Stop: Continue here.
function Invoke-AgentHubNative {
    param([string]$Exe, [string[]]$ArgList)
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @ArgList | Out-Host; return $LASTEXITCODE }
    finally { $ErrorActionPreference = $old }
}

function Get-AgentHubSha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant() }

function Find-AgentHubClaude {
    $c = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Source }
    $p = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path $p) { return $p }
    return $null
}

function Invoke-AgentHubInstall {
    param([string]$Code, [string]$HubUrl, [string]$State, [string]$TaskName, [string]$User, [string]$NodeDist, [int]$WaitSec)
    $HubUrl = $HubUrl.TrimEnd('/')
    if ($HubUrl.StartsWith('__')) { throw 'адрес хаба не подставлен; скопируйте команду из окна «Подключить машину»' }
    if ($HubUrl -notmatch '^https?://') { throw "неверный адрес хаба: $HubUrl" }
    if (-not $Code) { throw 'нет кода подключения: скопируйте команду из окна «Подключить машину» в браузере' }
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw "архитектура $($env:PROCESSOR_ARCHITECTURE) не поддерживается" } }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $app = Join-Path $State 'app'
    $envFile = Join-Path $State 'agent.env'
    $tmp = Join-Path $State ("install." + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $State, $tmp | Out-Null
    $prevHome = $env:AGENT_HUB_HOME
    $env:AGENT_HUB_HOME = $State
    try {
        Write-Host "Agent Hub: подключение машины $env:COMPUTERNAME (windows $arch) к $HubUrl"

        # ---- the hub is reachable (spec «Машина не достаёт хаб») ----
        Write-AgentHubStep 'Проверяем связь с хабом'
        $u = [Uri]$HubUrl
        try {
            $latest = Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 -Uri "$HubUrl/agent/latest.json"
        }
        catch [Net.WebException] {
            if ($_.Exception.Response) { throw "хаб не отдаёт сборку агента ($([int]$_.Exception.Response.StatusCode)); сообщите владельцу хаба" }
            throw "Нет связи с $($u.Host):$($u.Port) — проверьте выход машины в интернет"
        }
        # Semver only: the version names the directory app\versions\<v> (no «..», «/», «\»).
        if ("$($latest.version)" -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$' -or "$($latest.sha256)" -cnotmatch '^[0-9a-f]{64}$' -or "$($latest.url)" -cne "/agent/agent-$($latest.version).tgz") {
            throw 'хаб вернул неверный latest.json'
        }
        Write-Host 'Связь есть.'

        # Order (spec «Установщик», re-install): everything new is prepared in $tmp and the code is exchanged first;
        # the running agent, its Node, app\ and app\versions\ are touched only after a successful exchange — an expired
        # code or a failed download leaves the installed agent online.

        # ---- Node.js 22 in .agent-hub\node (a new one is unpacked into $tmp and moved in after the exchange) ----
        Write-AgentHubStep 'Node.js'
        $nodeDir = Join-Path $State 'node'
        $node = Join-Path $nodeDir 'node.exe'
        $ok = $false
        if (Test-Path $node) { $ok = [int]((& $node -p 'process.versions.node').Split('.')[0]) -ge 22 }
        $runDir = $nodeDir
        if ($ok) { Write-Host "Есть: $(& $node --version)" }
        else {
            $sums = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri "$NodeDist/SHASUMS256.txt").Content
            if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
            $m = [regex]::Match($sums, "([0-9a-f]{64})\s+(node-v\d+\.\d+\.\d+-win-$arch\.zip)")
            if (-not $m.Success) { throw "нет сборки Node.js для win-$arch" }
            $zip = Join-Path $tmp $m.Groups[2].Value
            Write-Host "Скачиваем $($m.Groups[2].Value)…"
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri "$NodeDist/$($m.Groups[2].Value)" -OutFile $zip
            if ((Get-AgentHubSha256 $zip) -ne $m.Groups[1].Value) { throw 'Node.js не совпал по SHA-256 с SHASUMS256.txt — установка остановлена' }
            $unz = Join-Path $tmp 'node'
            Expand-Archive -Path $zip -DestinationPath $unz -Force
            $runDir = (Get-ChildItem -Directory $unz | Select-Object -First 1).FullName
        }
        $runNode = Join-Path $runDir 'node.exe'
        $npmCli = Join-Path $runDir 'node_modules\npm\bin\npm-cli.js'

        # ---- claude ----
        Write-AgentHubStep 'Claude Code'
        $claude = Find-AgentHubClaude
        if (-not $claude) {
            Write-Host 'Ставим claude официальным установщиком…'
            $ci = if ($env:AGENT_HUB_CLAUDE_INSTALL_URL) { $env:AGENT_HUB_CLAUDE_INSTALL_URL } else { 'https://claude.ai/install.ps1' }
            $null = Invoke-AgentHubNative 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "irm '$ci' | iex")
            $claude = Find-AgentHubClaude
            if (-not $claude) { throw 'claude не установился' }
        }
        Write-Host "Есть: $((& $claude --version | Select-Object -First 1)) ($claude)"

        # ---- the agent build from the hub, SHA-256 from latest.json ----
        Write-AgentHubStep 'Агент'
        $version = "$($latest.version)"
        $tgz = Join-Path $tmp 'agent.tgz'
        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri "$HubUrl$($latest.url)" -OutFile $tgz }
        catch { throw "не удалось скачать агента с хаба: $($_.Exception.Message)" }
        if ((Get-AgentHubSha256 $tgz) -ne "$($latest.sha256)") { throw 'сборка агента не совпала по SHA-256 — установка остановлена' }
        $vtmp = Join-Path $tmp 'agent'
        New-Item -ItemType Directory -Force -Path $vtmp | Out-Null
        $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
        if (-not (Test-Path $tar)) { $tar = 'tar.exe' }
        if ((Invoke-AgentHubNative $tar @('-xzf', $tgz, '-C', $vtmp)) -ne 0) { throw 'не удалось распаковать агента' }
        if (-not (Test-Path (Join-Path $vtmp 'agent.mjs')) -and (Test-Path (Join-Path $vtmp 'package\agent.mjs'))) {
            Get-ChildItem -Force (Join-Path $vtmp 'package') | Move-Item -Destination $vtmp
            Remove-Item (Join-Path $vtmp 'package')
        }
        foreach ($f in 'agent.mjs', 'supervisor.mjs', 'cli.mjs', 'package.json') {
            if (-not (Test-Path (Join-Path $vtmp $f))) { throw "в сборке агента нет $f" }
        }
        Write-Host 'Ставим зависимости агента (Agent SDK)…'
        $oldPath = $env:Path
        $env:Path = "$runDir;$env:Path"
        try {
            $npmLog = Join-Path $tmp 'npm.log'
            $p = Start-Process -FilePath $runNode -ArgumentList @("`"$npmCli`"", 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error') `
                -WorkingDirectory $vtmp -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$npmLog.out" -RedirectStandardError $npmLog
            if ($p.ExitCode -ne 0) { throw "npm install не прошёл: $((Get-Content $npmLog -Tail 5) -join ' ')" }
        }
        finally { $env:Path = $oldPath }

        # ---- login to Claude (spec «Нет входа в Claude»); --no-restart: a running agent is left alone ----
        Write-AgentHubStep 'Вход в Claude'
        $cli = Join-Path $vtmp 'cli.mjs'
        $status = (& $runNode $cli claude-status) -join ''
        if ($status -match '"login":"ok"') { Write-Host 'Вход есть.' }
        else {
            if ((Invoke-AgentHubNative $runNode @($cli, 'login', '--no-restart')) -ne 0) { Write-Host "Вход в Claude не выполнен. Позже: $State\bin\agent-hub.cmd login" -ForegroundColor Yellow }
        }

        # ---- one-time code → runner token in agent.env, never printed ----
        # A running agent keeps its old token in memory; the hub accepts it until the agent connects with the new one.
        Write-AgentHubStep 'Подключаем машину к хабу'
        if ((Invoke-AgentHubNative $runNode @($cli, 'enroll', '--hub', $HubUrl, '--code', $Code, '--os', 'windows', '--arch', $arch)) -ne 0) { throw 'машина не подключена (причина — строкой выше)' }
        # ---- the exchange went through: the code is spent. From here any failure (icacls, UAC refused, Remove-Item,
        # Move-Item, the task) says what to do and tries to start the previous autostart task (spec «Установщик»,
        # «Сбой после обмена кода»).
        try {
            # Only this user (administrators included) can read the token.
            if ((Invoke-AgentHubNative 'icacls.exe' @($envFile, '/inheritance:r', '/grant:r', "${User}:(F)")) -ne 0) { throw "icacls не прошёл для $envFile" }

            # ---- stop the old agent, then replace Node and the agent files ----
            if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
            Stop-AgentHubProcesses -App $app
            Start-Sleep -Seconds 1
            if ($runDir -ne $nodeDir) {
                if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
                Move-Item $runDir $nodeDir
                Write-Host "Node.js $(& $node --version) в $nodeDir"
            }
            New-Item -ItemType Directory -Force -Path $app, (Join-Path $app 'versions'), (Join-Path $State 'bin') | Out-Null
            $vdir = Join-Path $app "versions\$version"
            if (Test-Path $vdir) { Remove-Item -Recurse -Force $vdir }
            Move-Item $vtmp $vdir
            Set-Content -NoNewline -Encoding Ascii -Path (Join-Path $app 'current') -Value $version
            Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $app 'next'), (Join-Path $app 'update-result.json')
            foreach ($f in 'supervisor.mjs', 'supervisor.mjs.map', 'cli.mjs', 'cli.mjs.map') {
                $src = Join-Path $vdir $f
                if (Test-Path $src) { Copy-Item -Force $src (Join-Path $app $f) }
            }
            # The layout before self-update (app\agent.mjs + app\node_modules, the cmd loop) and older versions.
            foreach ($f in 'node_modules', 'agent.mjs', 'agent.mjs.map', 'package.json', 'package-lock.json', 's4u-check.mjs', 'run-agent.cmd') {
                $p = Join-Path $app $f
                if (Test-Path $p) { Remove-Item -Recurse -Force $p }
            }
            Get-ChildItem -Directory (Join-Path $app 'versions') | Where-Object { $_.Name -ne $version } | Remove-Item -Recurse -Force
            Write-Host "Агент $version."

            # ---- bin\agent-hub.cmd ----
            $cmd = "@echo off`r`nif not defined AGENT_HUB_HOME set `"AGENT_HUB_HOME=$State`"`r`n`"$node`" `"$(Join-Path $app 'cli.mjs')`" %*`r`n"
            [IO.File]::WriteAllText((Join-Path $State 'bin\agent-hub.cmd'), $cmd, (New-Object Text.UTF8Encoding $false))

            # ---- autostart: S4U task (the only step with administrator rights) ----
            Write-AgentHubStep 'Автозапуск'
            $log = Join-Path $State 'agent.log'
            $offset = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
            $supervisor = Join-Path $app 'supervisor.mjs'
            $argLine = "--env-file=`"$envFile`" `"$supervisor`""
            $conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
            $headlessArg = "--headless `"$node`" $argLine"
            Invoke-AgentHubElevated -State $State -Name 'register' -Body @"
    `$action = New-ScheduledTaskAction -Execute $(Format-AgentHubLiteral $node) -Argument $(Format-AgentHubLiteral $argLine) -WorkingDirectory $(Format-AgentHubLiteral $app)
    `$trigger = New-ScheduledTaskTrigger -AtStartup
    `$principal = New-ScheduledTaskPrincipal -UserId $(Format-AgentHubLiteral $User) -LogonType S4U -RunLevel Limited
    # Restart-on-failure (999 is the maximum) covers the supervisor; the agent is restarted by the supervisor.
    `$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
    `$registered = Get-Date -Millisecond 0
    Register-ScheduledTask -TaskName $(Format-AgentHubLiteral $TaskName) -Action `$action -Trigger `$trigger -Principal `$principal -Settings `$settings -Force | Out-Null
    Start-ScheduledTask -TaskName $(Format-AgentHubLiteral $TaskName)
    # S4U of a domain account needs a domain controller: without one the task never starts, or its run ends with a
    # Win32 logon error (0x8007xxxx, e.g. 0x80070569: batch logon denied by GPO) (design M5, «запасной вход»).
    # Compared as hex text: in PS 5.1 0xFFFF0000 / 0x80070000 are negative Int32 and -band with the UInt32 result fails.
    `$started = `$false
    for (`$i = 0; `$i -lt 20 -and -not `$started; `$i++) {
        Start-Sleep -Seconds 1
        `$info = Get-ScheduledTaskInfo -TaskName $(Format-AgentHubLiteral $TaskName)
        `$started = ((Get-ScheduledTask -TaskName $(Format-AgentHubLiteral $TaskName)).State -eq 'Running') -or (`$info.LastRunTime -ge `$registered -and ('{0:X8}' -f `$info.LastTaskResult) -notlike '8007*')
    }
    if (-not `$started) {
        # Fallback: at logon of this user; conhost --headless keeps node.exe without a console window.
        `$action = New-ScheduledTaskAction -Execute $(Format-AgentHubLiteral $conhost) -Argument $(Format-AgentHubLiteral $headlessArg) -WorkingDirectory $(Format-AgentHubLiteral $app)
        `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $(Format-AgentHubLiteral $User)
        `$principal = New-ScheduledTaskPrincipal -UserId $(Format-AgentHubLiteral $User) -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $(Format-AgentHubLiteral $TaskName) -Action `$action -Trigger `$trigger -Principal `$principal -Settings `$settings -Force | Out-Null
        Start-ScheduledTask -TaskName $(Format-AgentHubLiteral $TaskName)
    }
"@
            Set-Content -Encoding UTF8 -Path (Join-Path $State 'autostart') -Value "task $TaskName"
        }
        catch {
            $why = $_.Exception.Message
            # Best effort: the task of the previous install (its files may be partly replaced).
            try {
                if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
                    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
                    Write-Host "Пробуем снова запустить прежний агент (задача '$TaskName')." -ForegroundColor Yellow
                }
            }
            catch { $null = $_ }
            throw "установка прервалась после подключения машины ($why). Нажмите «Переподключить» в хабе и запустите новую команду"
        }
        $task = Get-ScheduledTask -TaskName $TaskName
        Write-Host "Задача '$TaskName': $($task.State), вход $($task.Principal.LogonType), пользователь $($task.Principal.UserId)"
        if ("$($task.Principal.LogonType)" -eq 'Interactive') { Write-Host "Агент работает, только пока пользователь $User вошёл в Windows: вход S4U недоступен (например, доменная учётка без связи с контроллером домена)." -ForegroundColor Yellow }

        Write-Host 'Ждём подключения агента к хабу…'
        $connected = $false
        $rejected = $false
        for ($i = 0; $i -lt $WaitSec -and -not $connected; $i++) {
            Start-Sleep -Seconds 1
            if (-not (Test-Path $log)) { continue }
            $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
            try {
                if ($fs.Length -lt $offset) { $offset = 0 }
                $null = $fs.Seek($offset, 'Begin')
                $chunk = (New-Object IO.StreamReader($fs)).ReadToEnd()
            }
            finally { $fs.Dispose() }
            if ($chunk -match '"connected to hub"') { $connected = $true; Write-Host 'Агент подключился к хабу.' }
            elseif ($chunk -match 'hub rejected the agent token') {
                $rejected = $true
                break
            }
        }
        # The hub refused the new token: no «Готово», the install fails.
        if ($rejected) { throw 'хаб отклонил токен агента: нажмите «Переподключить» в браузере и запустите новую команду' }
        if (-not $connected) { Write-Host "Агент запущен, но ещё не подключился к хабу; журнал: $log" -ForegroundColor Yellow }
        Write-Host ''
        Write-Host 'Готово, вернитесь в браузер' -ForegroundColor Green
        $global:LASTEXITCODE = 0
    }
    finally {
        $env:AGENT_HUB_HOME = $prevHome
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
    }
}
