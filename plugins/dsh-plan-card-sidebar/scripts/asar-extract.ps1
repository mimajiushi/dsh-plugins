# Maintainer tool: read files straight out of an Electron asar archive.
#
# The DSH Desktop build ships its client plugins inside
# `<install>/resources/app.asar`, so the authoritative reference for a slot
# contract, a CSS token, or a core component's markup lives there. This script
# parses the archive header and copies the named entries out, without needing
# 7-Zip or a full unpack.
#
# Usage (PowerShell):
#   ./asar-extract.ps1 `
#     -Asar "D:\software\dsh_desktop\DSH Desktop\resources\app.asar" `
#     -OutDir "$env:TEMP\dsh-src" `
#     -Paths @(
#       "node_modules/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js",
#       "node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/README.zh.md"
#     )
#
# Paths use forward slashes and are relative to the archive root. Directories
# are reported as ISDIR, absent entries as MISSING.
param(
  [Parameter(Mandatory=$true)][string]$Asar,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [Parameter(Mandatory=$true)][string[]]$Paths
)

$fs = [System.IO.File]::OpenRead($Asar)
$br = New-Object System.IO.BinaryReader($fs)
$null = $br.ReadUInt32()
$headerPickleSize = $br.ReadUInt32()
$headerStrSize = $br.ReadUInt32()
$jsonLen = $br.ReadUInt32()
$jsonBytes = $br.ReadBytes($jsonLen)
$json = [System.Text.Encoding]::UTF8.GetString($jsonBytes)
$dataOffset = 8 + $headerPickleSize

$root = $json | ConvertFrom-Json

function Get-Node($root, [string]$path) {
  $node = $root
  foreach ($seg in ($path -split '/')) {
    if ([string]::IsNullOrEmpty($seg)) { continue }
    $node = $node.files.$seg
    if ($null -eq $node) { return $null }
  }
  return $node
}

foreach ($p in $Paths) {
  $node = Get-Node $root $p
  if ($null -eq $node) { Write-Output "MISSING $p"; continue }
  if ($node.PSObject.Properties.Name -contains 'files') { Write-Output "ISDIR   $p"; continue }
  $size = [int64]$node.size
  $off = [int64]$node.offset
  $fs.Seek($dataOffset + $off, [System.IO.SeekOrigin]::Begin) | Out-Null
  $buf = New-Object byte[] $size
  $read = 0
  while ($read -lt $size) {
    $n = $fs.Read($buf, $read, [int]($size - $read))
    if ($n -le 0) { break }
    $read += $n
  }
  $target = Join-Path $OutDir ($p -replace '/', '\')
  $dir = Split-Path $target -Parent
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllBytes($target, $buf)
  Write-Output ("OK      {0}  ({1} bytes)" -f $p, $size)
}
$fs.Close()
