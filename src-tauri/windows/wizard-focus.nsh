!ifndef FSTTY_WIZARD_FOCUS_INCLUDED
!define FSTTY_WIZARD_FOCUS_INCLUDED

; Refusal tests override these wrappers; the native fixture also runs the real
; APIs after the welcome page has entered its message loop.
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
!ifmacrondef FsTTYWizardCanActivate
!macro FsTTYWizardCanActivate
  System::Call 'user32::IsWindowVisible(p $HWNDPARENT) i.r0'
  StrCmp $0 0 visibility_done
  System::Call 'user32::IsWindowVisible(p $FsTTYWizardWelcome) i.r0'
  StrCmp $0 0 visibility_done
  System::Call 'user32::IsIconic(p $HWNDPARENT) i.r0'
  StrCmp $0 0 not_minimized
  StrCpy $0 0
  Goto visibility_done
  not_minimized:
  StrCpy $0 1
  visibility_done:
!macroend
!endif
!ifmacrondef FsTTYWizardFlash
!macro FsTTYWizardFlash
  System::Call 'user32::FlashWindowEx(p r0)'
!macroend
!endif

Var FsTTYWizardWelcome
Var FsTTYWizardActivationScheduled
Var FsTTYWizardActivationPending
Var FsTTYWizardActivationAttempted

Function FsTTYScheduleWizardActivation
  IfSilent done
  StrCmp $InstallMode "update" done
  StrCmp $FsTTYWizardActivationScheduled 1 done
  StrCpy $FsTTYWizardActivationScheduled 1
  StrCpy $FsTTYWizardActivationPending 1
  ; MUI SHOW precedes nsDialogs::Show. Dispatch after both dialogs are shown.
  ${NSD_CreateTimer} FsTTYActivateWizardOnce 50
  done:
FunctionEnd

Function FsTTYCancelWizardActivation
  StrCmp $FsTTYWizardActivationPending 1 0 done
  ${NSD_KillTimer} FsTTYActivateWizardOnce
  StrCpy $FsTTYWizardActivationPending 0
  done:
FunctionEnd

Function FsTTYActivateWizardOnce
  StrCmp $FsTTYWizardActivationPending 1 0 done
  Call FsTTYCancelWizardActivation
  IfSilent done
  StrCmp $InstallMode "update" done
  StrCmp $FsTTYWizardActivationAttempted 1 done
  Push $0
  !insertmacro FsTTYWizardCanActivate
  StrCmp $0 0 activated
  StrCpy $FsTTYWizardActivationAttempted 1
  !insertmacro FsTTYWizardGetForeground
  StrCmp $0 $HWNDPARENT activated
  !insertmacro FsTTYWizardBringToFront
  !insertmacro FsTTYWizardGetForeground
  StrCmp $0 $HWNDPARENT activated

  ; FLASHW_TRAY only, three flashes, system default interval.
  System::Call '*(&l4, P $HWNDPARENT, I 2, I 3, I 0) p.r0'
  StrCmp $0 0 activated
  !insertmacro FsTTYWizardFlash
  System::Free $0
  activated:
  Pop $0
  done:
FunctionEnd

!endif
