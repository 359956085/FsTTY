Unicode true
RequestExecutionLevel user
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
!include nsDialogs.nsh
Name "FsTTY isolated focus fixture"
OutFile "${FIXTURE_EXE}"
InstallDir "$TEMP"
Var InstallMode
Var Scenario
Var BringCount
Var FlashCount
Var FixtureResult
Var WelcomeCount
Var GuiVisible
Var VisibleAtActivation
Var ForegroundAtCheck
Var FocusWithin

!macro FsTTYWizardBringToFront
  IntOp $BringCount $BringCount + 1
  System::Call 'user32::IsWindowVisible(p $HWNDPARENT) i.r0'
  StrCpy $VisibleAtActivation $0
  !ifdef FIXTURE_NATIVE
    BringToFront
  !endif
!macroend
!ifndef FIXTURE_NATIVE
!macro FsTTYWizardGetForeground
  StrCpy $0 0
  ${If} $Scenario == "active"
    StrCpy $0 $HWNDPARENT
  ${ElseIf} $Scenario == "success"
    ${If} $BringCount > 0
      StrCpy $0 $HWNDPARENT
    ${EndIf}
  ${EndIf}
!macroend
!endif
!macro FsTTYWizardFlash
  IntOp $FlashCount $FlashCount + 1
  Call FixtureValidateFlash
  !ifdef FIXTURE_NATIVE
    System::Call 'user32::FlashWindowEx(p r0)'
  !endif
!macroend

Function FixtureValidateFlash
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
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
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Return
  failed:
  SetErrorLevel 4
  Quit
FunctionEnd

!include "${FOCUS_HEADER}"
!define MUI_CUSTOMFUNCTION_GUIINIT FixtureGuiInit
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FixtureWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_DESTROYED FsTTYCancelWizardActivation
!insertmacro MUI_PAGE_WELCOME
Page custom FixtureSecond
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE English

Function .onInit
  StrCpy $BringCount 0
  StrCpy $FlashCount 0
  StrCpy $WelcomeCount 0
  StrCpy $FixtureResult "${FIXTURE_RESULT}"
  ${GetParameters} $0
  ${GetOptions} $0 "/CASE=" $Scenario
  StrCpy $InstallMode "install"
  StrCmp $Scenario "update" 0 +2
    StrCpy $InstallMode "update"
  IfSilent blocked
  StrCmp $InstallMode "update" blocked done
  blocked:
  Call FsTTYScheduleWizardActivation
  Call FsTTYActivateWizardOnce
  Call FixtureWriteResult
  SetErrorLevel 0
  Quit
  done:
FunctionEnd

Function FixtureGuiInit
  System::Call 'user32::IsWindowVisible(p $HWNDPARENT) i.r0'
  StrCpy $GuiVisible $0
  StrCmp $FsTTYWizardActivationAttempted "" done
  SetErrorLevel 5
  Quit
  done:
FunctionEnd

Function FixtureWelcomeShow
  IntOp $WelcomeCount $WelcomeCount + 1
  StrCpy $FsTTYWizardWelcome $mui.WelcomePage
  StrCpy $0 "register-sentinel"
  Call FsTTYScheduleWizardActivation
  Call FsTTYScheduleWizardActivation
  StrCmp $0 "register-sentinel" +3
    SetErrorLevel 3
    Quit
  ${If} $Scenario == "earlyleave"
    ${If} $WelcomeCount == 1
      ${NSD_CreateTimer} FixtureAdvance 20
    ${EndIf}
  ${ElseIf} $Scenario == "hidden"
    ${NSD_CreateTimer} FixtureHide 20
  ${ElseIf} $Scenario == "minimized"
    ${NSD_CreateTimer} FixtureMinimize 20
  ${ElseIf} $Scenario == "closed"
    ${NSD_CreateTimer} FixtureClose 20
  ${EndIf}
  ${NSD_CreateTimer} FixtureObserve 160
FunctionEnd

Function FixtureAdvance
  ${NSD_KillTimer} FixtureAdvance
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

Function FixtureHide
  ${NSD_KillTimer} FixtureHide
  ShowWindow $HWNDPARENT ${SW_HIDE}
FunctionEnd

Function FixtureMinimize
  ${NSD_KillTimer} FixtureMinimize
  ShowWindow $HWNDPARENT ${SW_MINIMIZE}
FunctionEnd

Function FixtureClose
  ${NSD_KillTimer} FixtureClose
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd

Function FixtureObserve
  ${NSD_KillTimer} FixtureObserve
  StrCpy $0 "register-sentinel"
  Call FsTTYActivateWizardOnce
  StrCmp $0 "register-sentinel" +3
    SetErrorLevel 3
    Quit
  StrCmp $Scenario "back" 0 observe_result
  StrCmp $WelcomeCount 1 0 observe_result
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
  Return
  observe_result:
  System::Call 'user32::GetForegroundWindow() p.r0'
  StrCpy $ForegroundAtCheck 0
  StrCmp $0 $HWNDPARENT 0 +2
    StrCpy $ForegroundAtCheck 1
  System::Call 'user32::GetFocus() p.r0'
  System::Call 'user32::IsChild(p $HWNDPARENT, p r0) i.r0'
  StrCpy $FocusWithin $0
  Call FixtureWriteResult
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd

Function FixtureSecond
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateTimer} FixtureReturn 50
  nsDialogs::Show
FunctionEnd

Function FixtureReturn
  ${NSD_KillTimer} FixtureReturn
  SendMessage $HWNDPARENT ${WM_COMMAND} 3 0
FunctionEnd

Function FixtureWriteResult
  WriteINIStr "$FixtureResult" "result" "bring" $BringCount
  WriteINIStr "$FixtureResult" "result" "flash" $FlashCount
  WriteINIStr "$FixtureResult" "result" "attempted" $FsTTYWizardActivationAttempted
  WriteINIStr "$FixtureResult" "result" "pending" $FsTTYWizardActivationPending
  WriteINIStr "$FixtureResult" "result" "scheduled" $FsTTYWizardActivationScheduled
  WriteINIStr "$FixtureResult" "result" "guiVisible" $GuiVisible
  WriteINIStr "$FixtureResult" "result" "visibleAtActivation" $VisibleAtActivation
  WriteINIStr "$FixtureResult" "result" "welcomeCount" $WelcomeCount
  WriteINIStr "$FixtureResult" "result" "foreground" $ForegroundAtCheck
  WriteINIStr "$FixtureResult" "result" "focusWithin" $FocusWithin
FunctionEnd

Function .onGUIEnd
  Call FsTTYCancelWizardActivation
  Call FixtureWriteResult
  SetErrorLevel 0
FunctionEnd

Section
  Abort "This fixture must never install files."
SectionEnd
