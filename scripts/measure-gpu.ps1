<#
  Samples GPU and CPU use of one process tree on Windows, once a second, and writes one JSON line
  per sample. scripts/measure-gpu.mjs calls it for each test condition; it can also be run by hand
  against any running copy of the app:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-gpu.ps1 -RootPid <electron main pid> -Seconds 60 -OutFile gpu.jsonl

  GPU numbers come from the '\GPU Engine(*)\Utilization Percentage' performance counters, the same
  counters Task Manager reads for its per-process GPU column. Each instance is named
  pid_<pid>_luid_<adapter>_phys_<n>_eng_<n>_engtype_<type>, so every value can be attributed to a
  process. The tree is the root process and all of its descendants (for Electron: main, GPU,
  renderer, utility and crashpad processes), found by parent pid when sampling starts.

  Every line holds:
    t        sample time (ISO)
    tree     { "<pid>|<luid>|<phys>|<eng>|<engtype>": utilisation % } for the tree's engines
    other3d  sum of the 3D engine utilisation of every process outside the tree (background load)
    cpu      total CPU seconds used so far by the tree's processes (deltas give CPU %)
    cpuByPid the same per process
  The first line also carries the tree itself: pids with process type (from the command line).
  Nothing else is recorded: no command lines, no paths, no window titles.
#>
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [int]$Seconds = 60,
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'

# ---- the process tree --------------------------------------------------------------------------------
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
$tree = New-Object System.Collections.Generic.List[object]
$queue = New-Object System.Collections.Generic.Queue[int]
$queue.Enqueue($RootPid)
$seen = @{}
while ($queue.Count -gt 0) {
  $p = $queue.Dequeue()
  if ($seen.ContainsKey($p)) { continue }
  $seen[$p] = $true
  $proc = $all | Where-Object { $_.ProcessId -eq $p } | Select-Object -First 1
  if (-not $proc) { continue }
  $type = 'main'
  if ($p -ne $RootPid) {
    $type = 'other'
    if ("$($proc.CommandLine)" -match '--type=([a-z-]+)') { $type = $matches[1] }
    if ("$($proc.CommandLine)" -match '--utility-sub-type=([A-Za-z.]+)') { $type = "utility:$($matches[1])" }
  }
  $tree.Add([pscustomobject]@{ pid = $p; type = $type })
  $all | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { $queue.Enqueue([int]$_.ProcessId) }
}
if ($tree.Count -eq 0) { throw "process $RootPid not found" }
$pids = @($tree | ForEach-Object { $_.pid })

# ---- counters ------------------------------------------------------------------------------------------
$paths = @($pids | ForEach-Object { "\GPU Engine(pid_$($_)_*)\Utilization Percentage" })
$paths += '\GPU Engine(*engtype_3d)\Utilization Percentage'
$pidSet = @{}
foreach ($p in $pids) { $pidSet["$p"] = $true }

$writer = New-Object System.IO.StreamWriter($OutFile, $false, (New-Object System.Text.UTF8Encoding($false)))
$first = $true
try {
  Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples ($Seconds + 1) -ErrorAction SilentlyContinue | ForEach-Object {
    $set = $_
    $cpu = 0.0
    $cpuByPid = @{}
    foreach ($p in $pids) {
      try {
        $c = (Get-Process -Id $p -ErrorAction Stop).TotalProcessorTime.TotalSeconds
        $cpu += $c
        $cpuByPid["$p"] = $c
      } catch { }
    }
    $treeVals = @{}
    $other3d = 0.0
    foreach ($s in $set.CounterSamples) {
      if ($s.InstanceName -notmatch '^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_engtype_(.*)$') { continue }
      $pid_ = $matches[1]; $key = "$($matches[1])|$($matches[2])|$($matches[3])|$($matches[4])|$($matches[5])"
      if ($pidSet.ContainsKey($pid_)) {
        $treeVals[$key] = [double]$s.CookedValue
      } elseif ($matches[5] -eq '3d') {
        $other3d += [double]$s.CookedValue
      }
    }
    $line = [ordered]@{ t = $set.Timestamp.ToString('o'); tree = $treeVals; other3d = $other3d; cpu = $cpu; cpuByPid = $cpuByPid }
    if ($first) { $line['processes'] = $tree; $first = $false }
    $writer.WriteLine(($line | ConvertTo-Json -Compress -Depth 4))
    $writer.Flush()
  }
} finally {
  $writer.Close()
}
