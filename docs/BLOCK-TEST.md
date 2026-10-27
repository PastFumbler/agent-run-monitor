# Smart App Control block test

Smart App Control (SAC) is the Windows 11 feature that only lets an app run if Microsoft's cloud
service predicts it is safe, or, when the service cannot make a prediction, if the file is signed
with a certificate from a publicly trusted CA [S1][S3]. It evaluates binaries as they load,
including install and uninstall binaries and the temporary files an installer unpacks [S2][S9].
A brand-new release has no reputation yet (reputation belongs to the exact file, so every build
starts over [S7]), so in practice **every executable and DLL we ship must be signed**, or SAC
blocks the app or part of it [S12]. Microsoft recommends Artifact Signing (formerly Trusted
Signing) for this; self-signed or private-root certificates do not count [S3].

This page is the manual test on a real machine with SAC switched on. The automated checks are
not enough on their own:

- `scripts/check-blocks.ps1` (run by the release workflow) lists every file SAC evaluates in the
  installer, the installed app, the portable zip and the files the installer unpacks to `%TEMP%`,
  and checks each Authenticode signature.
- `scripts/runtime-modules.mjs` launches the packaged app, drives the main features and records
  every process and DLL that gets loaded, so files that only appear at runtime are checked too.

**Static checks are evidence, not proof.** SAC also asks Microsoft's cloud reputation service
(the Intelligent Security Graph), and that answer depends on the exact file hashes, on what
Microsoft has seen of them, and can change over time [S7]. Only a run on a machine with SAC on shows
what SAC actually decides. Do this test for every release before you publish the draft.

## 1. Prepare a machine with Smart App Control on

Use a Windows 11 PC or VM you can reset. A VM snapshot taken with SAC on is ideal.

Check that SAC is **On** (enforcing), not Evaluation or Off, in all three places [S1][S2][S4]:

1. **Windows Security** > **App & browser control** > **Smart App Control settings**: "On".
2. Registry (PowerShell):

   ```powershell
   (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy').VerifiedAndReputablePolicyState
   # 1 = On (enforce), 2 = Evaluation, 0 = Off
   ```

3. Defender status:

   ```powershell
   (Get-MpComputerStatus).SmartAppControlState   # On / Eval / Off
   ```

   This property exists in current Defender builds but Microsoft does not document it; trust the
   registry value if the two disagree.

Optionally, from an elevated prompt, `citool.exe -lp` lists the policy `VerifiedAndReputableDesktop`
with "Is Currently Enforced: true" when SAC is on (Evaluation shows
`VerifiedAndReputableDesktopEvaluation`) [S2].

**Turning SAC back on.** It used to be one-way: once off, only a clean install or reset brought it
back. Since the March 2026 update (KB5079391, OS builds 26200.8116 and 26100.8116, rolling out
from then) you can switch it on again in Windows Security > App & browser control > Smart App
Control settings without reinstalling [S14][S11]. It still cannot be switched back on, and stays
off, when [S11]:

- the device is managed by an organisation (enterprise-managed),
- **developer mode** is on (Settings > System > For developers),
- **optional diagnostic data** is off (Settings > Privacy & security > Diagnostics & feedback),
- the device is in S mode.

So the test machine should not be your development machine: developer mode switches SAC off.
One Microsoft page still says SAC works on new installs only [S13]; that page is out of date.

If the machine is only in **Evaluation** mode, SAC does not block anything and does not log what
it would have blocked. Microsoft's test guidance is to install the audit policy
`SmartAppControlAuditNoISG.bin` from <https://aka.ms/sacauditpolicies>, following the steps in
[S2]; it logs every file that is not allowed by signature alone, which is the worst case for a new release. Then read event 3076
instead of 3077 below.

Do not install development tools on the test machine beyond what this test needs (Node.js, if
you use the simulator in step 4); anything unsigned you add there can be blocked too and confuse
the results.

## 2. Record the start time

Open Windows PowerShell and keep it open for the whole test:

```powershell
$t0 = Get-Date
```

## 3. Download the release

Download **through a web browser** (not `curl` or `gh`; SAC blocks some file types only when
they come from the internet [S10]), from the release page
<https://github.com/PastFumbler/agent-run-monitor/releases>, so the files carry the Mark of the Web like
a real user's download:

- the installer, `agent-run-monitor-<version>-setup-<arch>.exe`
- the portable zip, `agent-run-monitor-<version>-win-<arch>.zip`
- the reports `check-blocks-<arch>.md` and `runtime-modules.md` attached to the release, to
  compare against

Check the Mark of the Web is there (ZoneId=3 means "from the internet"):

```powershell
Get-Content "$env:USERPROFILE\Downloads\agent-run-monitor-<version>-setup-x64.exe" -Stream Zone.Identifier
```

## 4. Installer pass

