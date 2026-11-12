<#
.SYNOPSIS
    Registers the SOTRANS Hub operational health monitoring task in Windows Task Scheduler.
.DESCRIPTION
    Runs monitor_health.ps1 every 15 minutes to continuously verify container status,
    disk space, memory, and database connection pools.
#>

param(
    [string]$TaskName = "SOTRANS_Hub_Health_Monitor",
    [string]$ScriptPath = "D:\hoso-chat\scripts\monitor_health.ps1"
)

Write-Host "Registering Windows Scheduled Task: $TaskName..." -ForegroundColor Cyan

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$ScriptPath`""
$trigger = New-ScheduledTaskTrigger -Once -At "00:00" -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

try {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Task '$TaskName' already exists. Unregistering old version..." -ForegroundColor Yellow
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "SOTRANS Hub 15-Minute Operational Health Monitor"
    Write-Host "SUCCESS: Scheduled task '$TaskName' registered successfully (Interval: 15 minutes)." -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to register monitoring task: $_" -ForegroundColor Red
}
