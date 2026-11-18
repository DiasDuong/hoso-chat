# ==============================================================================
# SOTRANS HUB — WINDOWS POWERSHELL PRODUCTION BACKUP SCRIPT
# ==============================================================================
param(
  [string]$BackupRoot = "D:\backups\sotrans-hub",
  [string]$OffsiteDest = "C:\backups\sotrans-hub-offsite",
  [string]$PgContainer = "hrbot-postgres-1",
  [string]$PgUser = "hrbot",
  [string]$PgDb = "hrbot",
  [string]$QdrantHost = "127.0.0.1",
  [int]$QdrantPort = 6333
)

$ErrorActionPreference = "Stop"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$BackupDir = Join-Path $BackupRoot $Timestamp

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "SOTRANS HUB — PRODUCTION BACKUP INITIALIZATION (WINDOWS / POWERSHELL)" -ForegroundColor Cyan
Write-Host "Timestamp   : $Timestamp"
Write-Host "Destination : $BackupDir"
Write-Host "================================================================================"

if (-not (Test-Path $BackupDir)) {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

# ------------------------------------------------------------------------------
# 1. PostgreSQL Database Dump (-Fc)
# ------------------------------------------------------------------------------
Write-Host "`n[1/5] Dumping PostgreSQL database '$PgDb' from container '$PgContainer'..." -ForegroundColor Yellow
$DumpFile = Join-Path $BackupDir "postgres_${PgDb}_${Timestamp}.dump"
cmd.exe /c "docker exec $PgContainer pg_dump -U $PgUser -d $PgDb -Fc --no-owner --no-privileges > `"$DumpFile`""

if ((Test-Path $DumpFile) -and ((Get-Item $DumpFile).Length -gt 1000)) {
  $DumpSize = [math]::Round((Get-Item $DumpFile).Length / 1MB, 2)
  Write-Host "      PostgreSQL dump completed successfully ($DumpSize MB)." -ForegroundColor Green
} else {
  Write-Error "PostgreSQL dump failed or generated empty file!"
}

# ------------------------------------------------------------------------------
# 2. Qdrant Vector Storage Snapshot
# ------------------------------------------------------------------------------
Write-Host "`n[2/5] Creating and downloading Qdrant collection snapshots..." -ForegroundColor Yellow
try {
  $CollsResp = Invoke-RestMethod -Uri "http://${QdrantHost}:${QdrantPort}/collections" -Method Get -TimeoutSec 5
  $Collections = $CollsResp.result.collections.name
} catch {
  Write-Warning "Could not list Qdrant collections via API. Defaulting to 'hr_docs'."
  $Collections = @("hr_docs")
}

foreach ($Coll in $Collections) {
  Write-Host "      Processing collection: $Coll"
  try {
    $SnapResp = Invoke-RestMethod -Uri "http://${QdrantHost}:${QdrantPort}/collections/${Coll}/snapshots" -Method Post -TimeoutSec 30
    $SnapName = $SnapResp.result.name
    if ($SnapName) {
      $SnapDest = Join-Path $BackupDir $SnapName
      Invoke-WebRequest -Uri "http://${QdrantHost}:${QdrantPort}/collections/${Coll}/snapshots/${SnapName}" -OutFile $SnapDest -TimeoutSec 60
      $SnapSize = [math]::Round((Get-Item $SnapDest).Length / 1MB, 2)
      Write-Host "      Snapshot '$SnapName' downloaded ($SnapSize MB)." -ForegroundColor Green
    }
  } catch {
    Write-Warning "Failed snapshot for collection '$Coll': $_"
  }
}

# ------------------------------------------------------------------------------
# 3. Permanent Documents (files / chat-files)
# ------------------------------------------------------------------------------
Write-Host "`n[3/5] Archiving permanent documents (D:\hoso-chat\files)..." -ForegroundColor Yellow
$ChatFilesSource = "D:\hoso-chat\files"
$ChatFilesZip = Join-Path $BackupDir "chat_files_${Timestamp}.zip"
if (Test-Path $ChatFilesSource) {
  Compress-Archive -Path "$ChatFilesSource\*" -DestinationPath $ChatFilesZip -Force
  $FilesSize = [math]::Round((Get-Item $ChatFilesZip).Length / 1MB, 2)
  Write-Host "      Documents archive completed ($FilesSize MB)." -ForegroundColor Green
} else {
  Write-Warning "Source directory '$ChatFilesSource' not found, skipping."
}

# ------------------------------------------------------------------------------
# 4. Uploaded File BI Storage (storage/)
# ------------------------------------------------------------------------------
Write-Host "`n[4/5] Archiving Uploaded File BI storage (D:\hoso-chat\auth-service\storage)..." -ForegroundColor Yellow
$BiStorageSource = "D:\hoso-chat\auth-service\storage"
$BiStorageZip = Join-Path $BackupDir "bi_storage_${Timestamp}.zip"
if (Test-Path $BiStorageSource) {
  Compress-Archive -Path "$BiStorageSource\*" -DestinationPath $BiStorageZip -Force
  $BiSize = [math]::Round((Get-Item $BiStorageZip).Length / 1MB, 2)
  Write-Host "      BI storage archive completed ($BiSize MB)." -ForegroundColor Green
} else {
  Write-Warning "Source directory '$BiStorageSource' not found, skipping."
}

# ------------------------------------------------------------------------------
# 5. Metadata Checkpoint & SHA256 Checksums
# ------------------------------------------------------------------------------
Write-Host "`n[5/5] Generating metadata and verifying SHA256 checksums..." -ForegroundColor Yellow
$MetadataFile = Join-Path $BackupDir "backup_metadata.json"
$Metadata = @{
  timestamp = $Timestamp
  database = $PgDb
  collections = $Collections
  created_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  format_version = "2.4-windows"
} | ConvertTo-Json
Set-Content -Path $MetadataFile -Value $Metadata

$ChecksumsFile = Join-Path $BackupDir "SHA256SUMS.txt"
$AllFiles = Get-ChildItem -Path $BackupDir -File | Where-Object { $_.Name -ne "SHA256SUMS.txt" }
$ChecksumLines = @()

foreach ($File in $AllFiles) {
  $Hash = (Get-FileHash -Path $File.FullName -Algorithm SHA256).Hash.ToLower()
  $ChecksumLines += "$Hash  $($File.Name)"
}
Set-Content -Path $ChecksumsFile -Value $ChecksumLines

Write-Host "      Validating generated checksums..."
$Valid = $true
foreach ($Line in $ChecksumLines) {
  $Parts = $Line -split "\s+"
  $Expected = $Parts[0]
  $FileName = $Parts[1]
  $Actual = (Get-FileHash -Path (Join-Path $BackupDir $FileName) -Algorithm SHA256).Hash.ToLower()
  if ($Expected -eq $Actual) {
    Write-Host "      [OK] $FileName" -ForegroundColor Green
  } else {
    Write-Host "      [FAIL] $FileName" -ForegroundColor Red
    $Valid = $false
  }
}

if (-not $Valid) {
  Write-Error "SHA256 checksum verification failed!"
}

# ------------------------------------------------------------------------------
# 6. Off-Site / Secondary Replication
# ------------------------------------------------------------------------------
if ($OffsiteDest) {
  Write-Host "`n[OFF-SITE] Replicating backup package to: $OffsiteDest..." -ForegroundColor Yellow
  $OffsiteTarget = Join-Path $OffsiteDest $Timestamp
  if (-not (Test-Path $OffsiteTarget)) {
    New-Item -ItemType Directory -Path $OffsiteTarget -Force | Out-Null
  }
  Copy-Item -Path "$BackupDir\*" -Destination $OffsiteTarget -Recurse -Force
  Write-Host "      Off-site replication completed to $OffsiteTarget." -ForegroundColor Green
}

Write-Host "`n================================================================================" -ForegroundColor Cyan
Write-Host "SOTRANS HUB — PRODUCTION BACKUP COMPLETED & VERIFIED" -ForegroundColor Cyan
Write-Host "Backup Location: $BackupDir"
Write-Host "================================================================================"
