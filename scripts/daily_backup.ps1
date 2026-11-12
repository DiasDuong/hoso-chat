<#
.SYNOPSIS
    SOTRANS Hub - Production Automated Daily Backup Script (Hardened Phase 1)
.DESCRIPTION
    Comprehensive backup solution covering:
    1. PostgreSQL (hrbot custom compressed dump + schema SQL)
    2. Qdrant (hr_docs vector snapshot)
    3. n8n workflows (workflows_all.json)
    4. Document Storage & Attachments:
       - files/ (host raw storage bound to /usr/share/nginx/chat-files and /home/node/.n8n-files)
       - auth-service/uploads/
       - auth-service/storage/conversations/
    5. Host & Gateway Configurations (docker-compose.yml, nginx/default.conf)
    6. Production Secrets (AES-256-CBC envelope encryption of .env, auth-service/.env, nginx/.htpasswd)
    
    Includes pre-flight disk capacity checks, individual SHA-256 manifest hashing,
    and 7-day daily / 4-week weekly retention management.
.PARAMETER BackupRoot
    The root path for storing automated backups. Defaults to 'D:\SOTRANS_BACKUPS\automated'.
.PARAMETER SecondaryPath
    Optional secondary path (e.g., E:\SOTRANS_BACKUPS or \\nas\backups) to replicate backups.
.PARAMETER RetentionDaily
    Number of daily backups to keep (default: 7).
.PARAMETER RetentionWeekly
    Number of weekly (Sunday) backups to keep (default: 4).
.PARAMETER SecretKeyPath
    Path to the master AES-256 backup key file. Defaults to 'C:\Users\Admin\.sotrans_backup_key'.
.PARAMETER MinFreeSpaceMB
    Minimum free disk space required on destination drive in MB (default: 2048 MB = 2 GB).
#>