1. Run the installer by double-clicking it. Note any SAC dialog ("Smart App Control blocked an
   app", "blocked part of this app") and what it names.
2. The app starts after installing. Exercise everything:
   - **first-run wizard**: go through every step and finish it;
   - **runs**: open several runs from different agents, use the view switcher (keys 1-5) on each;
   - **multiviewer**: pick several runs (m, Ctrl-click or Shift-click) and open the multiviewer
     (g then m); maximise and restore a tile;
   - **settings**: change the theme, text size, low-GPU mode; add a custom folder (folder picker);
     turn on **Start with Windows**, then off again;
   - **notifications**: turn notifications on and let a run finish or fail so a Windows
     notification appears, then click it. Either use a coding agent, or run
     `node scripts/simulate-live-runs.mjs --count 3 --duration 30` from a copy of the repository
     (Node.js is signed, so SAC lets it run) and add the folder it prints as a custom Claude Code
     folder in settings;
   - **update check** (About in settings), if you want to cover the only network call;
   - quit the app and start it again from the Start menu.
3. Uninstall from **Settings > Apps > Installed apps > Agent Run Monitor > Uninstall**.

## 5. Portable zip pass

1. Right-click the zip > **Extract All** (Explorer passes the Mark of the Web on to the extracted
   files).
2. Run `Agent Run Monitor.exe` from the extracted folder and repeat the feature pass from step 4.2.
3. Delete the folder.

## 6. Look for blocks

**Protection history.** Windows Security > **Virus & threat protection** > **Protection history**.
Look for entries titled "Smart App Control" or "App or process blocked" and open each to see the
file.

**Code Integrity log** (executables, DLLs, `.node` modules, drivers). Paste this into the same
PowerShell window:

```powershell
function Get-CiEvents {
  param([int[]]$Id, [string]$Log = 'Microsoft-Windows-CodeIntegrity/Operational', [datetime]$Since = $t0)
  Get-WinEvent -FilterHashtable @{ LogName = $Log; Id = $Id; StartTime = $Since } -ErrorAction SilentlyContinue |
    ForEach-Object {
      $x = [xml]$_.ToXml(); $d = @{}
      foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
      [pscustomobject]@{
        Time = $_.TimeCreated; Id = $_.Id
        File = ($d['File Name'] -replace '^\\Device\\HarddiskVolume\d+', '')
        Process = ($d['Process Name'] -replace '^\\Device\\HarddiskVolume\d+', '')
        Policy = $d['PolicyName']
        Activity = $x.Event.System.Correlation.ActivityID
      }
    }
}

# 3077: blocked by SAC in enforcement mode
Get-CiEvents -Id 3077 | Where-Object Policy -like 'VerifiedAndReputable*' | Format-Table Time, File, Process -AutoSize
# 3076: would have been blocked (Evaluation / audit policy)
Get-CiEvents -Id 3076 | Where-Object Policy -like 'VerifiedAndReputable*' | Format-Table Time, File, Process -AutoSize
# 3033: file did not meet the policy. Microsoft documents it alongside 3077 for revoked, expired
# lifetime-signing and Code Integrity Guard cases; in practice every SAC block of an unsigned
# file also logged a 3033 and two 3089 events
Get-CiEvents -Id 3033 | Format-Table Time, File, Process -AutoSize

# 3089: the signature details of each blocked file, joined on the correlation ActivityID
$blocks = Get-CiEvents -Id 3077, 3076
Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; Id = 3089; StartTime = $t0 } -ErrorAction SilentlyContinue |
  Where-Object { $blocks.Activity -contains ([xml]$_.ToXml()).Event.System.Correlation.ActivityID } |
  ForEach-Object { $x = [xml]$_.ToXml(); ($x.Event.EventData.Data | ForEach-Object { "$($_.Name)=$($_.'#text')" }) -join '; ' }
```

An unsigned file shows one 3089 event with `TotalSignatureCount=0`. Event meanings: [S5].

**AppLocker MSI and Script log** (scripts, installers, packaged apps):

```powershell
# 8028: would be blocked (audit); 8029: blocked (enforce, a host may run it in Constrained
# Language Mode instead); 8038: signature information for those events
Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-AppLocker/MSI and Script'; Id = 8028, 8029, 8038; StartTime = $t0 } -ErrorAction SilentlyContinue |
  Format-Table TimeCreated, Id, Message -AutoSize -Wrap
```

**SAC state did not change during the test:**

```powershell
'{0} / registry {1}' -f (Get-MpComputerStatus).SmartAppControlState, (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy').VerifiedAndReputablePolicyState
```

Optionally run the static audit on the test machine as well. Copy `check-blocks.ps1` from a git
clone or a USB stick, not through a browser: a downloaded `.ps1` carries the Mark of the Web and
SAC blocks it [S10] (`Unblock-File .\check-blocks.ps1` removes the mark). Unsigned scripts that
are allowed to run do so in Constrained Language Mode [S6]; `check-blocks.ps1` is written for
that and only loses the root-certificate column, so there it cannot tell a private root from a
public one (the release workflow's report has that column):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\check-blocks.ps1 `
  -Installer "$env:USERPROFILE\Downloads\agent-run-monitor-<version>-setup-x64.exe" `
  -Zip "$env:USERPROFILE\Downloads\agent-run-monitor-<version>-win-x64.zip" `
  -Staging "$env:TEMP\arm-sac" -ReportPath "$env:TEMP\arm-sac\check-blocks.md"
```

## 7. Pass criteria

- no 3077 (or 3076 with the audit policy) event for any file in the install folder
  (`%LOCALAPPDATA%\Programs\agent-run-monitor` by default: the per-user one-click installer names
  the folder after the package name, not the product name), the extracted zip, or
  `%TEMP%\ns*.tmp` (the installer's and uninstaller's NSIS plug-ins);
- no 8028/8029 event caused by the app, installer or uninstaller;
- no Smart App Control entry in Protection history;
- no "Smart App Control blocked part of this app" or "blocked an app" dialog at any step.

If something is blocked: take the file from the 3077 event and the signer from the matching 3089
event. An unsigned `.dll` or `.node` means `win.signExts` in `electron-builder.yml` missed it; an
unsigned file under `%TEMP%\ns*.tmp` means the NSIS plug-in signing step in `release.yml` did not
run; a signed file that is still blocked usually means the certificate does not chain to a
publicly trusted root or the signature has no timestamp. Fix, tag a new version, test again.

## 8. Results

Copy this table into the release notes of the draft (or an issue) and fill it in.

| Item | Result |
|---|---|
| Release / tag | |
| Date of test | |
| Windows edition, version and build (`winver`) | |
| SAC state before / after (UI, registry value, `SmartAppControlState`) | |
| Signed with (Artifact Signing / certificate file / unsigned) | |
| Downloaded through a browser, Zone.Identifier ZoneId=3 present | |
| Installer: started without a SAC dialog | |
| First-run wizard completed | |
| Runs opened, all five views | |
| Multiviewer with several runs | |
| Settings: theme, text size, low-GPU, custom folder, start with Windows | |
| Notification shown and clicked | |
| Update check (optional) | |
| Restart from the Start menu | |
| Uninstall from Settings > Apps | |
| Portable zip: extracted with Explorer, app ran, feature pass | |
| Protection history entries | |
| Event 3077 / 3076 (files) | |
| Event 3033 / 3089 (details) | |
| Event 8028 / 8029 / 8038 | |
| Differences from `check-blocks-<arch>.md` / `runtime-modules.md` | |
| Verdict (publish / fix and re-test) | |
| Tested by | |

## Sources

Checked on 2026-10-27. Dates are the "updated" dates the pages show; support.microsoft.com pages
show none.

| | Source | Date |
|---|---|---|
| S1 | [Smart App Control overview (for developers)](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview) | 2026-10-06 |
| S2 | [Test your app with Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control) | 2026-09-21 |
| S3 | [Code signing for Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control) | 2026-09-28 |
| S4 | [App Control for Business](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol) | 2026-10-08 |
| S5 | [App Control event IDs](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/event-id-explanations) | 2024-10-01 |
| S6 | [Script enforcement with App Control](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/script-enforcement) | 2025-02-24 |
| S7 | [App Control and the Intelligent Security Graph](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/use-appcontrol-with-intelligent-security-graph) | 2026-08-24 |
| S9 | [Windows security book: application and driver control](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control) | 2026-02-10 |
| S10 | [Smart App Control has blocked an app with a dangerous file extension](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-has-blocked-an-app-with-a-dangerous-file-extension) | none shown |
| S11 | [Smart App Control frequently asked questions](https://support.microsoft.com/en-us/topic/what-is-smart-app-control-285ea03d-fa88-4d56-882e-6698afdb7003) | none shown |
| S12 | [Smart App Control has blocked part of this app](https://support.microsoft.com/en-gb/windows/security/threat-malware-protection/smart-app-control-has-blocked-part-of-this-app) | none shown |
| S13 | [App & browser control in the Windows Security app](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app) | none shown; out of date on turning SAC back on |
| S14 | [KB5079391, March 26, 2026 preview (OS builds 26200.8116 and 26100.8116)](https://support.microsoft.com/en-us/servicing/os/windows-11/2026/03/march-26-2026-kb5079391-os-builds-26200-8116-and-26100-8116-preview) | 2026-03-26 |

Not from Microsoft: which Electron 45 files ship unsigned, which NSIS plug-ins electron-builder
leaves unsigned, and the 3033 + 3089 pattern for unsigned files were measured locally (the
reports `check-blocks.ps1` writes show the first two for each build). Treating `.node` modules
like DLLs follows from them being DLLs; no Microsoft page mentions them. That Explorer's Extract
All passes the Mark of the Web on to the extracted files is standard Windows behaviour, but none
of the pages above states it.
