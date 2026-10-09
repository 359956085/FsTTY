param([string]$Bootstrap)
$ErrorActionPreference='Stop'
$script:source=[IO.File]::ReadAllText($Bootstrap).Replace('__TOKEN__','e6b4ea51-2f6b-4449-9550-f4b20082a620')
foreach($scenario in @('modern','legacy','missing','custom','elevated-owner','elevated-write','elevated-trusted','elevated-sid-read','elevated-acl-error','elevated-candidate-error')) {
    $script:scenario=$scenario
    $script:colors=@{}
    $script:lineCalls=0
    function global:Import-Module { [CmdletBinding()]param([string]$Name)
        if($script:scenario -eq 'missing'){ throw 'test-missing-module' }
    }
    if($scenario -eq 'legacy'){
        function global:Set-PSReadLineOption { [CmdletBinding()]param([string]$TokenKind,[ConsoleColor]$ForegroundColor)
            $script:colors[$TokenKind]=$ForegroundColor.ToString()
        }
    }else{
        function global:Set-PSReadLineOption { [CmdletBinding()]param([hashtable]$Colors)
            $script:colors=$Colors
        }
    }
    function global:Get-Command { [CmdletBinding()]param([string]$Name)
        if($Name -eq 'PSConsoleHostReadLine') {
            $module=if($script:scenario -eq 'custom'){'custom'}else{'PSReadLine'}
            return [pscustomobject]@{ModuleName=$module; Definition='custom-editor-definition'; ScriptBlock={ $script:lineCalls++; return 'private-command-not-logged' }}
        }
        if($Name -eq 'prompt'){return [pscustomobject]@{ScriptBlock={return 'original-prompt'}}}
        Microsoft.PowerShell.Core\Get-Command $Name
    }
    if ($scenario -like 'elevated-*') {
        function global:Get-Module { [CmdletBinding()]param([string]$Name,[switch]$ListAvailable)
            if ($script:scenario -eq 'elevated-candidate-error') {
                if (-not $ListAvailable) { return }
                [pscustomobject]@{ Path='C:\FsTTYBadCandidate\PSReadLine.psm1'; Version=[version]'3.0' }
            }
            [pscustomobject]@{ Path='C:\FsTTYTest\PSReadLine\PSReadLine.psm1'; Version=[version]'2.0' }
        }
        function global:Get-Item { [CmdletBinding()]param([string]$LiteralPath,[switch]$Force)
            if ($LiteralPath -like 'C:\FsTTYBadCandidate*') { throw 'candidate-acl-unavailable' }
            [pscustomobject]@{ FullName=$LiteralPath; Attributes=[IO.FileAttributes]::Directory }
        }
        function global:Get-ChildItem { [CmdletBinding()]param([string]$LiteralPath,[switch]$Force,[switch]$Recurse) }
        function global:Get-Acl { [CmdletBinding()]param([string]$LiteralPath)
            if ($script:scenario -eq 'elevated-acl-error') { throw 'acl-unavailable' }
            $writable=$script:scenario -in @('elevated-owner','elevated-write')
            $acl=[pscustomobject]@{Rules=@([pscustomobject]@{
                AccessControlType='Allow'; FileSystemRights=$(if ($writable) { 2 } else { 0x200A9 });
                IdentityReference=[Security.Principal.SecurityIdentifier]'S-1-5-21-111-222-333-444'
            })}
            # NTAccount conversion can throw for otherwise valid orphaned SIDs.
            $acl | Add-Member -MemberType ScriptProperty -Name Access -Value { throw 'account-translation-unavailable' }
            $acl | Add-Member -MemberType ScriptMethod -Name GetAccessRules -Value {
                param($explicit, $inherited, $identityType)
                if (-not $explicit -or -not $inherited -or $identityType -ne [Security.Principal.SecurityIdentifier]) { throw 'SID rules required' }
                $this.Rules
            }
            $acl | Add-Member -MemberType ScriptMethod -Name GetOwner -Value {
                param($type)
                if ($script:scenario -eq 'elevated-owner') { [Security.Principal.SecurityIdentifier]'S-1-5-32-545' }
                else { [Security.Principal.SecurityIdentifier]'S-1-5-32-544' }
            }
            $acl
        }
    }
    $elevated=if ($scenario -like 'elevated-*'){'$true'}else{'$false'}
    & ([ScriptBlock]::Create($script:source.Replace('__ELEVATED__',$elevated)))
    if($scenario -in @('modern','legacy','elevated-trusted','elevated-sid-read','elevated-candidate-error')) {
        $value=PSConsoleHostReadLine
        if($value -ne 'private-command-not-logged' -or $script:lineCalls -ne 1){throw 'line editor result changed'}
        if((prompt) -ne 'original-prompt'){throw 'prompt changed'}
        $expected=if($scenario -eq 'legacy'){'DarkBlue'}else{([char]27).ToString()+'[34m'}
        if($script:colors.Command -ne $expected){throw 'command color mismatch'}
        if($script:colors.Count -lt 9){throw 'semantic colors missing'}
    }elseif($script:colors.Count -ne 0){throw 'failed/custom module changed colors'}
    Write-Output ('PASS '+$scenario)
}
