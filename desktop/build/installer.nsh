; Agent Hub NSIS hooks (design D11, D13, D16). Per-user install: everything under HKCU.

!macro customInstall
  ; agenthub:// for the current user (app.setAsDefaultProtocolClient repeats it at start as a safeguard).
  WriteRegStr HKCU "Software\Classes\agenthub" "" "URL:Agent Hub"
  WriteRegStr HKCU "Software\Classes\agenthub" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\agenthub\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\agenthub\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller silently: keep the autostart value and the scheme then.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Agent Hub"
    DeleteRegKey HKCU "Software\Classes\agenthub"
  ${endIf}
!macroend
