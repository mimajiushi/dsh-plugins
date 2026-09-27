# Maintainer tool: search a DSH session log (`session.v3.jsonl.zstd`).
#
# Session storage lives in ~/.dsh/sessions/<escaped-workspace>/<session-id>/
# and is a *concatenation of zstd frames*: the harness appends one frame per
# flush, so `zstdDecompressSync(wholeFile)` returns only the first frame (the
# session header). Every frame must be decoded in turn -- that quirk is the
# whole reason this helper exists.
#
# Usage:
#   ./session-log.ps1 -Latest -Workspace Desktop -Pattern compaction -Limit 5
#   ./session-log.ps1 -Latest -Workspace Desktop -Dump          # write decoded jsonl
#   ./session-log.ps1 -Session <dir> -Pattern '"request/header"' -Limit 3
#
# Notes:
#   * This file must stay ASCII-only. Windows PowerShell 5.1 decodes the script
#     as GBK, so non-ASCII literals inside would be corrupted before use.
#   * -Dump writes the decoded JSONL to $env:TEMP\session-decoded.jsonl and
#     prints per-line previews of matches.
param(
  [string]$Session,
  [string]$Workspace,
  [switch]$Latest,
  [string]$Pattern = '.',
  [int]$Limit = 20,
  [switch]$KeysOnly,
  [switch]$Dump
)

$ErrorActionPreference = 'Stop'

if ($Latest -or -not $Session) {
  $root = Join-Path $env:USERPROFILE '.dsh\sessions'
  $dirs = Get-ChildItem $root -Directory
  if ($Workspace) {
    # Workspace dirs look like `--C-Users-<user>-Desktop--`, so match the
    # workspace path as a substring rather than assuming a one-segment name.
    $needle = $Workspace -replace '[\\/:]', '-'
    $dirs = $dirs | Where-Object { $_.Name -like "*$needle*" }
  }
  $cand = foreach ($d in $dirs) {
    Get-ChildItem $d.FullName -Recurse -Filter 'session.v3.jsonl.zstd' -File
  }
  $Session = ($cand | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if ($Session -and (Test-Path $Session -PathType Container)) {
  $Session = Join-Path $Session 'session.v3.jsonl.zstd'
}
if (-not (Test-Path $Session)) { throw "session log not found: $Session" }
Write-Output ("# {0}  ({1:N1} KB, written {2})" -f $Session, ((Get-Item $Session).Length / 1KB), (Get-Item $Session).LastWriteTime)

$env:DSH_SESSION_LOG = $Session
$env:DSH_SESSION_PATTERN = $Pattern
$env:DSH_SESSION_LIMIT = "$Limit"
$env:DSH_SESSION_KEYS = if ($KeysOnly) { '1' } else { '0' }
$env:DSH_SESSION_DUMP = if ($Dump) { '1' } else { '0' }

$js = @'
const fs = require('fs');
const zlib = require('zlib');
const file = process.env.DSH_SESSION_LOG;
const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // zstd frame magic

// Walk frame boundaries by magic, then decode with an explicit input window so
// the decompressor never sees trailing bytes from the next frame.
let text = '';
let frames = 0;
let failed = 0;
let cursor = 0;
while (cursor < buf.length) {
  const next = buf.indexOf(MAGIC, cursor + 4);
  const end = next === -1 ? buf.length : next;
  try {
    text += zlib.zstdDecompressSync(buf.subarray(cursor, end)).toString('utf8');
    frames++;
  } catch (error) {
    failed++;
    if (next === -1) break;
  }
  if (next === -1) break;
  cursor = next;
}

const lines = text.split('\n').filter((l) => l.trim().length > 0);
if (process.env.DSH_SESSION_DUMP === '1') {
  const out = require('path').join(process.env.TEMP, 'session-decoded.jsonl');
  fs.writeFileSync(out, text);
  console.log(`# dumped ${text.length} chars to ${out}`);
}
console.log(`# frames=${frames} failedFrames=${failed} chars=${text.length} lines=${lines.length}`);

const re = new RegExp(process.env.DSH_SESSION_PATTERN);
const limit = Number(process.env.DSH_SESSION_LIMIT);
const keysOnly = process.env.DSH_SESSION_KEYS === '1';
let shown = 0;
let matched = 0;
lines.forEach((line, i) => {
  if (!re.test(line)) return;
  matched++;
  if (shown >= limit) return;
  shown++;
  if (keysOnly) {
    try {
      console.log(`${i + 1}: ${Object.keys(JSON.parse(line)).join(',')}`);
    } catch {
      console.log(`${i + 1}: <unparsed>`);
    }
    return;
  }
  console.log(`${i + 1}: ${line.length > 1500 ? line.slice(0, 1500) + ' ...' : line}`);
});
console.log(`# matched ${matched} lines, showed ${shown}`);
'@
$tmp = Join-Path $env:TEMP 'dsh-session-log-probe.cjs'
[System.IO.File]::WriteAllText($tmp, $js, [System.Text.UTF8Encoding]::new($false))
node $tmp
