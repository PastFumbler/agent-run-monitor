; Custom NSIS steps, included by electron-builder (electron-builder.yml nsis.include).
;
; The one-click installer copies itself to %LOCALAPPDATA%\agent-run-monitor-updater\installer.exe
; (electron-builder's updater cache: package name + "-updater"). The app has no auto-updater, so
; nothing ever uses that copy, and electron-builder's uninstaller leaves it behind (about 125 MB).
; Remove it on a real uninstall. During an update the old version's uninstaller runs with
; --updated; the folder is left alone then, because the new installer owns it.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; The updater cache always lives in the current user's profile, like electron-builder's own copy.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endIf}
    RMDir /r "$LOCALAPPDATA\agent-run-monitor-updater"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endIf}
  ${endIf}
!macroend
