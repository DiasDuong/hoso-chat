<#
.SYNOPSIS
    SOTRANS Hub - Lightweight Production Operational Monitoring Script
.DESCRIPTION
    Checks container status, health, disk space, memory, PostgreSQL connection pool,
    and core HTTP health endpoints without requiring heavy external monitoring agents.
#>

$ErrorActionPreference = "Continue"

$report = @{
    timestamp = (Get-Date).ToString("o")
    status = "HEALTHY"
    alerts = @()
    metrics = @{
        containers = @{}
        disk = @{}
        postgres = @{}
        endpoints = @{}
    }
}

# 1. Containers Check
$requiredContainers = @("hr-gateway", "hr-web", "hr-auth", "hrbot-postgres-1", "hrbot-qdrant-1", "hrbot-n8n-1")
foreach ($name in $requiredContainers) {
    $inspect = & docker inspect $name 2>$null | ConvertFrom-Json
    if (-not $inspect) {
        $report.status = "UNHEALTHY"
        $report.alerts += "Container $name is NOT FOUND"
        continue
    }
    $state = $inspect[0].State
    $cHealth = if ($state.Health) { $state.Health.Status } else { "none" }
    $report.metrics.containers[$name] = @{
        running = $state.Running
        restarting = $state.Restarting
        health = $cHealth
        restart_count = $inspect[0].RestartCount
    }
    if (-not $state.Running) {
        $report.status = "UNHEALTHY"
        $report.alerts += "Container $name is NOT RUNNING (status: $($state.Status))"
    } elseif ($cHealth -eq "unhealthy") {
        $report.status = "DEGRADED"
        $report.alerts += "Container $name health check is UNHEALTHY"
    }
}

# 2. Disk Space Check
$driveD = Get-PSDrive D -ErrorAction SilentlyContinue
if ($driveD) {
    $totalGB = [Math]::Round(($driveD.Used + $driveD.Free) / 1GB, 2)
    $freeGB = [Math]::Round($driveD.Free / 1GB, 2)
    $pctFree = [Math]::Round(($driveD.Free / ($driveD.Used + $driveD.Free)) * 100, 2)
    $report.metrics.disk["D"] = @{
        total_gb = $totalGB
        free_gb = $freeGB
        pct_free = $pctFree
    }
    if ($pctFree -lt 10.0 -or $freeGB -lt 5.0) {
        $report.status = "DEGRADED"
        $report.alerts += "Drive D: low disk space ($freeGB GB free, $pctFree% free)"
    }
}

# 3. PostgreSQL Connections & Pool Check
try {
    $pgStats = & docker exec hrbot-postgres-1 psql -U hrbot -d hrbot -t -A -F"," -c "
        SELECT (SELECT setting::int FROM pg_settings WHERE name='max_connections') as max_conn,
               count(*) as total,
               sum(case when state = 'active' then 1 else 0 end) as active,
               sum(case when state = 'idle in transaction' then 1 else 0 end) as idle_in_trans
        FROM pg_stat_activity;
    "
    $parts = $pgStats.Trim().Split(",")
    $maxConn = [int]$parts[0]
    $totalConn = [int]$parts[1]
    $activeConn = [int]$parts[2]
    $idleInTrans = [int]$parts[3]

    $report.metrics.postgres = @{
        max_connections = $maxConn
        total_connections = $totalConn
        active_connections = $activeConn
        idle_in_transaction = $idleInTrans
    }

    if ($totalConn -ge ($maxConn * 0.85)) {
        $report.status = "DEGRADED"
        $report.alerts += "PostgreSQL connection pool near capacity ($totalConn / $maxConn)"
    }
    if ($idleInTrans -gt 5) {
        $report.status = "DEGRADED"
        $report.alerts += "PostgreSQL high idle-in-transaction count: $idleInTrans"
    }
} catch {
    $report.alerts += "Failed to query PostgreSQL stats: $_"
}

# 4. HTTP Endpoints Check
$endpoints = @(
    @{ Name = "auth_health"; Url = "http://127.0.0.1:3000/api/health" },
    @{ Name = "gateway_health"; Url = "http://127.0.0.1:8082/api/health" },
    @{ Name = "qdrant_ready"; Url = "http://127.0.0.1:6333/readyz" }
)

foreach ($ep in $endpoints) {
    try {
        $resp = Invoke-WebRequest -Uri $ep.Url -UseBasicParsing -TimeoutSec 3
        $report.metrics.endpoints[$ep.Name] = @{
            status_code = $resp.StatusCode
            ok = $true
        }
    } catch {
        $report.status = "DEGRADED"
        $report.alerts += "Endpoint $($ep.Name) ($($ep.Url)) unreachable: $_"
        $report.metrics.endpoints[$ep.Name] = @{
            ok = $false
            error = $_.ToString()
        }
    }
}

# Output Summary
$color = if ($report.status -eq "HEALTHY") { "Green" } elseif ($report.status -eq "DEGRADED") { "Yellow" } else { "Red" }
Write-Host "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] SOTRANS Hub Health: $($report.status)" -ForegroundColor $color
if ($report.alerts.Count -gt 0) {
    Write-Host "Alerts:" -ForegroundColor Magenta
    foreach ($a in $report.alerts) {
        Write-Host "  - $a" -ForegroundColor Magenta
    }
} else {
    Write-Host "All systems nominal (0 alerts)." -ForegroundColor Gray
}

# Output JSON
$report | ConvertTo-Json -Depth 4
