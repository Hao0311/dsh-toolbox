# install.ps1 - sync dsh-toolbox into the web profile and register it in cordis.patch.yml.
# ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI).
#
#   powershell -NoProfile -File install.ps1            # install / update
#   powershell -NoProfile -File install.ps1 -Uninstall # remove files + patch block
#
# The plugin is loaded at DSH boot, so a restart is required afterwards:
#   powershell -NoProfile -File D:\Workspaces\DSH\tools\dsh-restart-safe.ps1

param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$Src        = 'D:\Workspaces\DSH\plugins\dsh-toolbox'
$ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$Dest       = Join-Path $ProfileDir 'node_modules\dsh-toolbox'
$PatchFile  = Join-Path $ProfileDir 'cordis.patch.yml'
$Begin      = '# >>> dsh-toolbox (managed by install.ps1)'
$End        = '# <<< dsh-toolbox'

$Block = @"
$Begin
# Injected toolbox: right-side drawer / mobile fullscreen panel - connection info, diagnostics, speed test, quality monitor, history, auto patrol.
# Must use 'insert:' - a patch entry with id+name only OVERRIDES an existing row;
# a new plugin row written that way is silently skipped (same trap as dsh-mobile-console).
- insert:
    - id: toolbox
      name: 'dsh-toolbox'
$End
"@

function Read-Patch {
    if (-not (Test-Path -LiteralPath $PatchFile)) { throw "patch file not found: $PatchFile" }
    return Get-Content -LiteralPath $PatchFile -Raw -Encoding UTF8
}

function Write-Patch([string]$text) {
    $dir = Split-Path -Parent $PatchFile
    $tmp = Join-Path $dir ('.cordis.patch.yml.tmp-' + [guid]::NewGuid().ToString('N'))
    # MUST be UTF-8 without BOM: Windows PowerShell 5.1 Set-Content -Encoding UTF8 adds a BOM,
    # and DSH chokes on a BOM in package.json / patch files (2026-11-02: plugin silently disabled).
    [System.IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $PatchFile -Force
}

function Strip-Block([string]$text) {
    $pattern = '(?s)\r?\n?' + [regex]::Escape($Begin) + '.*?' + [regex]::Escape($End) + '\r?\n?'
    return [regex]::Replace($text, $pattern, "`n")
}

if ($Uninstall) {
    if (Test-Path -LiteralPath $Dest) {
        # 安全修复（2026-11-06 审计 P0/删除纪律）：$Dest 可能是 junction（node_modules 链接）。
        # PS5.1 的 Remove-Item -Recurse 会跟随联接删掉目标真实内容；链接只删链接本体。
        $item = Get-Item -LiteralPath $Dest -Force
        if ($item.LinkType) {
            [System.IO.Directory]::Delete($Dest, $false)
            Write-Host "removed link $Dest (target kept)"
        } else {
            Remove-Item -LiteralPath $Dest -Recurse -Force
            Write-Host "removed $Dest"
        }
    }
    $text = Read-Patch
    $next = (Strip-Block $text).TrimEnd() + "`n"
    if ($next -ne $text) { Write-Patch $next; Write-Host 'patch block removed' }
    Write-Host 'uninstall done. Restart DSH to unload the plugin.'
    exit 0
}

# 1) files
if (-not (Test-Path -LiteralPath $Src)) { throw "source not found: $Src" }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$files = @('package.json', 'index.js', 'client.js', 'client.css', 'README.md')
foreach ($name in $files) {
    $from = Join-Path $Src $name
    if (-not (Test-Path -LiteralPath $from)) { throw "missing source file: $from" }
    Copy-Item -LiteralPath $from -Destination (Join-Path $Dest $name) -Force
}
# Defensive: a BOM in package.json makes DSH fail its plugin validation and silently disable the plugin.
# The source files are BOM-free; this pass just guards against editors/scripts putting it back.
$pkg = Join-Path $Dest 'package.json'
$bytes = [System.IO.File]::ReadAllBytes($pkg)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $t = [System.IO.File]::ReadAllText($pkg, [System.Text.Encoding]::UTF8)
    if ($t.Length -gt 0 -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
    [System.IO.File]::WriteAllText($pkg, $t, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host 'stripped BOM from package.json'
}
Write-Host "synced $($files.Count) files -> $Dest"

# 2) patch entry (idempotent)
$text = Read-Patch
if ($text.Contains($Begin)) {
    $next = [regex]::Replace(
        $text,
        '(?s)' + [regex]::Escape($Begin) + '.*?' + [regex]::Escape($End),
        [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $Block })
} else {
    $next = $text.TrimEnd() + "`n`n" + $Block + "`n"
}
if ($next -ne $text) {
    Copy-Item -LiteralPath $PatchFile -Destination ($PatchFile + '.bak-toolbox') -Force
    Write-Patch $next
    Write-Host "patch entry written: $PatchFile"
} else {
    Write-Host 'patch entry already current'
}

Write-Host ''
Write-Host 'Next: restart DSH, then reload the page.'
Write-Host '  powershell -NoProfile -File D:\Workspaces\DSH\tools\dsh-restart-safe.ps1'
