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
Var CallerMode
Var OperationId
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

LangString UacCancelled ${LANG_SIMPCHINESE} "未获得管理员授权，安装已取消。"
LangString UacCancelled ${LANG_ENGLISH} "Administrator approval was not granted. Installation was canceled."
LangString GuidFailed ${LANG_SIMPCHINESE} "无法生成安装暂存目录。"
LangString GuidFailed ${LANG_ENGLISH} "Could not create the installation staging directory."
LangString BootstrapExists ${LANG_SIMPCHINESE} "安装暂存目录已存在，请重新运行安装包。"
LangString BootstrapExists ${LANG_ENGLISH} "The installation staging directory already exists. Run the installer again."
LangString CompatibilityNotice ${LANG_SIMPCHINESE} "当前交互会话没有可用的普通权限令牌。安装可以继续，但安装完成后的 FsTTY 桌面也会以管理员权限运行。点击“确定”继续。"
LangString CompatibilityNotice ${LANG_ENGLISH} "This interactive session has no standard user token. Installation can continue, but the FsTTY desktop will also run with administrator rights after installation. Click OK to continue."
LangString CompatibilityDetail ${LANG_SIMPCHINESE} "管理员兼容模式：安装后的桌面将保持管理员权限。"
LangString CompatibilityDetail ${LANG_ENGLISH} "Administrator compatibility mode: the installed desktop will retain administrator rights."
LangString NormalPermissionDetail ${LANG_SIMPCHINESE} "安装后的桌面将以当前用户的普通权限运行。"
LangString NormalPermissionDetail ${LANG_ENGLISH} "The installed desktop will run with the current user's standard permissions."
LangString ToolFallback ${LANG_SIMPCHINESE} "无法启动或运行安装工具（退出码：$0）。详细原因已写入后台安装日志。"
LangString ToolFallback ${LANG_ENGLISH} "The installation tool could not start or finish (exit code: $0). Details were written to the background installer log."
LangString DeployFallback ${LANG_SIMPCHINESE} "安装工具执行失败（退出码：$0）。恢复材料已保留，详细原因已写入后台安装日志。"
LangString DeployFallback ${LANG_ENGLISH} "The installation tool failed (exit code: $0). Recovery data was preserved and details were written to the background installer log."
LangString LaunchFallback ${LANG_SIMPCHINESE} "无法启动桌面（退出码：$0）。请从当前安装目录重试。"
LangString LaunchFallback ${LANG_ENGLISH} "The desktop could not be started (exit code: $0). Try again from the current installation directory."
LangString WebViewFailed ${LANG_SIMPCHINESE} "WebView2 安装失败，请修复后重试。"
LangString WebViewFailed ${LANG_ENGLISH} "WebView2 installation failed. Repair it and try again."

