# Registers "Climb helper" to start at logon (current user only, no admin needed) and starts it now.
# Re-running is safe: the task is replaced, and a second helper exits if the port is already taken.
# Remove with:  Unregister-ScheduledTask -TaskName 'Climb helper' -Confirm:$false
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'helper.py'

$py = (Get-Command python -ErrorAction Stop).Source
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'
if (-not (Test-Path $pyw)) { throw "pythonw.exe not found next to $py" }

$action  = New-ScheduledTaskAction -Execute $pyw -Argument "`"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'Climb helper' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Logs when Deadlock is running and serves it to Climb on 127.0.0.1:47615.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Climb helper'
Write-Output "Installed and started: $pyw $script"
