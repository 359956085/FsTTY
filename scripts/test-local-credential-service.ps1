$ErrorActionPreference = 'Stop'
$localServiceWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$localServiceProbePath = Join-Path $localServiceWorkspace 'src-tauri/target/debug/examples/windows_acceptance.exe'
if (-not (Test-Path -LiteralPath $localServiceProbePath -PathType Leaf)) {
    throw '请先构建 broker 的 windows_acceptance 示例。'
}

$localServiceProxyTrap = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$localServiceProxyTrap.Start()
$localServiceProbe = [Diagnostics.Process]::new()
$localServiceProbeStarted = $false
try {
    $localServiceProxyAddress = 'http://127.0.0.1:' + $localServiceProxyTrap.LocalEndpoint.Port
    $localServiceStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $localServiceStartInfo.FileName = $localServiceProbePath
    $localServiceStartInfo.Arguments = '--status'
    $localServiceStartInfo.UseShellExecute = $false
    $localServiceStartInfo.CreateNoWindow = $true
    $localServiceStartInfo.RedirectStandardOutput = $true
    $localServiceStartInfo.RedirectStandardError = $true
    $localServiceStartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $localServiceStartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($localServiceProxyVariable in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
        $localServiceStartInfo.EnvironmentVariables[$localServiceProxyVariable] = $localServiceProxyAddress
    }
    $localServiceStartInfo.EnvironmentVariables['NO_PROXY'] = ''
    $localServiceProbe.StartInfo = $localServiceStartInfo
    if (-not $localServiceProbe.Start()) { throw '无法启动只读服务状态检查。' }
    $localServiceProbeStarted = $true
    $localServiceOutput = $localServiceProbe.StandardOutput.ReadToEndAsync()
    $localServiceError = $localServiceProbe.StandardError.ReadToEndAsync()
    if (-not $localServiceProbe.WaitForExit(10000)) {
        $localServiceProbe.Kill()
        $localServiceProbe.WaitForExit()
        throw '本地凭据服务状态检查超时。'
    }
    $localServiceOutputText = $localServiceOutput.GetAwaiter().GetResult()
    $localServiceErrorText = $localServiceError.GetAwaiter().GetResult()
    if ($localServiceProbe.ExitCode -ne 0) {
        throw ('本地凭据服务状态检查失败：' + $localServiceErrorText.Trim())
    }
    $localServiceProxyConnections = 0
    while ($localServiceProxyTrap.Pending()) {
        $localServiceUnexpectedClient = $localServiceProxyTrap.AcceptTcpClient()
        $localServiceUnexpectedClient.Dispose()
        $localServiceProxyConnections += 1
    }
    if ($localServiceProxyConnections -ne 0) { throw '本地凭据服务请求连接了代理。' }
    [PSCustomObject]@{
        serviceAvailable = $true
        transport = 'local named pipe'
        proxyConnections = $localServiceProxyConnections
        result = $localServiceOutputText.Trim()
    } | ConvertTo-Json
} finally {
    if ($localServiceProbeStarted -and -not $localServiceProbe.HasExited) {
        $localServiceProbe.Kill()
        $localServiceProbe.WaitForExit()
    }
    $localServiceProbe.Dispose()
    $localServiceProxyTrap.Stop()
}
