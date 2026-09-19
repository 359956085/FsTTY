# Read-only. Run from the same desktop/terminal used to start the installer.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class FsTTYTokenDiagnostics
{
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr token,
        int informationClass,
        out int information,
        int informationLength,
        out int returnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr token,
        int informationClass,
        out IntPtr information,
        int informationLength,
        out int returnLength);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static int ElevationType(IntPtr token)
    {
        int value;
        int returned;
        if (!GetTokenInformation(token, 18, out value, sizeof(int), out returned))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return value;
    }

    public static bool HasLinkedToken(IntPtr token)
    {
        IntPtr linked;
        int returned;
        if (!GetTokenInformation(token, 19, out linked, IntPtr.Size, out returned) || linked == IntPtr.Zero)
            return false;
        CloseHandle(linked);
        return true;
    }
}
'@
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$policy = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$windows = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$elevationType = [FsTTYTokenDiagnostics]::ElevationType($identity.Token)
$hasLinkedToken = if ($elevationType -eq 2) {
    [FsTTYTokenDiagnostics]::HasLinkedToken($identity.Token)
} else {
    $false
}
$callerMode = if (-not $isAdmin) {
    'standard'
} elseif ($elevationType -eq 2 -and $hasLinkedToken) {
    'linkedStandard'
} elseif ($elevationType -eq 1) {
    'alwaysElevated'
} else {
    'invalid'
}
[PSCustomObject]@{
    WindowsVersion = $windows.DisplayVersion
    WindowsBuild = "$($windows.CurrentBuildNumber).$($windows.UBR)"
    BuiltInAdministrator = $identity.User.Value.EndsWith('-500')
    CurrentProcessHasAdminRights = $isAdmin
    TokenElevationType = @('Unknown', 'Default', 'Full', 'Limited')[$elevationType]
    LinkedStandardTokenAvailable = $hasLinkedToken
    CallerMode = $callerMode
    EnableLUA = $policy.EnableLUA
    FilterAdministratorToken = $policy.FilterAdministratorToken
    SessionId = (Get-Process -Id $PID).SessionId
} | ConvertTo-Json
