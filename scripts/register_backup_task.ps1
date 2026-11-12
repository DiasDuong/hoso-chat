<#
.SYNOPSIS
    Registers the SOTRANS Hub automated daily backup task in Windows Task Scheduler.
.DESCRIPTION
    Creates or updates the scheduled task 'SOTRANS_Hub_Daily_Backup' to execute
    every day at 02:00 AM.
#>

param(
    [string]$TaskName = "SOTRANS_Hub_Daily_Backup",
    [string]$ExecutionTime = "02:00",
    [string]$ScriptPath = "D:\hoso-chat\scripts\daily_backup.ps1",
    [string]$BackupRoot = "D:\SOTRANS_BACKUPS\automated",
    [string]$SecondaryPath = ""
)

Write-Host "Registering Windows Scheduled Task: $TaskName..." -ForegroundColor Cyan

$actionArgs = "-ExecutionPolicy Bypass -File `"$ScriptPath`" -BackupRoot `"$BackupRoot`""
if ($SecondaryPath) {
    $actionArgs += " -SecondaryPath `"$SecondaryPath`""
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs
$trigger = New-ScheduledTaskTrigger -Daily -At $ExecutionTime
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

try {
    # Check if task already exists
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Task '$TaskName' already exists. Unregistering old version..." -ForegroundColor Yellow
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "SOTRANS Hub Automated Daily PostgreSQL & Qdrant Backup"
    Write-Host "SUCCESS: Scheduled task '$TaskName' registered successfully for daily run at $ExecutionTime." -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to register scheduled task: $_" -ForegroundColor Red
    Write-Host "Note: Administrator privileges are required to register scheduled tasks in Windows." -ForegroundColor Yellow
}
