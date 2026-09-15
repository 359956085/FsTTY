; 服务固定安装在 Program Files；引导程序也从不可由普通用户写入的目录运行。
!define FSTTY_BROKER_BINARY "${__FILEDIR__}\..\target\broker-package\fstty-broker.exe"
Var BrokerBootstrap
Var BrokerPrepared

Function FsttyRemoveBootstrap
  StrCmp $BrokerBootstrap "" broker_bootstrap_removed
    Delete "$BrokerBootstrap\fstty-broker.exe"
    RMDir "$BrokerBootstrap"
    StrCpy $BrokerBootstrap ""
  broker_bootstrap_removed:
FunctionEnd

Function FsttyRollback
  StrCmp $BrokerPrepared "1" 0 broker_rollback_done
    StrCpy $BrokerPrepared "0"
    ExecWait '"$BrokerBootstrap\fstty-broker.exe" --stop' $0
    StrCmp $0 0 0 broker_rollback_failed
    IfFileExists "$INSTDIR\broker-rollback\fstty-broker.exe" 0 broker_rollback_done
      ClearErrors
      CopyFiles /SILENT "$INSTDIR\broker-rollback\fstty-broker.exe" "$INSTDIR\fstty-broker.exe"
      IfFileExists "$INSTDIR\broker-rollback\fstty.exe" 0 +2
        CopyFiles /SILENT "$INSTDIR\broker-rollback\fstty.exe" "$INSTDIR\fstty.exe"
      IfErrors broker_rollback_failed
      ExecWait '"$INSTDIR\fstty-broker.exe" --restore-upgrade' $0
      StrCmp $0 0 broker_rollback_done
  broker_rollback_failed:
        MessageBox MB_ICONSTOP "Automatic rollback failed. Run the previous signed installer to repair FsTTY. Protected data has been retained."
  broker_rollback_done:
FunctionEnd

Function .onInstFailed
  Call FsttyRollback
  Call FsttyRemoveBootstrap
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  StrCmp $INSTDIR "$PROGRAMFILES64\FsTTY" +3
    MessageBox MB_ICONSTOP "FsTTY must be installed in $PROGRAMFILES64\FsTTY."
    Abort
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  System::Call 'ole32::CoCreateGuid(g .r0) i.r1'
  StrCmp $1 0 +3
    MessageBox MB_ICONSTOP "Cannot create a protected installer directory."
    Abort
  StrCpy $BrokerBootstrap "$PROGRAMFILES64\FsTTY-broker-install-$0"
  IfFileExists "$BrokerBootstrap" 0 +3
    MessageBox MB_ICONSTOP "Installer directory already exists."
    Abort
  CreateDirectory "$BrokerBootstrap"
  SetOutPath "$BrokerBootstrap"
  File /oname=fstty-broker.exe "${FSTTY_BROKER_BINARY}"
  ; 始终执行本安装包内的引导程序，检查旧目录权限后才停止服务。
  ExecWait '"$BrokerBootstrap\fstty-broker.exe" --prepare-upgrade' $0
  StrCmp $0 0 +4
    Call FsttyRemoveBootstrap
    MessageBox MB_ICONSTOP "Cannot safely prepare the credential service. Check installation permissions."
    Abort
  IfFileExists "$INSTDIR\fstty-broker.exe" 0 broker_prepare_done
    CreateDirectory "$INSTDIR\broker-rollback"
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\fstty-broker.exe" "$INSTDIR\broker-rollback\fstty-broker.exe"
    IfFileExists "$INSTDIR\fstty.exe" 0 +2
      CopyFiles /SILENT "$INSTDIR\fstty.exe" "$INSTDIR\broker-rollback\fstty.exe"
    IfErrors 0 broker_prepare_done
      ExecWait '"$BrokerBootstrap\fstty-broker.exe" --resume-upgrade' $0
      StrCmp $0 0 +2
        MessageBox MB_ICONSTOP "The previous service could not restart. Repair FsTTY using the previous signed installer."
      Call FsttyRemoveBootstrap
      MessageBox MB_ICONSTOP "Cannot back up installed programs."
      Abort
  broker_prepare_done:
  StrCpy $BrokerPrepared "1"
  SetOutPath "$INSTDIR"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ClearErrors
  CopyFiles /SILENT "$BrokerBootstrap\fstty-broker.exe" "$INSTDIR\fstty-broker.exe"
  IfErrors broker_install_failed
  ExecWait '"$INSTDIR\fstty-broker.exe" --install' $0
  StrCmp $0 0 broker_install_done
  broker_install_failed:
    Call FsttyRollback
    Call FsttyRemoveBootstrap
    MessageBox MB_ICONSTOP "Credential service installation failed. Existing credentials remain protected."
    Abort
  broker_install_done:
    StrCpy $BrokerPrepared "0"
    Delete "$INSTDIR\broker-rollback\fstty-broker.exe"
    Delete "$INSTDIR\broker-rollback\fstty.exe"
    RMDir "$INSTDIR\broker-rollback"
    Call FsttyRemoveBootstrap
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  IfFileExists "$INSTDIR\fstty-broker.exe" 0 broker_uninstall_done
    ExecWait '"$INSTDIR\fstty-broker.exe" --uninstall' $0
    StrCmp $0 0 +3
      MessageBox MB_ICONSTOP "Cannot safely stop the credential service."
      Abort
  broker_uninstall_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 普通卸载保留 ProgramData 中的受保护数据。
  Delete "$INSTDIR\fstty-broker.exe"
!macroend
