param([string]$Bootstrap)
$ErrorActionPreference='Stop'
# A mock public type makes this test independent of machine module versions,
# execution policy and personal history. Real modules belong to ConPTY fixtures.
if (-not ('Microsoft.PowerShell.PSConsoleReadLine' -as [type])) {
    Add-Type 'namespace Microsoft.PowerShell { public class PSConsoleReadLine { public static object GetDefaultAddToHistoryOption(string line) { return "MemoryAndFile"; } } }'
}
$template=[IO.File]::ReadAllText($Bootstrap)
$token='e6b4ea51-2f6b-4449-9550-f4b20082a620'
foreach($scenario in @('allow','memory','skip','false','multiline','cancel','custom','binding')) {
    $script:scenario=$scenario
    $script:filterCalls=0
    $script:installed=$null
    $script:keyInstalled=$false
    $script:line=if($scenario -eq 'multiline'){"echo one`necho two"}else{'echo 中文 & quoted'}
    $script:original=[Func[string,object]]{
        param($line)
        $script:filterCalls++
        if($script:scenario -eq 'memory'){return 'MemoryOnly'}
        if($script:scenario -eq 'skip'){return 'SkipAdding'}
        if($script:scenario -eq 'false'){return $false}
        return 'MemoryAndFile'
    }
    function global:Import-Module { [CmdletBinding()]param([string]$Name) }
    function global:Get-PSReadLineOption { [pscustomobject]@{AddToHistoryHandler=$script:original;EditMode='Windows'} }
    function global:Get-PSReadLineKeyHandler { param([switch]$Bound)
        if($script:keyInstalled -or $script:scenario -eq 'binding') {
            [pscustomobject]@{Key='Ctrl+Alt+F12';Function=$(if($script:scenario -eq 'binding'){'UserCustom'}else{'FsTTYHistoryClear_'+$global:__FsTTYCommandToken})}
        }
    }
    function global:Set-PSReadLineKeyHandler { [CmdletBinding()]param($Chord,$BriefDescription,$ScriptBlock)
        $script:keyInstalled=$true
    }
    function global:Set-PSReadLineOption { [CmdletBinding()]param([object]$AddToHistoryHandler,[hashtable]$Colors)
        if($PSBoundParameters.ContainsKey('AddToHistoryHandler')){$script:installed=$AddToHistoryHandler}
    }
    function global:Get-Command { [CmdletBinding()]param([string]$Name)
        if($Name -eq 'PSConsoleHostReadLine') {
            [pscustomobject]@{ModuleName=$(if($script:scenario -eq 'custom'){'UserEditor'}else{'PSReadLine'});Definition='custom';ScriptBlock={
                # Initial loading can invoke the same filter: it is not a new submission.
                $null=& $script:installed 'OLD_FILE_COMMAND'
                $script:decision=& $script:installed $script:line
                if($script:scenario -eq 'cancel'){throw [OperationCanceledException]::new()}
                return $script:line
            }}
            return
        }
        if($Name -eq 'prompt'){return [pscustomobject]@{ScriptBlock={'prompt'}}}
        Microsoft.PowerShell.Core\Get-Command $Name
    }
    $source=$template.Replace('__TOKEN__','').Replace('__HISTORY_TOKEN__','').Replace('__HISTORY_PATH__','').Replace('__COMMAND_TOKEN__',$token).Replace('__ELEVATED__','$false')
    Write-Output ('BEGIN '+$scenario)
    & ([ScriptBlock]::Create($source))
    if($scenario -eq 'custom') {
        if($script:installed){throw 'custom editor was modified'}
    } else {
        try {$result=PSConsoleHostReadLine} catch {if($scenario -ne 'cancel'){throw}}
        if($script:filterCalls -ne 2){throw 'native filter must be called exactly once per native request'}
        if($scenario -ne 'cancel' -and $result -cne $script:line){throw 'line editor result changed'}
        $expected=if($scenario -eq 'memory'){'MemoryOnly'}elseif($scenario -eq 'skip'){'SkipAdding'}elseif($scenario -eq 'false'){$false}else{'MemoryAndFile'}
        if($script:decision -cne $expected){throw 'filter return value changed'}
        if($scenario -eq 'allow') {
            # Native duplicate suppression can skip re-running the filter.
            $global:__FsTTYPendingLine=$null
            __FsTTYCaptureCommand $script:line
        }
    }
    Write-Output ('PASS '+$scenario)
}
