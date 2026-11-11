!ifndef FSTTY_WIZARD_FOCUS_INCLUDED
!define FSTTY_WIZARD_FOCUS_INCLUDED

; The compile-time wrappers let the isolated NSIS fixture exercise the same
; control flow without changing the user's foreground window during tests.
!ifmacrondef FsTTYWizardBringToFront
!macro FsTTYWizardBringToFront
  BringToFront
!macroend
!endif

!ifmacrondef FsTTYWizardGetForeground
!macro FsTTYWizardGetForeground
  System::Call 'user32::GetForegroundWindow() p.r0'
!macroend
!endif

!ifmacrondef FsTTYWizardFlash
!macro FsTTYWizardFlash
  System::Call 'user32::FlashWindowEx(p r0)'
!macroend
!endif

Var FsTTYWizardActivationAttempted

Function FsTTYActivateWizardOnce
  IfSilent done
  StrCmp $InstallMode "update" done
  StrCmp $FsTTYWizardActivationAttempted 1 done
  StrCpy $FsTTYWizardActivationAttempted 1

  Push $0
  !insertmacro FsTTYWizardBringToFront
  !insertmacro FsTTYWizardGetForeground
  StrCmp $0 $HWNDPARENT activated

  ; FLASHW_TRAY only, three flashes, system default interval. Aligned fields
  ; and &l4 supply the native FLASHWINFO size on either NSIS architecture.
  System::Call '*(&l4, P $HWNDPARENT, I 2, I 3, I 0) p.r0'
  StrCmp $0 0 activated
  !insertmacro FsTTYWizardFlash
  System::Free $0

  activated:
  Pop $0
  done:
FunctionEnd

!endif
