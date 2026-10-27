<#
.SYNOPSIS
  Smart App Control (SAC) audit of a Windows build of Agent Run Monitor.

.DESCRIPTION
  Lists every file in the release that Windows code integrity or Smart App Control evaluates,
  checks its Authenticode signature, and sorts the files into OURS (must be signed by us when
  signing is configured) and THIRD-PARTY (must carry their publisher's valid signature).

  Sources it looks at:
    - the NSIS installer itself, installed silently per user into <Staging>\app (/S /D=...),
      the uninstaller it writes, and the NSIS plug-in DLLs both of them unpack into %TEMP%
      (captured while they run, because SAC checks every DLL a process loads);
    - the win-unpacked folder (-Unpacked) and the portable zip (-Zip, extracted);
    - the file list inside resources\app.asar (JavaScript there is run by Electron, not by
      Windows Script Host, so SAC does not evaluate it; PE files inside the asar are flagged);
    - optionally a runtime report from scripts/runtime-modules.mjs (-RuntimeReport) with every
      process and module the running app loaded.

  File types come from Microsoft's Smart App Control documentation (binaries evaluated at load,
  scripts under App Control script enforcement, and the "dangerous extension" list that is
  blocked when downloaded from the internet). See docs/BLOCK-TEST.md.

  Result:
    -SigningConfigured  exit 1 if any OUR file is not Valid-signed by -ExpectedPublisher with a
                        timestamp, if any third-party file's signature is invalid or missing, or
                        if the release ships a file Windows could run that cannot be signed.
    otherwise           report everything, exit 0.
  Exit 2 means the script itself could not run (bad arguments) or the installer failed; the
  reports are still written when the installer fails.

  Static checks are evidence, not proof: SAC also asks Microsoft's cloud reputation service.
  Written for Windows PowerShell 5.1 and PowerShell 7, and to work in Constrained Language Mode
  (an unsigned script on a machine with SAC on runs in CLM): cmdlets only, no Add-Type. Root
  certificate details need Full Language mode and are reported as unknown otherwise.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-blocks.ps1 `
    -Installer release\0.1.0\agent-run-monitor-0.1.0-setup-x64.exe `
    -Unpacked release\0.1.0\win-unpacked -Zip release\0.1.0\agent-run-monitor-0.1.0-win-x64.zip `
    -Staging $env:TEMP\arm-sac -ReportPath $env:TEMP\arm-sac\check-blocks.md

.EXAMPLE
  # Signature check only, for a list of paths (one per line); used by runtime-modules.mjs.
  powershell -NoProfile -File scripts\check-blocks.ps1 -SignatureOnly -PathList paths.txt -ReportPath sigs.json
#>
[CmdletBinding()]
param(
  [string]$Installer,
  [string]$Unpacked,
  [string]$Zip,
  [string]$Staging,
  [switch]$SigningConfigured,
  [string]$ExpectedPublisher,
  [string]$ReportPath,
  [string]$RuntimeReport,
  [string]$ProductName = 'Agent Run Monitor',
  # Only check the installer's signature, do not run it (for example an arm64 installer on x64).
  [switch]$NoInstall,
  # Install even if this product is already installed for this user (the installer would
  # replace that installation).
  [switch]$AllowExistingInstall,
  [switch]$KeepStaging,
  [switch]$SignatureOnly,
  [string]$PathList
)

$ErrorActionPreference = 'Stop'
$script:FullLanguage = ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage')
$script:PsMajor = $PSVersionTable.PSVersion.Major

# ---- file types ----------------------------------------------------------------------------------

# Portable executables: code integrity evaluates every image load, whatever the extension.
$PeExts = @('.exe', '.dll', '.node', '.sys', '.drv', '.ocx', '.cpl', '.scr', '.com', '.efi', '.mui', '.ax', '.tlb', '.winmd')
# Script hosts under App Control script enforcement (PowerShell, Windows Script Host, MSHTA).
$ScriptExts = @('.ps1', '.psm1', '.psd1', '.js', '.jse', '.vbs', '.vbe', '.vb', '.wsf', '.wsh', '.hta', '.bat', '.cmd')
# Installers and packages that need their own signature.
$PackageExts = @('.msi', '.msp', '.msix', '.msixbundle', '.appx', '.appxbundle', '.appref-ms', '.ppkg')
# Blocked by SAC when downloaded from the internet (Microsoft's list), beyond the groups above.
$MotwExts = @('.chm', '.gadget', '.iso', '.lnk', '.msc', '.pif', '.printerexport', '.rdp', '.reg', '.scf',
  '.settingcontent-ms', '.url', '.vhd', '.vhdx', '.vxd', '.wcx', '.website')
$AllExts = $PeExts + $ScriptExts + $PackageExts + $MotwExts
# Types with no Authenticode subject interface package: they cannot carry a signature.
$UnsignableExts = @('.bat', '.cmd', '.lnk', '.url', '.website', '.reg', '.chm', '.hta', '.iso', '.vhd', '.vhdx',
  '.scf', '.settingcontent-ms', '.pif', '.gadget', '.printerexport', '.rdp', '.wcx', '.msc')

# Files that carry, or should carry, their publisher's signature (name => publisher text in the
# signer subject). Measured on Electron 45.0.0: only d3dcompiler_47.dll is signed upstream.
$KnownThirdParty = @{
  'd3dcompiler_47.dll' = 'Microsoft'
}

# ---- helpers -------------------------------------------------------------------------------------

function Get-Ext([string]$Path) {
  $leaf = Split-Path -Leaf $Path
  $i = $leaf.LastIndexOf('.')
  if ($i -lt 0) { return '' }
  return $leaf.Substring($i).ToLowerInvariant()
}

function Read-Bytes([string]$Path, [int]$Count) {
  # The first $Count bytes. (With -ReadCount 0, Get-Content ignores -TotalCount and reads the
  # whole file.)
  if ($script:FullLanguage) {
    $fs = [System.IO.File]::OpenRead($Path)
    try {
      $buf = New-Object byte[] $Count
      $n = 0
      while ($n -lt $Count) {
        $got = $fs.Read($buf, $n, $Count - $n)
        if ($got -le 0) { break }
        $n += $got
      }
      if ($n -eq 0) { return @() }
      if ($n -lt $Count) { return $buf[0..($n - 1)] }
      return $buf
    } finally {
      $fs.Dispose()
    }
  }
  # Constrained Language Mode: cmdlets only. With -ReadCount equal to -TotalCount, Get-Content
  # emits one chunk (an array) and the assignment stores that array; returning the variable
  # unrolls it into bytes for the caller.
  if ($script:PsMajor -ge 6) {
    $chunks = Get-Content -LiteralPath $Path -AsByteStream -TotalCount $Count -ReadCount $Count -ErrorAction Stop
  } else {
    $chunks = Get-Content -LiteralPath $Path -Encoding Byte -TotalCount $Count -ReadCount $Count -ErrorAction Stop
  }
  return $chunks
}

function Test-IsPe([string]$Path) {
  try {
    $b = @(Read-Bytes $Path 2)
    return ($b.Count -ge 2 -and $b[0] -eq 0x4D -and $b[1] -eq 0x5A)
  } catch {
    return $false
  }
}

function Test-Contains([string]$Text, [string]$Part) {
  if (-not $Text -or -not $Part) { return $false }
  return $Text.ToLowerInvariant().Contains($Part.ToLowerInvariant())
}

function Get-RootInfo($Cert) {
  # Returns the chain's root (subject, thumbprint) and which local store holds it.
  $info = [ordered]@{ rootSubject = $null; rootThumbprint = $null; rootStore = 'unknown'; rootPublic = $null }
  if ($null -eq $Cert) { return $info }
  if ($Cert.Subject -eq $Cert.Issuer) {
    $info.rootSubject = $Cert.Subject; $info.rootThumbprint = $Cert.Thumbprint
    $info.rootStore = 'self-signed-leaf'; $info.rootPublic = $false
    return $info
  }
  if (-not $script:FullLanguage) {
    $info.rootStore = 'unknown (Constrained Language Mode)'
    return $info
  }
  try {
    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = 'NoCheck'
    [void]$chain.Build($Cert)
    $els = $chain.ChainElements
    $root = $els[$els.Count - 1].Certificate
    $info.rootSubject = $root.Subject
    $info.rootThumbprint = $root.Thumbprint
    $t = $root.Thumbprint
    $inAuth = Test-Path -LiteralPath "Cert:\LocalMachine\AuthRoot\$t"
    $inLm = Test-Path -LiteralPath "Cert:\LocalMachine\Root\$t"
    $inCu = Test-Path -LiteralPath "Cert:\CurrentUser\Root\$t"
    if ($root.Subject -ne $root.Issuer) {
      $info.rootStore = 'incomplete-chain'; $info.rootPublic = $false
    } elseif ($inAuth) {
      $info.rootStore = 'LocalMachine\AuthRoot'; $info.rootPublic = $true
    } elseif ($inLm -and (Test-Contains $root.Subject 'Microsoft')) {
      $info.rootStore = 'LocalMachine\Root (Microsoft)'; $info.rootPublic = $true
    } elseif ($inLm) {
      # Most public roots ship here too, but so does any root an administrator added.
      $info.rootStore = 'LocalMachine\Root'; $info.rootPublic = $null
    } elseif ($inCu) {
      $info.rootStore = 'CurrentUser\Root only'; $info.rootPublic = $false
    } else {
      $info.rootStore = 'not in a local root store'; $info.rootPublic = $false
    }
  } catch {
    $info.rootStore = "unknown ($($_.Exception.Message))"
  }
  return $info
}

function Get-SigInfo([string]$Path) {
  $ext = Get-Ext $Path
  $r = [ordered]@{
    status = $null; statusMessage = $null; signatureType = $null; signerSubject = $null; signerIssuer = $null
    signerThumbprint = $null; signerNotAfter = $null; timestamped = $false; timestamperSubject = $null
    isOSBinary = $null; eku = @(); rootSubject = $null; rootThumbprint = $null; rootStore = $null; rootPublic = $null
    unsignable = $false
  }
  try {
    $s = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
  } catch {
    $r.status = 'Error'; $r.statusMessage = $_.Exception.Message
    return $r
  }
  $r.status = [string]$s.Status
  $r.statusMessage = [string]$s.StatusMessage
  $r.signatureType = [string]$s.SignatureType
  $r.isOSBinary = $s.IsOSBinary
  if ($s.SignerCertificate) {
    $c = $s.SignerCertificate
    $r.signerSubject = $c.Subject
    $r.signerIssuer = $c.Issuer
    $r.signerThumbprint = $c.Thumbprint
    $r.signerNotAfter = $c.NotAfter.ToString('s')
    try { $r.eku = @($c.EnhancedKeyUsageList | ForEach-Object { "$($_.FriendlyName) ($($_.ObjectId))" }) } catch { $r.eku = @() }
    $root = Get-RootInfo $c
    foreach ($k in $root.Keys) { $r[$k] = $root[$k] }
  }
  if ($s.TimeStamperCertificate) {
    $r.timestamped = $true
    $r.timestamperSubject = $s.TimeStamperCertificate.Subject
  }
  # .bat/.cmd/.lnk... report UnknownError ("form specified for the subject is not one supported").
  if ($UnsignableExts -contains $ext -and $r.status -ne 'Valid') {
    $r.unsignable = $true
    $r.status = 'CannotBeSigned'
  }
  return $r
}

function Get-RelativePath([string]$Path, [string]$Root) {
  if ($Root -and $Path.ToLowerInvariant().StartsWith($Root.ToLowerInvariant())) {
    return $Path.Substring($Root.Length).TrimStart('\', '/')
  }
  return $Path
}

$script:AsarCache = @{}
$script:ExtSet = @{}; foreach ($x in $AllExts) { $script:ExtSet[$x] = $true }
$script:PeSet = @{}; foreach ($x in $PeExts) { $script:PeSet[$x] = $true }
$script:ScriptSet = @{}; foreach ($x in $ScriptExts) { $script:ScriptSet[$x] = $true }

function Get-AsarSummary([string]$AsarPath) {
  # app.asar = Chromium Pickle: uint32 4, uint32 header size, uint32 payload size, uint32 JSON
  # length, then the JSON header listing every file.
  $head = @(Read-Bytes $AsarPath 16)
  $len = [int64]$head[12] + [int64]$head[13] * 256 + [int64]$head[14] * 65536 + [int64]$head[15] * 16777216
  if ($len -le 0 -or $len -gt 268435456) { throw "unexpected asar header length $len" }
  # The same asar sits in the install folder, win-unpacked and the zip: read it once.
  $cacheKey = "$((Get-Item -LiteralPath $AsarPath).Length)/$len"
  if ($script:AsarCache.ContainsKey($cacheKey)) { return $script:AsarCache[$cacheKey] }
  $bytes = Read-Bytes $AsarPath ([int](16 + $len))
  if ($script:FullLanguage) {
    $json = [System.Text.Encoding]::UTF8.GetString($bytes, 16, [int]$len)
  } else {
    $json = -join [char[]]$bytes[16..(15 + [int]$len)]
  }
  $tree = ConvertFrom-Json $json
  $acc = @{ files = 0; js = 0; pe = @(); scripts = @() }
  $exec = @(Add-AsarFiles $tree '' $acc)
  $sum = [ordered]@{
    key = $cacheKey; files = $acc.files; js = $acc.js
    peInside = $acc.pe; scriptsInside = $acc.scripts; executableTypes = $exec
  }
  $script:AsarCache[$cacheKey] = $sum
  return $sum
}

function Add-AsarFiles($Node, [string]$Prefix, $Acc) {
  # One call per folder; the per-file work is plain string operations. Writes the paths of
  # executable-type files to the pipeline and counts into $Acc.
  if ($null -eq $Node.files) { return }
  foreach ($p in $Node.files.PSObject.Properties) {
    $rel = if ($Prefix) { $Prefix + '/' + $p.Name } else { $p.Name }
    if ($null -ne $p.Value.files) { Add-AsarFiles $p.Value $rel $Acc; continue }
    $Acc.files++
    $dot = $p.Name.LastIndexOf('.')
    if ($dot -lt 0) { continue }
    $ext = $p.Name.Substring($dot).ToLowerInvariant()
    if (-not $script:ExtSet.ContainsKey($ext)) { continue }
    $unpacked = [bool]$p.Value.unpacked
    # Executable-type paths go to the pipeline (linear time, unlike += on an array).
    if ($unpacked) { "$rel (unpacked)" } else { $rel }
    if ($unpacked) { continue }   # unpacked files are on disk and checked like any other file
    if ($ext -eq '.js' -or $ext -eq '.jse') { $Acc.js++ }
    elseif ($script:PeSet.ContainsKey($ext)) { $Acc.pe += $rel }
    elseif ($script:ScriptSet.ContainsKey($ext)) { $Acc.scripts += $rel }
  }
}

function Invoke-Capture([string]$TempDir, [string]$Into) {
  # Copy the code files the installer or uninstaller has unpacked into its temp folder so far
  # (NSIS plug-in DLLs, a relaunched uninstaller). The app payload the NSIS installer extracts
  # to a 7z-out folder before moving it into place is the same set of files as the install
  # folder, so it is not copied again.
  foreach ($d in @(Get-ChildItem -LiteralPath $TempDir -Directory -Force -ErrorAction SilentlyContinue)) {
    foreach ($f in @(Get-ChildItem -LiteralPath $d.FullName -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      $rel = Get-RelativePath $f.FullName $d.FullName
      if ($rel.ToLowerInvariant().StartsWith('7z-out')) { continue }
      $dest = Join-Path (Join-Path $Into $d.Name) $rel
      if (Test-Path -LiteralPath $dest) { continue }
      if (-not ($AllExts -contains (Get-Ext $f.FullName)) -and -not (Test-IsPe $f.FullName)) { continue }
      $parent = Split-Path -Parent $dest
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      try { Copy-Item -LiteralPath $f.FullName -Destination $dest -Force -ErrorAction Stop } catch { }
    }
  }
}

function Start-Captured([string]$Exe, [string]$Arguments, [string]$TempDir, [string]$Into, [int]$TimeoutSec) {
  # Runs a process with TEMP/TMP pointed at $TempDir and copies what it unpacks there.
  New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
  $oldTemp = $env:TEMP; $oldTmp = $env:TMP
  $env:TEMP = $TempDir; $env:TMP = $TempDir
  try {
    $p = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
  } finally {
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp
  }
  $null = $p.Handle # keeps ExitCode readable on Windows PowerShell
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while (-not $p.HasExited -and (Get-Date) -lt $deadline) {
    Invoke-Capture $TempDir $Into
    Start-Sleep -Milliseconds 100
  }
  Invoke-Capture $TempDir $Into
  if (-not $p.HasExited) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    throw "$Exe did not finish within $TimeoutSec s"
  }
  return $p.ExitCode
}

function Get-UninstallEntries([string]$Name) {
  $keys = @(Get-ChildItem -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue)
  # .location comes from InstallLocation or, when the NSIS installer leaves that empty, from the
  # folder of the UninstallString.
  $out = @()
  foreach ($k in $keys) {
    $v = Get-ItemProperty -LiteralPath $k.PSPath -ErrorAction SilentlyContinue
    if (-not ($v -and $v.DisplayName -and $v.DisplayName.StartsWith($Name))) { continue }
    $loc = $v.InstallLocation
    if (-not $loc -and $v.UninstallString -match '^"([^"]+)"') { $loc = Split-Path -Parent $Matches[1] }
    $out += [ordered]@{ key = $k.PSPath; name = $v.DisplayName; location = $loc }
  }
  return $out
}

function Get-ShortcutPaths([string]$Name) {
  $desk = $null
  try { $desk = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders' -ErrorAction Stop).Desktop } catch { }
  if (-not $desk) { $desk = Join-Path $env:USERPROFILE 'Desktop' }
  $start = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  return @((Join-Path $desk "$Name.lnk"), (Join-Path $start "$Name.lnk"))
}

# ---- signature-only mode (used by runtime-modules.mjs) -------------------------------------------

if ($SignatureOnly) {
  if (-not $PathList -or -not (Test-Path -LiteralPath $PathList)) { Write-Error '-SignatureOnly needs -PathList <file>'; exit 2 }
  $rows = @()
  foreach ($line in @(Get-Content -LiteralPath $PathList)) {
    $p = $line.Trim()
    if (-not $p) { continue }
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
      $rows += [ordered]@{ path = $p; exists = $false; signature = $null }
      continue
    }
    $rows += [ordered]@{ path = $p; exists = $true; isPe = (Test-IsPe $p); signature = (Get-SigInfo $p) }
  }
  $json = ConvertTo-Json -InputObject @($rows) -Depth 6
  if ($ReportPath) { Set-Content -LiteralPath $ReportPath -Value $json -Encoding UTF8 } else { $json }
  exit 0
}

# ---- arguments -----------------------------------------------------------------------------------

if (-not $Installer -and -not $Unpacked -and -not $Zip -and -not $RuntimeReport) {
  Write-Error 'Nothing to check: pass -Installer, -Unpacked, -Zip and/or -RuntimeReport.'
  exit 2
}
if ($SigningConfigured -and -not $ExpectedPublisher) {
  Write-Error '-SigningConfigured needs -ExpectedPublisher (text that appears in our certificate subject, e.g. CN=Your Name).'
  exit 2
}
foreach ($pair in @(@('Installer', $Installer), @('Unpacked', $Unpacked), @('Zip', $Zip), @('RuntimeReport', $RuntimeReport))) {
  if ($pair[1] -and -not (Test-Path -LiteralPath $pair[1])) { Write-Error "-$($pair[0]) not found: $($pair[1])"; exit 2 }
}
if (-not $Staging) { $Staging = Join-Path $env:TEMP ('arm-check-blocks-' + (Get-Date -Format 'yyyyMMddHHmmss')) }
if (-not $ReportPath) { $ReportPath = Join-Path $Staging 'check-blocks.md' }
$Staging = (New-Item -ItemType Directory -Path $Staging -Force).FullName
if ($Installer) { $Installer = (Resolve-Path -LiteralPath $Installer).Path }
if ($Unpacked) { $Unpacked = (Resolve-Path -LiteralPath $Unpacked).Path }
if ($Zip) { $Zip = (Resolve-Path -LiteralPath $Zip).Path }
$reportDir = Split-Path -Parent $ReportPath
if ($reportDir -and -not (Test-Path -LiteralPath $reportDir)) { New-Item -ItemType Directory -Path $reportDir -Force | Out-Null }
$JsonPath = if ($ReportPath.ToLowerInvariant().EndsWith('.md')) { $ReportPath.Substring(0, $ReportPath.Length - 3) + '.json' } else { "$ReportPath.json" }

$notes = @()
$sources = @()          # @{ origin; root; label }
$loose = @()            # @{ path; origin; root; role }
$installDir = Join-Path $Staging 'app'
$installed = $false
$installError = $null

function Write-Phase([string]$Text) { Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Text) }

# ---- (a) install / extract -----------------------------------------------------------------------

Write-Phase 'start'
if ($Installer) {
  $loose += @{ path = $Installer; origin = 'installer'; root = (Split-Path -Parent $Installer); role = 'installer' }
  $existing = @(Get-UninstallEntries $ProductName | Where-Object {
      -not $_.location -or -not $_.location.ToLowerInvariant().StartsWith($Staging.ToLowerInvariant()) })
  if ($NoInstall) {
    $notes += 'Installer not run (-NoInstall): its uninstaller and unpacked plug-ins were not checked.'
  } elseif ($existing.Count -gt 0 -and -not $AllowExistingInstall) {
    $notes += "Installer not run: '$ProductName' is already installed for this user at $($existing[0].location); installing would replace it. Uninstall it or pass -AllowExistingInstall."
  } else {
    $shortcutsBefore = @(Get-ShortcutPaths $ProductName | Where-Object { Test-Path -LiteralPath $_ })
    Write-Phase "Installing silently into $installDir"
    try {
      $code = Start-Captured $Installer "/S /D=$installDir" (Join-Path $Staging 'installer-temp') (Join-Path $Staging 'captured\installer') 300
      if ($code -ne 0) { throw "installer exit code $code" }
      if (-not (Test-Path -LiteralPath $installDir)) { throw "installer finished but $installDir does not exist (/D not honoured?)" }
      $installed = $true
      $sources += @{ origin = 'installed'; root = $installDir; label = "Installed by the NSIS installer (/S /D=...)" }
      foreach ($lnk in @(Get-ShortcutPaths $ProductName)) {
        if ((Test-Path -LiteralPath $lnk) -and -not ($shortcutsBefore -contains $lnk)) {
          $loose += @{ path = $lnk; origin = 'shortcut'; root = (Split-Path -Parent $lnk); role = 'shortcut' }
        }
      }
    } catch {
      $installError = $_.Exception.Message
      $notes += "Installer failed: $installError"
    }
    $sources += @{ origin = 'installer-temp'; root = (Join-Path $Staging 'captured\installer'); label = 'Unpacked into %TEMP% by the installer while it ran' }
  }
}

if ($Zip) {
  $zipDir = Join-Path $Staging 'zip'
  if (Test-Path -LiteralPath $zipDir) { Remove-Item -LiteralPath $zipDir -Recurse -Force }
  Write-Phase "Extracting $(Split-Path -Leaf $Zip)"
  try {
    Expand-Archive -LiteralPath $Zip -DestinationPath $zipDir -Force -ErrorAction Stop
  } catch {
    # Expand-Archive can be unavailable (for example in a constrained session); tar.exe ships
    # with Windows 10 and later and reads zip files.
    Write-Phase "Expand-Archive failed ($($_.Exception.Message)); using tar.exe"
    New-Item -ItemType Directory -Path $zipDir -Force | Out-Null
    & tar.exe -xf $Zip -C $zipDir
    if ($LASTEXITCODE -ne 0) { Write-Error "could not extract $Zip"; exit 2 }
  }
  $sources += @{ origin = 'zip'; root = $zipDir; label = 'Portable zip, extracted' }
}
if ($Unpacked) { $sources += @{ origin = 'unpacked'; root = $Unpacked; label = 'win-unpacked folder' } }

# ---- (b) enumerate -------------------------------------------------------------------------------

Write-Phase 'listing files'
$entries = @()
$asarReports = @()
$skippedCount = 0

function Get-Role([string]$Path, [string]$Root, [string]$Origin) {
  $leaf = (Split-Path -Leaf $Path).ToLowerInvariant()
  $rel = (Get-RelativePath $Path $Root).ToLowerInvariant()
  $ext = Get-Ext $Path
  if ($Origin -eq 'installer-temp' -and $ext -eq '.dll') { return 'NSIS plug-in (installer temp)' }
  if ($Origin -eq 'installer-temp') { return 'installer temp file' }
  if ($Origin -eq 'uninstaller-temp' -and $ext -eq '.dll') { return 'NSIS plug-in (uninstaller temp)' }
  if ($Origin -eq 'uninstaller-temp') { return 'uninstaller temp file' }
  if ($leaf.StartsWith('uninstall ') -and $ext -eq '.exe') { return 'uninstaller' }
  if ($leaf -eq 'elevate.exe') { return 'elevate.exe (NSIS helper)' }
  if ($rel.Contains('app.asar.unpacked')) { return 'unpacked from asar' }
  if ($ext -eq '.node') { return 'native module' }
  if (-not $rel.Contains('\') -and -not $rel.Contains('/')) {
    if ($ext -eq '.exe') { return 'app executable' }
    if ($PeExts -contains $ext) { return 'Electron runtime' }
  }
  if ($ScriptExts -contains $ext) { return 'loose script' }
  return 'other'
}

foreach ($src in $sources) {
  if (-not (Test-Path -LiteralPath $src.root)) { continue }
  foreach ($f in @(Get-ChildItem -LiteralPath $src.root -Recurse -File -Force -ErrorAction SilentlyContinue)) {
    $ext = Get-Ext $f.FullName
    $known = $AllExts -contains $ext
    $isPe = Test-IsPe $f.FullName
    if ($ext -eq '.asar') {
      try {
        $sum = Get-AsarSummary $f.FullName
        # The full list of executable-type paths goes into the JSON once per distinct asar.
        $first = @($asarReports | Where-Object { $_.key -eq $sum.key }).Count -eq 0
        $asarReports += [ordered]@{
          origin = $src.origin; path = (Get-RelativePath $f.FullName $src.root); key = $sum.key; files = $sum.files
          js = $sum.js; peInside = $sum.peInside; scriptsInside = $sum.scriptsInside
          executableTypes = if ($first) { $sum.executableTypes } else { @('(same app.asar as above)') }
          note = 'not evaluated by SAC (inside asar, run by the app)'
        }
      } catch {
        $notes += "Could not read $($f.FullName): $($_.Exception.Message)"
      }
      continue
    }
    if (-not $known -and -not $isPe) { $skippedCount++; continue }
    $loose += @{ path = $f.FullName; origin = $src.origin; root = $src.root; role = (Get-Role $f.FullName $src.root $src.origin) }
  }
}

# ---- (c) signatures, (d) classification ----------------------------------------------------------

function Get-Verdict($e) {
  # Returns @{ owner; risk; fail (bool, only when signing is configured); reason }
  $sig = $e.signature
  $ext = $e.ext
  $leaf = (Split-Path -Leaf $e.path).ToLowerInvariant()
  $signedByUs = $SigningConfigured -and $sig.status -eq 'Valid' -and (Test-Contains $sig.signerSubject $ExpectedPublisher)
  $expected = $KnownThirdParty[$leaf]

  if ($e.role -eq 'shortcut') {
    return @{ owner = 'OURS'; risk = 'none (written on this PC by the installer, no Mark of the Web)'; fail = $false; reason = 'shortcut created locally' }
  }
  if ($e.inAsar) {
    return @{ owner = 'OURS'; risk = 'not evaluated by SAC (inside asar, run by the app)'; fail = $false; reason = '' }
  }

  # Owner.
  $owner = 'OURS'
  if ($sig.signatureType -eq 'Catalog') { $owner = 'THIRD-PARTY' }
  elseif ($expected) { $owner = 'THIRD-PARTY' }
  elseif ($sig.signerSubject -and -not $signedByUs -and $e.role -notin @('installer', 'uninstaller', 'app executable')) {
    if (-not $ExpectedPublisher -or -not (Test-Contains $sig.signerSubject $ExpectedPublisher)) { $owner = 'THIRD-PARTY' }
  }

  $isScript = $ScriptExts -contains $ext
  $isPeType = $e.isPe -or ($PeExts -contains $ext) -or ($PackageExts -contains $ext)

  # Risk, independent of configuration.
  $risk = 'none'
  switch ($sig.status) {
    'Valid' {
      if ($sig.signatureType -ne 'Catalog' -and -not $sig.timestamped) { $risk = 'signature expires with the certificate (no timestamp)' }
      elseif ($sig.rootPublic -eq $false) { $risk = "blocked: root is not publicly trusted ($($sig.rootStore))" }
      elseif ($isScript -and @('.ps1', '.psm1', '.psd1') -contains $ext) { $risk = 'runs in Constrained Language Mode unless its root is trusted on the device' }
    }
    'NotSigned' {
      if ($isPeType) { $risk = 'blocked unless cloud reputation allows it (unsigned)' }
      elseif ($isScript) { $risk = 'blocked if run by Windows (unsigned script; always blocked when downloaded)' }
      else { $risk = 'blocked if downloaded (Mark of the Web)' }
    }
    'CannotBeSigned' {
      if ($e.origin -eq 'zip') { $risk = 'blocked when the zip is downloaded (cannot be signed)' }
      elseif (@('.bat', '.cmd') -contains $ext) { $risk = 'cannot be signed; blocked when downloaded' }
      else { $risk = 'cannot be signed; blocked when downloaded' }
    }
    default { $risk = "blocked: signature $($sig.status)" }
  }

  # Failure rules (only applied with -SigningConfigured).
  $fail = $false; $reason = ''
  if ($owner -eq 'OURS') {
    if ($sig.status -eq 'CannotBeSigned') { $fail = $true; $reason = 'Windows could run this file and it cannot be signed: do not ship it' }
    elseif (-not $signedByUs) { $fail = $true; $reason = if ($sig.status -eq 'Valid') { "signed by '$($sig.signerSubject)', not by '$ExpectedPublisher'" } else { "not signed by us ($($sig.status))" } }
    elseif (-not $sig.timestamped) { $fail = $true; $reason = 'signed without a timestamp' }
    elseif ($sig.rootPublic -eq $false) { $fail = $true; $reason = "root not publicly trusted ($($sig.rootStore))" }
  } else {
    if ($sig.status -eq 'Valid') {
      $okPublisher = (-not $expected) -or (Test-Contains $sig.signerSubject $expected) -or $signedByUs -or ($sig.signatureType -eq 'Catalog')
      if (-not $okPublisher) { $fail = $true; $reason = "expected a signature from '$expected', found '$($sig.signerSubject)'" }
      elseif ($sig.rootPublic -eq $false) { $fail = $true; $reason = "root not publicly trusted ($($sig.rootStore))" }
    } elseif ($sig.status -eq 'NotSigned') {
      $fail = $true; $reason = 'third-party file without its publisher signature (and not signed by us)'
    } else {
      $fail = $true; $reason = "invalid signature: $($sig.status)"
    }
  }
  return @{ owner = $owner; risk = $risk; fail = $fail; reason = $reason }
}

Write-Phase "Checking signatures of $($loose.Count) files"
$i = 0
foreach ($l in $loose) {
  $i++
  Write-Progress -Activity 'Checking signatures' -Status (Split-Path -Leaf $l.path) -PercentComplete ([int](100 * $i / ($loose.Count + 1)))
  $e = [ordered]@{
    origin = $l.origin; role = $l.role; path = $l.path; relativePath = (Get-RelativePath $l.path $l.root)
    ext = (Get-Ext $l.path); isPe = (Test-IsPe $l.path); inAsar = $false; step = $null
    signature = (Get-SigInfo $l.path)
  }
  $v = Get-Verdict $e
  $e.owner = $v.owner; $e.risk = $v.risk; $e.wouldFail = $v.fail; $e.failReason = $v.reason
  $entries += $e
}
Write-Progress -Activity 'Checking signatures' -Completed

# asar contents as entries (not evaluated) plus PE / script files packed inside it (flagged).
foreach ($a in $asarReports) {
  foreach ($pe in $a.peInside) {
    $entries += [ordered]@{
      origin = $a.origin; role = 'PE file packed inside app.asar'; path = "$($a.path)!/$pe"; relativePath = "$($a.path)!/$pe"
      ext = (Get-Ext $pe); isPe = $true; inAsar = $true; step = $null; signature = [ordered]@{ status = 'Unknown (inside asar)' }
      owner = 'OURS'; risk = 'Electron copies it to %TEMP% to load it: an unsigned DLL load SAC will evaluate'; wouldFail = $true
      failReason = 'native code inside app.asar cannot be signed in place; add it to asarUnpack so signExts signs it'
    }
  }
}

# ---- runtime report ------------------------------------------------------------------------------

$runtime = $null
if ($RuntimeReport) {
  $runtime = Get-Content -LiteralPath $RuntimeReport -Raw | ConvertFrom-Json
  foreach ($r in @($runtime.runtimeOnly)) {
    if (-not $r.signature) { continue }
    $sig = [ordered]@{}
    foreach ($p in $r.signature.PSObject.Properties) { $sig[$p.Name] = $p.Value }
    $e = [ordered]@{
      origin = "runtime ($($r.location))"; role = "loaded at runtime by $($r.processName)"; path = $r.path; relativePath = $r.path
      ext = (Get-Ext $r.path); isPe = [bool]$r.isPe; inAsar = $false; step = $r.firstSeenStep; signature = $sig
    }
    if ($r.location -eq 'system') {
      $e.owner = 'SYSTEM'
      $bad = @('HashMismatch', 'NotTrusted', 'UnknownError', 'Incompatible') -contains $sig.status
      $e.risk = if ($sig.status -eq 'Valid') { 'none (Windows file)' } else { "Windows file with signature $($sig.status)" }
      $e.wouldFail = $bad; $e.failReason = if ($bad) { "invalid signature: $($sig.status)" } else { '' }
    } elseif ($r.location -eq 'other') {
      # Software installed on the test machine that injects into every process (audio effects,
      # security tools...). Not part of the release: reported, never a failure.
      $e.owner = 'THIS MACHINE'
      $e.risk = if ($sig.status -eq 'Valid') { 'none (installed on this machine, not shipped)' } else { "installed on this machine, not shipped; signature $($sig.status)" }
      $e.wouldFail = $false; $e.failReason = ''
    } else {
      $v = Get-Verdict $e
      if ($r.location -in @('profile', 'temp', 'app')) { $v.owner = 'OURS' }
      $e.owner = $v.owner; $e.risk = $v.risk; $e.wouldFail = $v.fail; $e.failReason = $v.reason
    }
    $entries += $e
  }
}

# ---- (g) uninstall (before the reports, so they include what the uninstaller unpacks) -----------

if ($installed) {
  $un = @(Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($un.Count) {
    Write-Phase "Uninstalling $($un[0].Name)"
    try {
      $null = Start-Captured $un[0].FullName '/S' (Join-Path $Staging 'uninstaller-temp') (Join-Path $Staging 'captured\uninstaller') 180
      # The NSIS uninstaller copies itself to %TEMP% and removes the folder from there.
      $deadline = (Get-Date).AddSeconds(90)
      while ((Test-Path -LiteralPath (Join-Path $installDir $un[0].Name)) -and (Get-Date) -lt $deadline) {
        Invoke-Capture (Join-Path $Staging 'uninstaller-temp') (Join-Path $Staging 'captured\uninstaller')
        Start-Sleep -Milliseconds 200
      }
      Invoke-Capture (Join-Path $Staging 'uninstaller-temp') (Join-Path $Staging 'captured\uninstaller')
      # Then wait for that copy (Un_A.exe) to exit: it removes the registry entries last.
      $unTemp = (Join-Path $Staging 'uninstaller-temp').ToLowerInvariant()
      $deadline = (Get-Date).AddSeconds(120)
      while ((Get-Date) -lt $deadline) {
        $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLowerInvariant().StartsWith($unTemp) })
        if ($running.Count -eq 0) { break }
        Invoke-Capture (Join-Path $Staging 'uninstaller-temp') (Join-Path $Staging 'captured\uninstaller')
        Start-Sleep -Milliseconds 300
      }
    } catch {
      Write-Warning "Uninstall failed: $($_.Exception.Message)"
    }
  }
  # Anything the uninstaller unpacked is part of the release too: check it and add it to the reports.
  $uncap = Join-Path $Staging 'captured\uninstaller'
  $added = @()
  foreach ($f in @(Get-ChildItem -LiteralPath $uncap -Recurse -File -Force -ErrorAction SilentlyContinue)) {
    $ext = Get-Ext $f.FullName
    if (-not ($AllExts -contains $ext) -and -not (Test-IsPe $f.FullName)) { continue }
    $e = [ordered]@{
      origin = 'uninstaller-temp'; role = (Get-Role $f.FullName $uncap 'uninstaller-temp'); path = $f.FullName; relativePath = (Get-RelativePath $f.FullName $uncap)
      ext = $ext; isPe = (Test-IsPe $f.FullName); inAsar = $false; step = $null; signature = (Get-SigInfo $f.FullName)
    }
    $v = Get-Verdict $e
    $e.owner = $v.owner; $e.risk = $v.risk; $e.wouldFail = $v.fail; $e.failReason = $v.reason
    $added += $e
  }
  $entries += $added
  # Leftovers: registry entries and shortcuts that point into the staging folder.
  foreach ($u in @(Get-UninstallEntries $ProductName)) {
    if ($u.location -and $u.location.ToLowerInvariant().StartsWith($Staging.ToLowerInvariant())) {
      Write-Warning "Uninstall entry still present: $($u.key)"
    }
  }
  foreach ($l in @($loose | Where-Object { $_.role -eq 'shortcut' })) {
    if (Test-Path -LiteralPath $l.path) { Remove-Item -LiteralPath $l.path -Force -ErrorAction SilentlyContinue }
  }
}

# ---- (e) result ----------------------------------------------------------------------------------

Write-Phase 'writing reports'
$failures = @($entries | Where-Object { $_.wouldFail })
$atRisk = @($entries | Where-Object { $_.risk -and -not $_.risk.StartsWith('none') -and -not $_.risk.StartsWith('not evaluated') })
$failed = $SigningConfigured -and ($failures.Count -gt 0 -or $installError)
$webview2 = @($entries | Where-Object { (Split-Path -Leaf $_.path) -match '(?i)webview2|msedgewebview' })
if ($webview2.Count -eq 0) { $notes += 'No WebView2 files: Electron 45 ships its own Chromium and does not use the WebView2 runtime.' }

$sacState = $null
try { $sacState = [string](Get-MpComputerStatus -ErrorAction Stop).SmartAppControlState } catch { $sacState = 'unavailable' }
$sacReg = $null
try { $sacReg = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction Stop).VerifiedAndReputablePolicyState } catch { }

$summary = [ordered]@{
  generated = (Get-Date).ToString('s')
  result = if (-not $SigningConfigured) { 'REPORT ONLY (signing not configured)' } elseif ($failed) { 'FAIL' } else { 'PASS' }
  signingConfigured = [bool]$SigningConfigured
  expectedPublisher = $ExpectedPublisher
  powershell = "$($PSVersionTable.PSVersion) $($PSVersionTable.PSEdition)"
  languageMode = [string]$ExecutionContext.SessionState.LanguageMode
  smartAppControlOnThisMachine = $sacState
  verifiedAndReputablePolicyState = $sacReg
  installer = $Installer; unpacked = $Unpacked; zip = $Zip; runtimeReport = $RuntimeReport
  installed = $installed; installError = $installError
  filesChecked = $entries.Count; filesSkippedNotEvaluated = $skippedCount
  ours = @($entries | Where-Object { $_.owner -eq 'OURS' }).Count
  thirdParty = @($entries | Where-Object { $_.owner -eq 'THIRD-PARTY' }).Count
  atRisk = $atRisk.Count
  failures = $failures.Count
}

# ---- (f) reports ---------------------------------------------------------------------------------

$report = [ordered]@{ summary = $summary; notes = $notes; sources = $sources; asar = $asarReports; files = $entries }
if ($runtime) { $report.runtime = [ordered]@{ steps = $runtime.steps; processes = $runtime.processes; filesCreated = $runtime.filesCreated } }
Set-Content -LiteralPath $JsonPath -Value (ConvertTo-Json -InputObject $report -Depth 8) -Encoding UTF8

function Esc([string]$s) { if ($null -eq $s) { return '' } return ($s -replace '\|', '\|' -replace "`r?`n", ' ') }
function Short-Subject([string]$s) { if (-not $s) { return '' } if ($s -match 'CN=("[^"]+"|[^,]+)') { return $Matches[1].Trim('"') } return $s }

$md = @()
$md += '# Smart App Control check'
$md += ''
$md += "**Result: $($summary.result)**"
$md += ''
$md += '| | |'
$md += '|---|---|'
$md += "| Generated | $($summary.generated) |"
$md += "| Signing configured | $($summary.signingConfigured)$(if ($ExpectedPublisher) { " (expected publisher: $(Esc $ExpectedPublisher))" }) |"
$md += "| PowerShell | $($summary.powershell), $($summary.languageMode) |"
$md += "| SAC on this machine | $($summary.smartAppControlOnThisMachine) (VerifiedAndReputablePolicyState = $($summary.verifiedAndReputablePolicyState)) |"
$md += "| Files checked | $($summary.filesChecked) ($($summary.ours) ours, $($summary.thirdParty) third-party); $skippedCount data files skipped (not evaluated by SAC) |"
$md += "| At risk of a block | $($summary.atRisk) |"
$md += "| Would fail a signed release | $($summary.failures) |"
$md += ''
$md += 'Static checks are evidence, not proof: Smart App Control also consults Microsoft''s cloud reputation, which no local check can reproduce. A valid signature from a publicly trusted CA is what lets a new release with no reputation run. See docs/BLOCK-TEST.md for the test on a machine with SAC on.'
$md += ''
if ($notes.Count) {
  $md += '## Notes'
  $md += ''
  foreach ($n in $notes) { $md += "- $(Esc $n)" }
  $md += ''
}
$md += '## Sources'
$md += ''
foreach ($s in $sources) { $md += "- **$($s.origin)**: $($s.label)" }
if ($Installer) { $md += "- **installer**: $(Split-Path -Leaf $Installer)" }
$md += ''
if ($failures.Count) {
  $md += $(if ($SigningConfigured) { '## Failures' } else { '## Would fail once signing is configured' })
  $md += ''
  $md += '| Origin | File | Status | Reason |'
  $md += '|---|---|---|---|'
  foreach ($e in $failures) { $md += "| $($e.origin) | $(Esc $e.relativePath) | $($e.signature.status) | $(Esc $e.failReason) |" }
  $md += ''
}
$md += '## Files Smart App Control evaluates'
$md += ''
$md += '| Origin | Role | Owner | File | Status | Type | Signer | Timestamp | Root | Block risk |'
$md += '|---|---|---|---|---|---|---|---|---|---|'
foreach ($e in ($entries | Where-Object { $_.owner -ne 'SYSTEM' -or $_.wouldFail } | Sort-Object { $_.owner }, { $_.origin }, { $_.relativePath })) {
  $sig = $e.signature
  $ts = if ($sig.timestamped) { 'yes' } elseif ($sig.status -eq 'Valid') { 'no' } else { '' }
  $root = if ($sig.rootSubject) { "$(Short-Subject $sig.rootSubject) ($($sig.rootStore))" } elseif ($sig.rootStore) { $sig.rootStore } else { '' }
  $step = if ($e.step) { " (first seen: $($e.step))" } else { '' }
  $md += "| $($e.origin) | $(Esc $e.role)$step | $($e.owner) | $(Esc $e.relativePath) | $($sig.status) | $($sig.signatureType) | $(Esc (Short-Subject $sig.signerSubject)) | $ts | $(Esc $root) | $(Esc $e.risk) |"
}
$md += ''
if ($asarReports.Count) {
  $md += '## Inside app.asar'
  $md += ''
  $md += 'JavaScript inside app.asar is read by Electron''s own runtime, never by Windows Script Host, so SAC does not evaluate it: not evaluated by SAC (inside asar, run by the app).'
  $md += ''
  foreach ($a in $asarReports) {
    $md += "- $($a.origin) $($a.path): $($a.files) files, $($a.js) JavaScript files; PE files packed inside: $(if ($a.peInside.Count) { $a.peInside -join ', ' } else { 'none' }); other script types: $(if ($a.scriptsInside.Count) { $a.scriptsInside -join ', ' } else { 'none' })"
  }
  $md += ''
}
if ($runtime) {
  $md += '## Runtime pass'
  $md += ''
  $md += "Merged from $RuntimeReport. Steps exercised:"
  $md += ''
  foreach ($s in @($runtime.steps)) { $md += "- $($s.name): $($s.result)$(if ($s.detail) { ' - ' + (Esc $s.detail) })" }
  $md += ''
  $sys = @($entries | Where-Object { $_.owner -eq 'SYSTEM' })
  $sysBad = @($sys | Where-Object { $_.signature.status -ne 'Valid' })
  $md += "Files that appeared only at runtime: $(@($runtime.runtimeOnly).Count). Those outside the Windows folder are in the table above with the step that first loaded them. $($sys.Count) are Windows files (owner SYSTEM, $(@($sys | Where-Object { $_.signature.signatureType -eq 'Catalog' }).Count) catalog-signed); $(if ($sysBad.Count) { 'not Valid: ' + (($sysBad | ForEach-Object { Split-Path -Leaf $_.path }) -join ', ') } else { 'all Valid' }). Full list in the JSON report."
  $md += ''
}
$md += '## Rules used'
$md += ''
$md += '- Evaluated types: PE images (' + ($PeExts -join ' ') + ', or any file starting with MZ), scripts (' + ($ScriptExts -join ' ') + '), packages (' + ($PackageExts -join ' ') + ') and the other extensions SAC blocks when downloaded (' + ($MotwExts -join ' ') + ').'
$md += '- OURS: the installer, uninstaller, app executable, elevate.exe, Electron runtime files we redistribute unsigned, native modules, installer temp files. They must be Valid, signed by the expected publisher, timestamped, and chain to a public root.'
$md += '- THIRD-PARTY: files that carry their publisher''s signature (for example d3dcompiler_47.dll, Microsoft). They must stay Valid; HashMismatch, NotTrusted, UnknownError or a missing signature is a failure. Re-signing them with our certificate (win.signExts) is also accepted.'
$md += '- .bat/.cmd/.lnk/.url and similar cannot be signed; shipping one that Windows could run fails a signed release.'
$md += '- Get-AuthenticodeSignature Valid only means the signature is intact and chains to a root trusted on this machine; the root column shows which store holds it.'
Set-Content -LiteralPath $ReportPath -Value ($md -join "`r`n") -Encoding UTF8

if (-not $KeepStaging) {
  foreach ($d in @('app', 'zip', 'installer-temp', 'uninstaller-temp', 'captured')) {
    $p = Join-Path $Staging $d
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
  if (@(Get-ChildItem -LiteralPath $Staging -Force -ErrorAction SilentlyContinue).Count -eq 0) {
    Remove-Item -LiteralPath $Staging -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host "Smart App Control check: $($summary.result)"
Write-Host "  files checked: $($summary.filesChecked), at risk: $($summary.atRisk), would fail a signed release: $($summary.failures)"
Write-Host "  report: $ReportPath"
Write-Host "  json:   $JsonPath"
if ($installError) {
  # The installer is part of the release: a failed install is a broken release in either mode,
  # and its uninstaller and plug-ins were not checked.
  Write-Host "  installer failed: $installError"
  exit 2
}
if ($failed) {
  foreach ($e in $failures) { Write-Host "  FAIL $($e.origin) $($e.relativePath): $($e.failReason)" }
  exit 1
}
exit 0
