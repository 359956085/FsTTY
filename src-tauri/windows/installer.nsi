Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
SetCompressor /SOLID lzma
RequestExecutionLevel user
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
!include x64.nsh
!include nsDialogs.nsh
!include StrFunc.nsh
${StrTok}
!addplugindir "{{additional_plugins_path}}"
Name "FsTTY"
OutFile "{{out_file}}"
InstallDir "$PROGRAMFILES64\FsTTY"
VIProductVersion "{{version_with_build}}"
VIAddVersionKey "ProductName" "FsTTY"
VIAddVersionKey "FileDescription" "FsTTY 安装程序"
VIAddVersionKey "FileVersion" "{{version}}"
VIAddVersionKey "ProductVersion" "{{version}}"
!define MUI_ICON "{{installer_icon}}"
!define MUI_UNICON "{{uninstaller_icon}}"
!include "{{installer_hooks}}"
Var Bootstrap
Var CallerPid
Var InstallMode
Var CandidateList
Var CandidateCount
Var CandidateCombo
Var SummaryText
Var InitialDirectory
Var LaunchAfter

!insertmacro MUI_PAGE_WELCOME
Page custom ChoosePrevious ChoosePreviousLeave
!insertmacro MUI_PAGE_DIRECTORY
Page custom ConfirmDirectories
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchDesktop
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${GetParameters} $R8
  System::Call 'shell32::IsUserAnAdmin() i.r0'
  ${If} $0 = 0
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    ClearErrors
    ExecShellWait "runas" "$EXEPATH" '$R8 /CALLERPID=$0' SW_SHOWNORMAL $R0
    ${If} ${Errors}
      MessageBox MB_ICONINFORMATION "安装已取消。"
      StrCpy $R0 1
    ${EndIf}
    SetErrorLevel $R0
    Quit
  ${EndIf}
  ${GetOptions} $R8 "/CALLERPID=" $CallerPid
  ${If} ${Errors}
    MessageBox MB_ICONSTOP "请从普通权限桌面启动安装包。"
    SetErrorLevel 1
    Quit
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
  StrCpy $InstallMode "install"
  ${GetOptions} $R8 "/UPDATE" $0
  ${IfNot} ${Errors}
    StrCpy $InstallMode "update"
  ${EndIf}
  System::Call 'ole32::CoCreateGuid(g .r0) i.r1'
  ${If} $1 != 0
    Abort "无法生成安装暂存目录。"
  ${EndIf}
  StrCpy $Bootstrap "$PROGRAMFILES64\FsTTY-install-$0"
  IfFileExists "$Bootstrap" 0 +2
    Abort "安装暂存目录已存在。"
  CreateDirectory "$Bootstrap"
  SetOutPath "$Bootstrap"
  File /oname=fstty-broker.exe "${FSTTY_BROKER_BINARY}"
  nsExec::ExecToStack '"$Bootstrap\fstty-broker.exe" --desktop-candidates $CallerPid'
  Pop $0
  Pop $CandidateList
  ${If} $0 != 0
    ReadINIStr $CandidateList "$Bootstrap\installer-result.ini" "result" "error"
    ${If} $CandidateList == ""
      StrCpy $CandidateList "无法启动或运行安装工具（退出码：$0）。请保留安装包并联系支持。"
    ${EndIf}
    MessageBox MB_ICONSTOP "$CandidateList"
    Call RemoveBootstrap
    SetErrorLevel 1
    Quit
  ${EndIf}
  ReadINIStr $CandidateCount "$Bootstrap\candidates.ini" "installation" "count"
  ${If} $CandidateCount > 1
    IfSilent 0 candidates_interactive
      Call RemoveBootstrap
      SetErrorLevel 1
      Quit
    candidates_interactive:
  ${EndIf}
  ReadINIStr $0 "$Bootstrap\candidates.ini" "installation" "registered"
  ${If} $0 == 0
    StrCpy $InstallMode "install"
  ${EndIf}
  ReadINIStr $InitialDirectory "$Bootstrap\candidates.ini" "installation" "path0"
  ${If} $InitialDirectory != ""
    StrCpy $INSTDIR $InitialDirectory
  ${EndIf}
FunctionEnd

Function ChoosePrevious
  ${If} $CandidateCount == 0
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "选择旧安装" "默认原地覆盖；也可以在下一页更换桌面目录。"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "检测到以下 FsTTY 安装。选择需要升级的目录；未登记的便携版可在下一页手动选择。"
  Pop $0
  ${NSD_CreateDropList} 0 44u 100% 100u ""
  Pop $CandidateCombo
  StrCpy $1 0
  candidate_loop:
    IntCmp $1 $CandidateCount candidate_done
    ReadINIStr $2 "$Bootstrap\candidates.ini" "installation" "path$1"
    ${NSD_CB_AddString} $CandidateCombo $2
    IntOp $1 $1 + 1
    Goto candidate_loop
  candidate_done:
  ${If} $1 = 1
    ${NSD_CB_SelectString} $CandidateCombo $InitialDirectory
  ${Else}
    StrCpy $INSTDIR ""
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ChoosePreviousLeave
  ${NSD_GetText} $CandidateCombo $0
  ${If} $0 == ""
    MessageBox MB_ICONINFORMATION "请选择一个旧安装目录。"
    Abort
  ${EndIf}
  StrCpy $INSTDIR $0
  StrCpy $InitialDirectory $0
FunctionEnd