LangString PreviousHeader ${LANG_SIMPCHINESE} "选择旧安装"
LangString PreviousHeader ${LANG_ENGLISH} "Choose an existing installation"
LangString PreviousSubheader ${LANG_SIMPCHINESE} "默认原地覆盖；也可以在下一页更换桌面目录。"
LangString PreviousSubheader ${LANG_ENGLISH} "Upgrade in place by default, or choose a new desktop directory on the next page."
LangString PreviousDescription ${LANG_SIMPCHINESE} "检测到以下 FsTTY 安装。选择需要升级的目录；未登记的便携版可在下一页手动选择。"
LangString PreviousDescription ${LANG_ENGLISH} "The following FsTTY installations were found. Choose one to upgrade; an unregistered portable copy can be selected manually on the next page."
LangString PreviousRequired ${LANG_SIMPCHINESE} "请选择一个旧安装目录。"
LangString PreviousRequired ${LANG_ENGLISH} "Choose an existing installation directory."
LangString ConfirmHeader ${LANG_SIMPCHINESE} "确认安装位置"
LangString ConfirmHeader ${LANG_ENGLISH} "Confirm installation locations"
LangString ConfirmSubheader ${LANG_SIMPCHINESE} "仅桌面目录可选，凭据服务始终位于受保护目录。"
LangString ConfirmSubheader ${LANG_ENGLISH} "Only the desktop directory is configurable; the credential service always stays in its protected directory."
LangString SummaryNew ${LANG_SIMPCHINESE} "新安装"
LangString SummaryNew ${LANG_ENGLISH} "New installation"
LangString SummaryInPlace ${LANG_SIMPCHINESE} "原地升级"
LangString SummaryInPlace ${LANG_ENGLISH} "In-place upgrade"
LangString SummaryMoved ${LANG_SIMPCHINESE} "更换目录；旧目录保留，安装成功后请勿继续使用旧版"
LangString SummaryMoved ${LANG_ENGLISH} "Move to a new directory; the old directory is retained and should not be used after installation"
LangString ConfirmDescription ${LANG_SIMPCHINESE} "$SummaryText$\r$\n$\r$\n桌面：$INSTDIR$\r$\n服务、管理工具及卸载程序：$PROGRAMFILES64\FsTTY$\r$\n$\r$\n安装时将关闭旧桌面，SSH 连接和传输任务会中断。会话、设置及原始私钥保留；凭据迁移需在新版中另行确认。"
LangString ConfirmDescription ${LANG_ENGLISH} "$SummaryText$\r$\n$\r$\nDesktop: $INSTDIR$\r$\nService, management tool, and uninstaller: $PROGRAMFILES64\FsTTY$\r$\n$\r$\nInstallation closes the old desktop and interrupts SSH connections and transfers. Sessions, settings, and original private keys are retained; credential migration requires separate confirmation in the new version."
LangString DeployAbort ${LANG_SIMPCHINESE} "安装未完成；请查看上方错误，恢复材料会保留。"
LangString DeployAbort ${LANG_ENGLISH} "Installation did not finish. Review the error above; recovery data will be retained."
LangString OldDirectoryRetained ${LANG_SIMPCHINESE} "旧目录已保留：$InitialDirectory。请确认新版正常后自行清理旧程序。"
LangString OldDirectoryRetained ${LANG_ENGLISH} "The old directory was retained: $InitialDirectory. Remove the old program only after confirming the new version works."
LangString UninstallConfirm ${LANG_SIMPCHINESE} "卸载将关闭当前桌面及凭据服务，SSH 连接和传输任务会中断。会话、原始私钥和受保护凭据保留。"
LangString UninstallConfirm ${LANG_ENGLISH} "Uninstalling closes the desktop and credential service and interrupts SSH connections and transfers. Sessions, original private keys, and protected credentials are retained."
LangString UninstallFallback ${LANG_SIMPCHINESE} "卸载工具执行失败（退出码：$0）。请修复安装后重试。"
LangString UninstallFallback ${LANG_ENGLISH} "The uninstaller failed (exit code: $0). Repair the installation and try again."

Function .onInit
  ${GetParameters} $R8
  ${GetOptions} $R8 "/UPDATE" $0
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}
  System::Call 'shell32::IsUserAnAdmin() i.r0'
  ${If} $0 = 0
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    ClearErrors
    ExecShellWait "runas" "$EXEPATH" '$R8 /CALLERPID=$0' SW_SHOWNORMAL $R0
    ${If} ${Errors}
      MessageBox MB_ICONINFORMATION "$(UacCancelled)"
      StrCpy $R0 1
    ${EndIf}
    SetErrorLevel $R0
    Quit
  ${EndIf}
  ${GetOptions} $R8 "/CALLERPID=" $CallerPid
  ${If} ${Errors}
    ; 内置 Administrator 或关闭 UAC 时没有外层普通权限进程，使用当前安装器身份继续验证。
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $CallerPid $0
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
    SetErrorLevel 1
    Abort "$(GuidFailed)"
  ${EndIf}
  StrCpy $Bootstrap "$PROGRAMFILES64\FsTTY-install-$0"
  IfFileExists "$Bootstrap" 0 bootstrap_create
    SetErrorLevel 1
    Abort "$(BootstrapExists)"
  bootstrap_create:
  CreateDirectory "$Bootstrap"
  SetOutPath "$Bootstrap"
  File /oname=fstty-broker.exe "${FSTTY_BROKER_BINARY}"
  ${If} $InstallMode == "update"
    ; 在线更新由部署入口一次性核对调用者与安装记录，避免向导阶段留下进程退出竞态。
    ReadRegStr $INSTDIR HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\FsTTY" "InstallLocation"
    ${If} $INSTDIR == ""
      MessageBox MB_ICONSTOP "在线更新找不到已登记的安装目录，请手动运行安装包修复。"
      Call RemoveBootstrap
      SetErrorLevel 1
      Quit
    ${EndIf}
    StrCpy $InitialDirectory $INSTDIR
    StrCpy $OperationId $0
    Return
  ${EndIf}
  nsExec::ExecToStack '"$Bootstrap\fstty-broker.exe" --desktop-candidates $CallerPid'
  Pop $0
  Pop $CandidateList
  ${If} $0 != 0
    ReadINIStr $CandidateList "$Bootstrap\installer-result.ini" "result" "error"
    ${If} $CandidateList == ""
      StrCpy $CandidateList "$(ToolFallback)"
    ${EndIf}
    MessageBox MB_ICONSTOP "$CandidateList"
    Call RemoveBootstrap
    SetErrorLevel 1
    Quit
  ${EndIf}
  ReadINIStr $CandidateCount "$Bootstrap\candidates.ini" "installation" "count"
  ReadINIStr $CallerMode "$Bootstrap\candidates.ini" "installation" "callerMode"
  ReadINIStr $OperationId "$Bootstrap\candidates.ini" "installation" "operationId"
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
  ${If} $CallerMode == "alwaysElevated"
    DetailPrint "$(CompatibilityDetail)"
    ${If} $InstallMode != "update"
      IfSilent compatibility_continue 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(CompatibilityNotice)"
      compatibility_continue:
    ${EndIf}
  ${Else}
    DetailPrint "$(NormalPermissionDetail)"
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
  !insertmacro MUI_HEADER_TEXT "$(PreviousHeader)" "$(PreviousSubheader)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "$(PreviousDescription)"
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
    MessageBox MB_ICONINFORMATION "$(PreviousRequired)"
    Abort
  ${EndIf}
  StrCpy $INSTDIR $0
  StrCpy $InitialDirectory $0
