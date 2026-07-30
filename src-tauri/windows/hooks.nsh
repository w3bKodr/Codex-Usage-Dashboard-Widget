; Ask during an interactive install instead of silently opting the user in.
; The registry value name matches the Tauri autostart plugin configuration.
!macro NSIS_HOOK_POSTINSTALL
  IfSilent codex_usage_autostart_done

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Would you like Codex Usage Dashboard to start automatically when you sign in to Windows?$\r$\n$\r$\nYou can change this later in Widget settings." \
    IDYES codex_usage_autostart_enable IDNO codex_usage_autostart_disable

  codex_usage_autostart_enable:
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Codex Weekly"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" \
      "Codex Usage Dashboard" '$\"$INSTDIR\codex-usage-dashboard.exe$\"'
    Goto codex_usage_autostart_done

  codex_usage_autostart_disable:
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Codex Weekly"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Codex Usage Dashboard"

  codex_usage_autostart_done:
!macroend

; Never leave an orphaned startup entry after uninstalling.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Codex Weekly"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Codex Usage Dashboard"
!macroend
