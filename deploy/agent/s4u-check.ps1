# Task 1.3: run s4u-check.mjs from a Task Scheduler task with LogonType S4U (the same context as
# "Agent Hub Agent" after a reboot without logon), wait for the result and remove the task.
# Run from an elevated PowerShell on X1 / HP:
#   powershell -ExecutionPolicy Bypass -File deploy\agent\s4u-check.ps1 -Script <repo>\agent\scripts\s4u-check.mjs -Cwd C:\Users\me\vault
# The SDK must be resolvable from the script directory (npm ci in the repo, or the installed app dir).
param(
    [Parameter(Mandatory = $true)][string]$Script,
    [string]$Cwd = "$env:USERPROFILE\vault",
    [string]$Out = "$env:USERPROFILE\.agent-hub\s4u-check.json",
    # The account as DOMAIN\user or COMPUTER\user. Not $env:USERDOMAIN: in an SSH session it is WORKGROUP and
    # Register-ScheduledTask fails with 0x80070534 (found on X1).
    [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
    [int]$TimeoutSec = 240,
    [string]$TaskName = "Agent Hub S4U check"
)
$ErrorActionPreference = 'Stop'

$node = (Get-Command node).Source
if (Test-Path $Out) { Remove-Item $Out -Force }
$log = [IO.Path]::ChangeExtension($Out, '.log')

$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument "/c `"`"$node`" `"$Script`" --cwd `"$Cwd`" --out `"$Out`" > `"$log`" 2>&1`"" `
    -WorkingDirectory (Split-Path $Script)
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings | Out-Null
try {
    Start-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        Start-Sleep -Seconds 3
        $state = (Get-ScheduledTask -TaskName $TaskName).State
    } while ($state -eq 'Running' -and (Get-Date) -lt $deadline)
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Output "task state: $state, last result: $($info.LastTaskResult)"
    if (Test-Path $Out) { Get-Content $Out -Raw } else { Write-Output "no result file; log:"; if (Test-Path $log) { Get-Content $log -Raw } }
}
finally {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "task removed: $TaskName"
}