param(
    [string]$BackupRoot = "D:\SOTRANS_BACKUPS\automated",
    [string]$SecondaryPath = "",
    [int]$RetentionDaily = 7,
    [int]$RetentionWeekly = 4,
    [string]$SecretKeyPath = "C:\Users\Admin\.sotrans_backup_key",
    [long]$MinFreeSpaceMB = 2048
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
$StartTime = Get-Date
$DateStr = $StartTime.ToString("yyyyMMdd_HHmmss")
$DayOfWeek = $StartTime.DayOfWeek

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " [SOTRANS HUB] Hardened Daily Backup - $DateStr" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# Pre-flight check: Disk Space
$destDrive = Split-Path -Qualifier $BackupRoot
if (-not $destDrive) { $destDrive = "D:" }
$driveObj = Get-PSDrive -Name ($destDrive.Replace(":", "")) -ErrorAction SilentlyContinue
if ($driveObj) {
    $freeMB = [Math]::Round($driveObj.Free / 1MB, 2)
    Write-Host "Pre-flight Check: Destination drive $destDrive has $freeMB MB free (Required: $MinFreeSpaceMB MB)" -ForegroundColor Gray
    if ($freeMB -lt $MinFreeSpaceMB) {
        throw "ABORT: Insufficient disk space on drive $destDrive. Free: $freeMB MB, Required: $MinFreeSpaceMB MB."
    }
}

$TargetDir = Join-Path $BackupRoot $DateStr
$LogFile = Join-Path $TargetDir "backup.log"

# Target Subdirectories
$PgDir = Join-Path $TargetDir "postgresql"
$QdrantDir = Join-Path $TargetDir "qdrant"
$N8nDir = Join-Path $TargetDir "n8n"
$StorageDir = Join-Path $TargetDir "storage"
$StorageFilesDir = Join-Path $StorageDir "files"
$StorageUploadsDir = Join-Path $StorageDir "uploads"
$StorageConversationsDir = Join-Path $StorageDir "conversations"
$ConfigsDir = Join-Path $TargetDir "configs"
$SecretsDir = Join-Path $TargetDir "secrets"

New-Item -ItemType Directory -Force -Path $PgDir, $QdrantDir, $N8nDir, $StorageFilesDir, $StorageUploadsDir, $StorageConversationsDir, $ConfigsDir, $SecretsDir | Out-Null

function Log([string]$msg, [string]$color = "White") {
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $line = "[$timestamp] $msg"
    Write-Host $line -ForegroundColor $color
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

Log "Backup initiated. Target folder: $TargetDir" "Green"
Log "Day of week: $DayOfWeek" "Gray"

$Manifest = @{
    backup_id = $DateStr
    version = "v1.1.0-gov3-remediation1"
    created_at = $StartTime.ToString("o")
    day_of_week = $DayOfWeek.ToString()
    backup_root = $BackupRoot
    storage_mapping = @{
        files = @{
            host_path = "D:\hoso-chat\files"
            container_aliases = @("/usr/share/nginx/chat-files", "/home/node/.n8n-files", "/app/chat-files")
        }
        uploads = @{
            host_path = "D:\hoso-chat\auth-service\uploads"
            container_path = "/app/uploads"
        }
        conversations = @{
            host_path = "D:\hoso-chat\auth-service\storage\conversations"
            container_path = "/app/storage/conversations"
        }
    }
    secrets_protection = @{
        encrypted = $true
        algorithm = "AES-256-CBC"
        key_storage = "External Protected Storage"
        items_protected = @(".env", "auth-service/.env", "nginx/.htpasswd")
    }
    files = @()
    status = "in_progress"
}

try {
    # 1. PostgreSQL Backup
    Log "Step 1/6: Dumping PostgreSQL database 'hrbot'..." "Yellow"
    $PgDumpFile = Join-Path $PgDir "hrbot.dump"
    $PgSchemaFile = Join-Path $PgDir "hrbot_schema.sql"

    & docker exec hrbot-postgres-1 pg_dump -U hrbot -Fc hrbot -f /tmp/hrbot.dump
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL custom format dump failed." }
    & docker cp hrbot-postgres-1:/tmp/hrbot.dump $PgDumpFile
    & docker exec hrbot-postgres-1 rm -f /tmp/hrbot.dump
    Log "  -> Compressed dump saved: $PgDumpFile ($([Math]::Round((Get-Item $PgDumpFile).Length / 1MB, 2)) MB)" "Gray"

    & docker exec hrbot-postgres-1 pg_dump -U hrbot --schema-only hrbot -f /tmp/hrbot_schema.sql
    if ($LASTEXITCODE -ne 0) { throw "PostgreSQL schema dump failed." }
    & docker cp hrbot-postgres-1:/tmp/hrbot_schema.sql $PgSchemaFile
    & docker exec hrbot-postgres-1 rm -f /tmp/hrbot_schema.sql
    Log "  -> Schema SQL saved: $PgSchemaFile" "Gray"

    # 2. Qdrant Snapshot
    Log "Step 2/6: Creating Qdrant collection 'hr_docs' snapshot..." "Yellow"
    $snapResponse = Invoke-RestMethod -Uri "http://127.0.0.1:6333/collections/hr_docs/snapshots" -Method Post -ContentType "application/json"
    if ($snapResponse.status -eq "ok" -and $snapResponse.result.name) {
        $snapName = $snapResponse.result.name
        $containerSnapPath = "hrbot-qdrant-1:/qdrant/snapshots/hr_docs/$snapName"
        $localSnapFile = Join-Path $QdrantDir $snapName
        
        Log "  -> Qdrant snapshot created in container: $snapName. Copying out..." "Gray"
        & docker cp $containerSnapPath $localSnapFile
        Log "  -> Snapshot copied to: $localSnapFile ($([Math]::Round((Get-Item $localSnapFile).Length / 1MB, 2)) MB)" "Gray"
    } else {
        throw "Failed to create Qdrant snapshot: $($snapResponse | ConvertTo-Json -Compress)"
    }

    # 3. n8n Workflows Backup
    Log "Step 3/6: Exporting n8n workflows..." "Yellow"
    $N8nFile = Join-Path $N8nDir "workflows_all.json"
    $n8nExport = & docker exec hrbot-n8n-1 n8n export:workflow --all
    $n8nExport | Set-Content -Path $N8nFile -Encoding UTF8
    Log "  -> n8n workflows saved: $N8nFile ($([Math]::Round((Get-Item $N8nFile).Length / 1KB, 2)) KB)" "Gray"

    # 4. Storage & Documents Backup (files, uploads, conversations)
    Log "Step 4/6: Backing up file storage and document repositories..." "Yellow"
    
    # 4a. files/ (Raw documents + chat files)
    $sourceFilesDir = "D:\hoso-chat\files"
    if (Test-Path $sourceFilesDir) {
        $copiedFiles = Get-ChildItem -Path $sourceFilesDir -File
        foreach ($f in $copiedFiles) {
            Copy-Item -Path $f.FullName -Destination (Join-Path $StorageFilesDir $f.Name) -Force
        }
        $totalBytes = ($copiedFiles | Measure-Object -Property Length -Sum).Sum
        Log "  -> Copied $($copiedFiles.Count) files from $sourceFilesDir ($([Math]::Round($totalBytes / 1MB, 2)) MB)" "Gray"
    } else {
        Log "  -> WARNING: Source directory $sourceFilesDir does not exist!" "Magenta"
    }

    # 4b. uploads/ (Auth attachments and intake staging)
    $sourceUploadsDir = "D:\hoso-chat\auth-service\uploads"
    if (Test-Path $sourceUploadsDir) {
        Copy-Item -Path "$sourceUploadsDir\*" -Destination $StorageUploadsDir -Recurse -Force
        $countUploads = (Get-ChildItem -Path $StorageUploadsDir -Recurse -File).Count
        Log "  -> Copied $countUploads upload and staging files from $sourceUploadsDir" "Gray"
    }

    # 4c. conversations/ (Markdown conversation transcripts)
    $sourceConvDir = "D:\hoso-chat\auth-service\storage\conversations"
    if (Test-Path $sourceConvDir) {
        Copy-Item -Path "$sourceConvDir\*" -Destination $StorageConversationsDir -Recurse -Force
        $countConv = (Get-ChildItem -Path $StorageConversationsDir -Recurse -File).Count
        Log "  -> Copied $countConv conversation transcripts from $sourceConvDir" "Gray"
    }

    # 5. Configuration Files (Non-secret)
    Log "Step 5/6: Copying system configurations (docker-compose, nginx)..." "Yellow"
    $composeSource = "D:\hoso-chat\docker-compose.yml"
    $nginxSource = "D:\hoso-chat\nginx\default.conf"
    if (Test-Path $composeSource) {
        Copy-Item -Path $composeSource -Destination (Join-Path $ConfigsDir "docker-compose.yml") -Force
    }
    if (Test-Path $nginxSource) {
        Copy-Item -Path $nginxSource -Destination (Join-Path $ConfigsDir "default.conf") -Force
    }
    Log "  -> Public configuration files copied." "Gray"

    # 6. Secrets Protection (AES-256-CBC Encrypted)
    Log "Step 6/6: Encrypting production secrets (.env, auth-service/.env, nginx/.htpasswd)..." "Yellow"
    
    # Ensure master key exists
    if (-not (Test-Path $SecretKeyPath)) {
        Log "  -> Master secret key not found. Generating new 256-bit key at $SecretKeyPath..." "Cyan"
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $rawKey = New-Object byte[] 32
        $rng.GetBytes($rawKey)
        [System.IO.File]::WriteAllText($SecretKeyPath, [Convert]::ToBase64String($rawKey))
        & icacls $SecretKeyPath /inheritance:r /grant:r "Administrators:(R,W)" /grant:r "$($env:USERNAME):(R,W)" | Out-Null
    }

    $keyRaw = (Get-Content -Path $SecretKeyPath -Raw).Trim()
    $keyBytes = [Convert]::FromBase64String($keyRaw)
    if ($keyBytes.Length -ne 32) {
        throw "Invalid encryption key size at $SecretKeyPath. Expected 32 bytes (256 bits)."
    }

    # Package secrets into memory zip archive
    $secretFilesMap = @(
        @{ Source = "D:\hoso-chat\.env"; ArchiveName = "root.env" },
        @{ Source = "D:\hoso-chat\auth-service\.env"; ArchiveName = "auth-service.env" },
        @{ Source = "D:\hoso-chat\nginx\.htpasswd"; ArchiveName = "nginx.htpasswd" }
    )

    $memStream = New-Object System.IO.MemoryStream
    $zipArchive = New-Object System.IO.Compression.ZipArchive($memStream, [System.IO.Compression.ZipArchiveMode]::Create, $true)

    foreach ($sec in $secretFilesMap) {
        if (Test-Path $sec.Source) {
            $entry = $zipArchive.CreateEntry($sec.ArchiveName, [System.IO.Compression.CompressionLevel]::Optimal)
            $eStream = $entry.Open()
            $fBytes = [System.IO.File]::ReadAllBytes($sec.Source)
            $eStream.Write($fBytes, 0, $fBytes.Length)
            $eStream.Close()
            Log "  -> Packaged secret asset: $($sec.ArchiveName) ($($fBytes.Length) bytes)" "Gray"
        } else {
            Log "  -> WARNING: Secret source $($sec.Source) not found!" "Magenta"
        }
    }
    $zipArchive.Dispose()
    $plainBytes = $memStream.ToArray()
    $memStream.Dispose()

    # Encrypt plainBytes with AES-256-CBC
    $aes = [System.Security.Cryptography.Aes]::Create()
    $aes.KeySize = 256
    $aes.Key = $keyBytes
    $aes.GenerateIV()
    $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
    $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7

    $encryptor = $aes.CreateEncryptor()
    $cipherBytes = $encryptor.TransformFinalBlock($plainBytes, 0, $plainBytes.Length)

    $EncryptedOutputFile = Join-Path $SecretsDir "env_secrets.enc"
    $outStream = [System.IO.File]::Create($EncryptedOutputFile)
    $outStream.Write($aes.IV, 0, $aes.IV.Length)
    $outStream.Write($cipherBytes, 0, $cipherBytes.Length)
    $outStream.Close()
    $aes.Dispose()

    Log "  -> Secrets encrypted successfully: $EncryptedOutputFile ($([Math]::Round((Get-Item $EncryptedOutputFile).Length / 1KB, 2)) KB)" "Green"

    # Checksums and Manifest Generation
    Log "Calculating individual SHA-256 checksums and finalizing manifest..." "Yellow"
    $allFiles = Get-ChildItem -Path $TargetDir -Recurse -File | Where-Object { $_.Name -ne "backup.log" -and $_.Name -ne "manifest.json" }
    
    $totalBackupBytes = 0
    foreach ($f in $allFiles) {
        $hash = (Get-FileHash -Path $f.FullName -Algorithm SHA256).Hash
        $relPath = $f.FullName.Substring($TargetDir.Length + 1).Replace('\', '/')
        $Manifest.files += @{
            relative_path = $relPath
            size_bytes = $f.Length
            sha256 = $hash
        }
        $totalBackupBytes += $f.Length
    }

    $Manifest.total_files = $Manifest.files.Count
    $Manifest.total_size_bytes = $totalBackupBytes
    $Manifest.total_size_mb = [Math]::Round($totalBackupBytes / 1MB, 2)
    $Manifest.status = "completed"
    $Manifest.completed_at = (Get-Date).ToString("o")
    $Manifest.elapsed_seconds = [Math]::Round(((Get-Date) - $StartTime).TotalSeconds, 2)
    
    $ManifestFile = Join-Path $TargetDir "manifest.json"
    $Manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestFile -Encoding UTF8
    Log "Manifest written to: $ManifestFile (Total: $($Manifest.total_files) files, $($Manifest.total_size_mb) MB)" "Green"

    # Retention Management
    Log "Enforcing retention policy in $BackupRoot..." "Cyan"
    $existingBackups = Get-ChildItem -Path $BackupRoot -Directory | Sort-Object Name
    Log "Found $($existingBackups.Count) total backups on disk." "Gray"

    $dailyCandidates = @()
    $weeklyCandidates = @()

    foreach ($b in $existingBackups) {
        $manPath = Join-Path $b.FullName "manifest.json"
        $isSunday = $false
        if (Test-Path $manPath) {
            try {
                $manData = Get-Content -Path $manPath -Raw | ConvertFrom-Json
                if ($manData.day_of_week -eq "Sunday") {
                    $isSunday = $true
                }
            } catch {
                if ($b.CreationTime.DayOfWeek -eq [System.DayOfWeek]::Sunday) {
                    $isSunday = $true
                }
            }
        } else {
            if ($b.CreationTime.DayOfWeek -eq [System.DayOfWeek]::Sunday) {
                $isSunday = $true
            }
        }

        if ($isSunday) {
            $weeklyCandidates += $b
        } else {
            $dailyCandidates += $b
        }
    }

    # Prune daily if > RetentionDaily
    if ($dailyCandidates.Count -gt $RetentionDaily) {
        $toRemoveDaily = $dailyCandidates | Select-Object -First ($dailyCandidates.Count - $RetentionDaily)
        foreach ($rem in $toRemoveDaily) {
            Log "Pruning expired daily backup: $($rem.Name)" "Yellow"
            Remove-Item -Path $rem.FullName -Recurse -Force
        }
    }

    # Prune weekly if > RetentionWeekly
    if ($weeklyCandidates.Count -gt $RetentionWeekly) {
        $toRemoveWeekly = $weeklyCandidates | Select-Object -First ($weeklyCandidates.Count - $RetentionWeekly)
        foreach ($rem in $toRemoveWeekly) {
            Log "Pruning expired weekly backup: $($rem.Name)" "Yellow"
            Remove-Item -Path $rem.FullName -Recurse -Force
        }
    }

    # Optional secondary copy
    if ($SecondaryPath -and (Test-Path $SecondaryPath)) {
        Log "Synchronizing backup to secondary path: $SecondaryPath..." "Cyan"
        $SecDest = Join-Path $SecondaryPath $DateStr
        Copy-Item -Path $TargetDir -Destination $SecDest -Recurse -Force
        Log "Secondary replication completed: $SecDest" "Green"
    } elseif ($SecondaryPath) {
        Log "WARNING: Secondary path '$SecondaryPath' is not accessible. Secondary sync skipped." "Magenta"
    }

    Log "SUCCESS: SOTRANS Hub backup completed successfully in $($Manifest.elapsed_seconds)s." "Green"

} catch {
    Log "ERROR during backup: $_" "Red"
    $Manifest.status = "failed"
    $Manifest.error = $_.ToString()
    if (Test-Path $TargetDir) {
        $Manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $TargetDir "manifest.json") -Encoding UTF8
    }
    throw $_
}
