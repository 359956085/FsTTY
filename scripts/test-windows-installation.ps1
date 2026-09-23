param(
    [ValidateSet('Inspect', 'AssertInstalled', 'AssertUninstalled')][string]$Mode = 'Inspect',
    [string]$ExpectedDesktopDirectory
)
$ErrorActionPreference = 'Stop'
$protectedDirectory = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'FsTTY'
$recordPath = Join-Path $protectedDirectory 'installation/active.json'
$registryPath = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FsTTY'
$service = Get-CimInstance Win32_Service -Filter "Name='FsTTYBroker'"
$record = if (Test-Path -LiteralPath $recordPath) { Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$registration = Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue

if ($Mode -eq 'AssertInstalled') {
    if (-not $ExpectedDesktopDirectory) { throw '必须提供预期桌面目录。' }
    $expected = [IO.Path]::GetFullPath($ExpectedDesktopDirectory).TrimEnd('\')
    if (-not $record -or $record.directory.TrimEnd('\') -ine $expected) { throw '有效安装目录不符合预期。' }
    if ($record.files.Count -ne 1 -or $record.files[0] -ne 'fstty.exe') { throw '程序文件清单不正确。' }
    $executable = Join-Path $expected 'fstty.exe'
    if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ine $record.sha256) { throw '桌面文件与安装记录不匹配。' }
    if (-not $service -or $service.State -ne 'Running' -or $service.StartName -ne 'NT SERVICE\FsTTYBroker') { throw '凭据服务未使用预期身份运行。' }
    if ($service.PathName -notlike ('"' + (Join-Path $protectedDirectory 'fstty-broker.exe') + '" --service')) { throw '服务不在固定受保护目录。' }
    if ([version]$record.version -ge [version]'1.7.1') {
        $helper = Join-Path $protectedDirectory "fstty-update-helper-$($record.version).exe"
        $broker = Join-Path $protectedDirectory 'fstty-broker.exe'
        if (-not (Test-Path -LiteralPath $helper)) { throw '独立更新助手缺失。' }
        if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash -ine (Get-FileHash -LiteralPath $broker -Algorithm SHA256).Hash) { throw '更新助手与服务程序不一致。' }
    }
    if ($registration.UninstallString -ne ('"' + (Join-Path $protectedDirectory 'uninstall.exe') + '"')) { throw '卸载入口不在受保护目录。' }
    if ($registration.InstallLocation.TrimEnd('\') -ine $expected) { throw '机器登记未切换到当前桌面。' }
    if (Test-Path -LiteralPath (Join-Path $protectedDirectory 'installation/transaction.json')) { throw '仍存在未完成的安装事务。' }
}
if ($Mode -eq 'AssertUninstalled') {
    if ($service -or $record -or $registration) { throw '卸载后仍存在有效安装登记或服务。' }
    if ($ExpectedDesktopDirectory -and (Test-Path -LiteralPath (Join-Path $ExpectedDesktopDirectory 'fstty.exe'))) { throw '当前桌面程序尚未移除。' }
}

[pscustomobject]@{
    mode = $Mode
    desktop = if ($record) { $record.directory } else { $null }
    version = if ($record) { $record.version } else { $null }
    serviceState = if ($service) { $service.State } else { $null }
    serviceAccount = if ($service) { $service.StartName } else { $null }
    protectedDataRetained = Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'FsTTYBroker')
    passed = $true
} | ConvertTo-Json
