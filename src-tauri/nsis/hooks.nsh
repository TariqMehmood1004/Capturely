; Capturely installer customisation (tauri.conf.json > bundle > windows > nsis > installerHooks).
; Tauri includes this file right after the installer's own !includes, before any page is declared,
; so page texts defined here apply to its welcome/finish pages. Strings live in lang/*.nsh.

!define REELIF_NSIS_DIR "${__FILEDIR__}"

; NSIS ships no Urdu translation: load it from mui/ in this folder, every other language from NSIS.
!macroundef MUI_LANGUAGE
!macro MUI_LANGUAGE NLFID
  !if "${NLFID}" == "Urdu"
    !insertmacro MUI_LANGUAGEEX "${REELIF_NSIS_DIR}\mui" "${NLFID}"
  !else
    !insertmacro MUI_LANGUAGEEX "${NSISDIR}\Contrib\Language files" "${NLFID}"
  !endif
!macroend

; Branded welcome and finish pages; ask before abandoning a half-finished install.
!define MUI_WELCOMEPAGE_TITLE "$(reelifWelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(reelifWelcomeText)"
!define MUI_FINISHPAGE_TITLE "$(reelifFinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(reelifFinishText)"
!define MUI_ABORTWARNING

; An update must not fail on files in use: a recording keeps the bundled FFmpeg running, and the
; capture bar may still be open ("Error opening file for writing"). Stop only processes that run
; from this install folder. $$ is a literal $ for PowerShell.
!macro NSIS_HOOK_PREINSTALL
  Push $0
  ${If} ${FileExists} "$INSTDIR\*.*"
    DetailPrint "$(reelifStoppingRunning)"
    nsExec::ExecToLog `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\'; Get-Process | Where-Object { $$_.Path -and $$_.Path.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800"`
    Pop $0
  ${EndIf}
  Pop $0
!macroend

; Capturely starts hidden at sign-in (tray icon only), so Alt+Shift+R and the other keys work
; from any app without opening it first. Per-machine install: one entry for every user.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Capturely" '"$INSTDIR\${MAINBINARYNAME}.exe" --background'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Capturely"
!macroend