Function ConfirmDirectories
  !insertmacro MUI_HEADER_TEXT "确认安装位置" "仅桌面目录可选，凭据服务始终位于受保护目录。"
  nsDialogs::Create 1018
  Pop $0
  StrCpy $SummaryText "新安装"
  ${If} $InitialDirectory != ""
    ${If} $InitialDirectory == $INSTDIR
      StrCpy $SummaryText "原地升级"
    ${Else}
      StrCpy $SummaryText "更换目录；旧目录保留，安装成功后请勿继续使用旧版"
    ${EndIf}
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 120u "$SummaryText$\r$\n$\r$\n桌面：$INSTDIR$\r$\n服务、管理工具及卸载程序：$PROGRAMFILES64\FsTTY$\r$\n$\r$\n安装时将关闭旧桌面，SSH 连接和传输任务会中断。会话、设置及原始私钥保留；凭据迁移需在新版中另行确认。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Section "安装"
  SetOutPath "$Bootstrap"
  File /oname=fstty.exe "{{main_binary_path}}"
  WriteUninstaller "$Bootstrap\uninstall.exe"
  ; WebView2 引导程序只从包内释放到受保护目录。
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    File /oname=WebView2Setup.exe "{{webview2_bootstrapper_path}}"
    ExecWait '"$Bootstrap\WebView2Setup.exe" /silent /install' $0
    ${If} $0 != 0
      Abort "WebView2 安装失败，请修复后重试。"
    ${EndIf}
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=300000 '"$Bootstrap\fstty-broker.exe" --deploy-desktop "$INSTDIR" $CallerPid $InstallMode'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ReadINIStr $1 "$Bootstrap\installer-result.ini" "result" "error"
    ${If} $1 == ""
      StrCpy $1 "安装工具执行失败（退出码：$0）。请保留恢复材料并重试。"
    ${EndIf}
    MessageBox MB_ICONSTOP "$1"
    Abort "安装未完成；请查看上方错误，恢复材料会保留。"
  ${EndIf}
  CreateShortcut "$SMPROGRAMS\FsTTY.lnk" "$INSTDIR\fstty.exe"
  CreateShortcut "$DESKTOP\FsTTY.lnk" "$INSTDIR\fstty.exe"
  ${If} $InitialDirectory != ""
  ${AndIf} $InitialDirectory != $INSTDIR
    DetailPrint "旧目录已保留：$InitialDirectory。请确认新版正常后自行清理旧程序。"
  ${EndIf}
  Call RemoveBootstrap
SectionEnd

Function LaunchDesktop
  ${If} $InstallMode == "update"
    Return
  ${EndIf}
  nsExec::ExecToStack '"$PROGRAMFILES64\FsTTY\fstty-broker.exe" --launch-desktop $CallerPid'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ReadINIStr $1 "$PROGRAMFILES64\FsTTY\installer-result.ini" "result" "error"
    ${If} $1 == ""
      StrCpy $1 "无法启动桌面（退出码：$0）。请从当前安装目录重试。"
    ${EndIf}
    MessageBox MB_ICONINFORMATION "$1"
  ${EndIf}
FunctionEnd

Function RemoveBootstrap
  ${If} $Bootstrap != ""
    SetOutPath "$PROGRAMFILES64"
    Delete "$Bootstrap\fstty.exe"
    Delete "$Bootstrap\fstty-broker.exe"
    Delete "$Bootstrap\uninstall.exe"
    Delete "$Bootstrap\WebView2Setup.exe"
    Delete "$Bootstrap\candidates.ini"
    Delete "$Bootstrap\installer-result.ini"
    RMDir "$Bootstrap"
    StrCpy $Bootstrap ""
  ${EndIf}
FunctionEnd
Function .onInstFailed
  Call RemoveBootstrap
FunctionEnd
Function .onGUIEnd
  Call RemoveBootstrap
FunctionEnd

Function un.onInit
  System::Call 'shell32::IsUserAnAdmin() i.r0'
  ${If} $0 = 0
    ClearErrors
    ExecShellWait "runas" "$PROGRAMFILES64\FsTTY\uninstall.exe" "" SW_SHOWNORMAL $R0
    ${If} ${Errors}
      StrCpy $R0 1
    ${EndIf}
    SetErrorLevel $R0
    Quit
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
FunctionEnd
Section "Uninstall"
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "卸载将关闭当前桌面及凭据服务，SSH 连接和传输任务会中断。会话、原始私钥和受保护凭据保留。" IDOK +2
    Abort
  nsExec::ExecToStack '"$PROGRAMFILES64\FsTTY\fstty-broker.exe" --remove-desktop'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ReadINIStr $1 "$PROGRAMFILES64\FsTTY\installer-result.ini" "result" "error"
    ${If} $1 == ""
      StrCpy $1 "卸载工具执行失败（退出码：$0）。请修复安装后重试。"
    ${EndIf}
    MessageBox MB_ICONSTOP "$1"
    Abort
  ${EndIf}
  Delete "$SMPROGRAMS\FsTTY.lnk"
  Delete "$DESKTOP\FsTTY.lnk"
  Delete "$PROGRAMFILES64\FsTTY\fstty-broker.exe"
  Delete "$PROGRAMFILES64\FsTTY\uninstall.exe"
  Delete "$PROGRAMFILES64\FsTTY\installer-result.ini"
  ; 非空目录及 ProgramData 凭据数据均保留。
  RMDir "$PROGRAMFILES64\FsTTY"
SectionEnd
