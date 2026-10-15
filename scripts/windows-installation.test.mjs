import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.platform !== 'win32')('Windows installation validation', () => {
  it('validates beta installations with full helper filenames and rejects invalid versions', () => {
    const source = readFileSync('scripts/test-windows-installation.ps1', 'utf8').replace(/^\uFEFF/, '');
    const fixture = String.raw`
$ErrorActionPreference='Stop'
$script:fixtureVersion=''
$script:helpers=@()
$desktop='C:\Fixture\Desktop'
$protected=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'FsTTY'
function Get-CimInstance { param($ClassName,$Filter)
    [pscustomobject]@{State='Running';StartName='NT SERVICE\FsTTYBroker';PathName=('"'+(Join-Path $protected 'fstty-broker.exe')+'" --service')}
}
function Test-Path { param($LiteralPath)
    if($LiteralPath -like '*transaction.json'){return $false}
    if($LiteralPath -like '*fstty-update-helper-*'){$script:helpers+= $LiteralPath}
    return $true
}
function Get-Content { param($LiteralPath,[switch]$Raw,$Encoding)
    @{directory=$desktop;files=@('fstty.exe');version=$script:fixtureVersion;sha256='FIXTURE'} | ConvertTo-Json
}
function Get-ItemProperty { param($LiteralPath,$ErrorAction)
    [pscustomobject]@{UninstallString=('"'+(Join-Path $protected 'uninstall.exe')+'"');InstallLocation=$desktop}
}
function Get-FileHash { param($LiteralPath,$Algorithm) [pscustomobject]@{Hash='FIXTURE'} }
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__SOURCE__'))
foreach($version in @('1.7.0','1.7.1','2.0.0','2.0.0.0','2.0.1-beta.2')) {
    $script:fixtureVersion=$version
    $script:helpers=@()
    $null=& ([ScriptBlock]::Create($source)) -Mode AssertInstalled -ExpectedDesktopDirectory $desktop
    if($version -ne '1.7.0' -and $script:helpers -notcontains (Join-Path $protected "fstty-update-helper-$version.exe")){throw 'full helper version was lost'}
    Write-Output "PASS $version"
}
foreach($version in @('bad','2.0.1-beta.0','2.0.1-beta.01','2.0.1-rc.1','2.0.1.1')) {
    $script:fixtureVersion=$version
    $rejected=$false
    try {$null=& ([ScriptBlock]::Create($source)) -Mode AssertInstalled -ExpectedDesktopDirectory $desktop}
    catch {if($_.Exception.Message -notlike '*版本格式*'){throw};$rejected=$true}
    if(-not $rejected){throw 'invalid version accepted'}
}
Write-Output 'PASS invalid'
`.replace('__SOURCE__', Buffer.from(source).toString('base64'));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fixture, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    for (const version of ['1.7.0','1.7.1','2.0.0','2.0.0.0','2.0.1-beta.2','invalid']) expect(result.stdout).toContain(`PASS ${version}`);
  }, 30_000);
});
