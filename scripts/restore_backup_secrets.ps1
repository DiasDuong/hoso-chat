<#
.SYNOPSIS
    SOTRANS Hub - Secret Decryption & Restoration Tool
.DESCRIPTION
    Decrypts AES-256-CBC encrypted secret archives (env_secrets.enc) using the master key.
    Restores .env and credential files to an isolated scratch folder or destination path.
    Never prints or logs confidential values.
.PARAMETER EncryptedFile
    Path to env_secrets.enc archive.
.PARAMETER DestinationDir
    Target directory to extract decrypted configuration files.
.PARAMETER SecretKeyPath
    Path to the master backup key file. Defaults to 'C:\Users\Admin\.sotrans_backup_key'.
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$EncryptedFile,
    
    [Parameter(Mandatory=$true)]
    [string]$DestinationDir,
    
    [string]$SecretKeyPath = "C:\Users\Admin\.sotrans_backup_key"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression

Write-Host "=== SOTRANS Hub - Backup Secret Decryption ===" -ForegroundColor Cyan

if (-not (Test-Path $EncryptedFile)) {
    throw "Encrypted package not found: $EncryptedFile"
}

if (-not (Test-Path $SecretKeyPath)) {
    throw "Master secret key file not found: $SecretKeyPath"
}

$keyRaw = (Get-Content -Path $SecretKeyPath -Raw).Trim()
$keyBytes = [Convert]::FromBase64String($keyRaw)
if ($keyBytes.Length -ne 32) {
    throw "Invalid key size. Expected 256 bits (32 bytes)."
}

$allBytes = [System.IO.File]::ReadAllBytes($EncryptedFile)
if ($allBytes.Length -lt 17) {
    throw "Invalid ciphertext: file size is too small ($($allBytes.Length) bytes)."
}

$iv = New-Object byte[] 16
[Array]::Copy($allBytes, 0, $iv, 0, 16)
$cipherLen = $allBytes.Length - 16
$cipherBytes = New-Object byte[] $cipherLen
[Array]::Copy($allBytes, 16, $cipherBytes, 0, $cipherLen)

$aes = [System.Security.Cryptography.Aes]::Create()
$aes.KeySize = 256
$aes.Key = $keyBytes
$aes.IV = $iv
$aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
$aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7

$decryptor = $aes.CreateDecryptor()
try {
    $plainBytes = $decryptor.TransformFinalBlock($cipherBytes, 0, $cipherBytes.Length)
} catch {
    throw "Decryption failed! The key may be incorrect or ciphertext corrupted. Error: $_"
} finally {
    $aes.Dispose()
}

$memStream = New-Object System.IO.MemoryStream($plainBytes, 0, $plainBytes.Length)
$zipArchive = New-Object System.IO.Compression.ZipArchive($memStream, [System.IO.Compression.ZipArchiveMode]::Read)

if (-not (Test-Path $DestinationDir)) {
    New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
}

Write-Host "Extracting decrypted configuration files to: $DestinationDir" -ForegroundColor Green
$restoredFiles = @()

foreach ($entry in $zipArchive.Entries) {
    $outPath = Join-Path $DestinationDir $entry.FullName
    $outParent = Split-Path -Parent $outPath
    if ($outParent -and (-not (Test-Path $outParent))) {
        New-Item -ItemType Directory -Force -Path $outParent | Out-Null
    }
    
    $eStream = $entry.Open()
    $fStream = [System.IO.File]::Create($outPath)
    $eStream.CopyTo($fStream)
    $fStream.Close()
    $eStream.Close()
    
    $fileInfo = Get-Item $outPath
    $restoredFiles += [PSCustomObject]@{
        Name = $entry.FullName
        SizeBytes = $fileInfo.Length
        RestoredPath = $outPath
    }
    Write-Host "  -> Decrypted and restored: $($entry.FullName) ($($fileInfo.Length) bytes)" -ForegroundColor Gray
}

$zipArchive.Dispose()
$memStream.Dispose()

Write-Host "Decryption complete. $($restoredFiles.Count) secrets safely restored." -ForegroundColor Green
return $restoredFiles
