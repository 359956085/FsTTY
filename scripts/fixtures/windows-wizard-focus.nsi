Unicode true
RequestExecutionLevel user
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
Name "FsTTY isolated focus fixture"
OutFile "${FIXTURE_EXE}"
Var InstallMode
Var Scenario
Var BringCount
Var FlashCount
Var FixtureResult

!ifndef FIXTURE_NATIVE
!macro FsTTYWizardBringToFront
  IntOp $BringCount $BringCount + 1
!macroend
!macro FsTTYWizardGetForeground
  StrCpy $0 0
  StrCmp $Scenario "active" 0 +2
    StrCpy $0 $HWNDPARENT
!macroend
!macro FsTTYWizardFlash
  IntOp $FlashCount $FlashCount + 1
  Call FixtureValidateFlash
!macroend

Function FixtureValidateFlash
  ; Check the actual allocated Win32 structure, not the source spelling.
  System::Call '*$0(I .r1, P .r2, I .r3, I .r4, I .r5)'
  !if ${NSIS_PTR_SIZE} = 4
    StrCmp $1 20 0 failed
  !else
    StrCmp $1 32 0 failed
  !endif
  StrCmp $2 $HWNDPARENT 0 failed
  StrCmp $3 2 0 failed
  StrCmp $4 3 0 failed
  StrCmp $5 0 0 failed
  Return
  failed:
  SetErrorLevel 4
  Quit
FunctionEnd
!endif

!include "${FOCUS_HEADER}"
!define MUI_CUSTOMFUNCTION_GUIINIT FixtureGuiInit
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE English

Function .onInit
  StrCpy $BringCount 0
  StrCpy $FlashCount 0
  StrCpy $FixtureResult "${FIXTURE_RESULT}"
  ${GetParameters} $0
  ${GetOptions} $0 "/CASE=" $Scenario
  StrCpy $InstallMode "install"
  StrCmp $Scenario "update" 0 +2
    StrCpy $InstallMode "update"
  IfSilent 0 done
    Call FixtureCheck
    Quit
  done:
FunctionEnd

Function FixtureGuiInit
  System::Call 'user32::IsWindow(p $HWNDPARENT) i.r0'
  StrCmp $0 0 failed
  Call FixtureCheck
  ; Exit before the welcome page is displayed. Never deploy anything or
  ; activate a real window, even when running the native API compile check.
  Quit
  failed:
  SetErrorLevel 2
  Quit
FunctionEnd

Function FixtureCheck
  StrCpy $0 "register-sentinel"
  Call FsTTYActivateWizardOnce
  StrCmp $0 "register-sentinel" 0 failed
  Call FsTTYActivateWizardOnce
  StrCmp $0 "register-sentinel" 0 failed
  WriteINIStr "$FixtureResult" "result" "bring" $BringCount
  WriteINIStr "$FixtureResult" "result" "flash" $FlashCount
  WriteINIStr "$FixtureResult" "result" "attempted" $FsTTYWizardActivationAttempted
  SetErrorLevel 0
  Return
  failed:
  SetErrorLevel 3
  Quit
FunctionEnd

Section
  Abort "This fixture must never install files."
SectionEnd