FunctionEnd

Function ConfirmDirectories
  !insertmacro MUI_HEADER_TEXT "$(ConfirmHeader)" "$(ConfirmSubheader)"
  nsDialogs::Create 1018
  Pop $0
  StrCpy $SummaryText "$(SummaryNew)"
  ${If} $InitialDirectory != ""
    ${If} $InitialDirectory == $INSTDIR
      StrCpy $SummaryText "$(SummaryInPlace)"
    ${Else}
      StrCpy $SummaryText "$(SummaryMoved)"
    ${EndIf}
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 120u "$(ConfirmDescription)"
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
      SetErrorLevel 1
      Abort "$(WebViewFailed)"
    ${EndIf}
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=300000 '"$Bootstrap\fstty-broker.exe" --deploy-desktop "$INSTDIR" $CallerPid $InstallMode $OperationId'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ReadINIStr $1 "$Bootstrap\installer-result.ini" "result" "error"
    ${If} $1 == ""
      StrCpy $1 "$(DeployFallback)"
    ${EndIf}
    MessageBox MB_ICONSTOP "$1"
    SetErrorLevel 1
    Abort "$(DeployAbort)"
  ${EndIf}
  CreateShortcut "$SMPROGRAMS\FsTTY.lnk" "$INSTDIR\fstty.exe"
  CreateShortcut "$DESKTOP\FsTTY.lnk" "$INSTDIR\fstty.exe"
  ${If} $InitialDirectory != ""
  ${AndIf} $InitialDirectory != $INSTDIR
    DetailPrint "$(OldDirectoryRetained)"
  ${EndIf}
  Call RemoveBootstrap
SectionEnd

Function LaunchDesktop
  ${If} $InstallMode == "update"
    Return
  ${EndIf}
  nsExec::ExecToStack '"$PROGRAMFILES64\FsTTY\fstty-broker.exe" --launch-desktop $CallerPid $OperationId'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ReadINIStr $1 "$PROGRAMFILES64\FsTTY\installer-result.ini" "result" "error"
    ${If} $1 == ""
      StrCpy $1 "$(LaunchFallback)"
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
  SetErrorLevel 1
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
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(UninstallConfirm)" IDOK +2
    Abort
  nsExec::ExecToStack '"$PROGRAMFILES64\FsTTY\fstty-broker.exe" --remove-desktop'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ReadINIStr $1 "$PROGRAMFILES64\FsTTY\installer-result.ini" "result" "error"
    ${If} $1 == ""
      StrCpy $1 "$(UninstallFallback)"
    ${EndIf}
    MessageBox MB_ICONSTOP "$1"
    Abort
  ${EndIf}
  Delete "$SMPROGRAMS\FsTTY.lnk"
  Delete "$DESKTOP\FsTTY.lnk"
  Delete "$PROGRAMFILES64\FsTTY\fstty-broker.exe"
  Delete "$PROGRAMFILES64\FsTTY\fstty-update-helper-*.exe"
  Delete "$PROGRAMFILES64\FsTTY\uninstall.exe"
  Delete "$PROGRAMFILES64\FsTTY\installer-result.ini"
  ; 非空目录及 ProgramData 凭据数据均保留。
  RMDir "$PROGRAMFILES64\FsTTY"
SectionEnd
