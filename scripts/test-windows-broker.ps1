param([ValidateSet('Install', 'Verify', 'CrossAccount', 'Diagnose', 'RemoveTestService')][string]$Mode = 'Verify')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installDir = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'FsTTY'
$brokerPath = Join-Path $installDir 'fstty-broker.exe'
$source = Join-Path $workspace 'src-tauri/target/debug/fstty-broker.exe'
$probe = Join-Path $workspace 'src-tauri/target/debug/examples/windows_acceptance.exe'
$report = Join-Path $workspace 'src-tauri/target/broker-acceptance.json'
if ($Mode -eq 'CrossAccount') { $report = Join-Path $workspace 'src-tauri/target/broker-cross-account.json' }
Start-Transcript -Path (Join-Path $workspace 'src-tauri/target/broker-acceptance-install.log') -Force | Out-Null
$marker = Join-Path $installDir 'broker-acceptance-install.marker'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '安装和验收控制进程需要管理员权限；攻击测试子进程会使用同账号普通权限令牌。'
}
if ($Mode -eq 'Install' -or $Mode -eq 'CrossAccount') {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw '请先构建 broker。' }
    if ((Test-Path -LiteralPath $installDir) -and -not (Test-Path -LiteralPath $marker)) {
        throw '已有正式安装目录；验收脚本拒绝覆盖，请使用正式安装程序。'
    }
    if (-not (Test-Path -LiteralPath $installDir)) {
        New-Item -ItemType Directory -Path $installDir | Out-Null
        $acl = Get-Acl -LiteralPath $installDir
        $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
        Set-Acl -LiteralPath $installDir -AclObject $acl
        Set-Content -LiteralPath $marker -Value 'FsTTY broker synthetic acceptance installation' -Encoding ascii
    }
    if (Test-Path -LiteralPath $brokerPath) {
        $stopped = Start-Process -FilePath $brokerPath -ArgumentList '--stop' -WindowStyle Hidden -Wait -PassThru
        if ($stopped.ExitCode -ne 0) { throw '无法停止测试服务。' }
    }
    Copy-Item -LiteralPath $source -Destination $brokerPath -Force
    $installed = Start-Process -FilePath $brokerPath -ArgumentList '--install' -WindowStyle Hidden -Wait -PassThru
    if ($installed.ExitCode -ne 0) { throw "服务安装失败，退出码 $($installed.ExitCode)。" }
}
if ($Mode -eq 'Diagnose') { & $probe --pipe-info; return }
if ($Mode -eq 'RemoveTestService') {
    if (-not (Test-Path -LiteralPath $marker)) { throw '没有验收标记，拒绝卸载正式服务。' }
    $removed = Start-Process -FilePath $brokerPath -ArgumentList '--uninstall' -WindowStyle Hidden -Wait -PassThru
    if ($removed.ExitCode -ne 0) { throw '测试服务卸载失败。' }
    # 仅删除本脚本安装的两份文件，保留 ProgramData 的受保护密文数据。
    Remove-Item -LiteralPath $brokerPath
    Remove-Item -LiteralPath $marker
    return
}
if ($Mode -eq 'CrossAccount') { & $probe --run-crossaccount $report }
else { & $probe --run $report }
if ($LASTEXITCODE -ne 0) { throw "权限验收失败，请查看 $report 及子进程报告。" }
Get-Content -LiteralPath $report
