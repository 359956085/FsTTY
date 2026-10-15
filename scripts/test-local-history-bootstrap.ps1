param([string]$Bootstrap)
$ErrorActionPreference='Stop'
$template=[IO.File]::ReadAllText($Bootstrap)
$token='e6b4ea51-2f6b-4449-9550-f4b20082a620'
$path='C:\FsTTY fixture\配置\powershell_history.txt'
foreach($scenario in @('modern','legacy','highlight-off','runtime-failure','storage-failure','module-missing','custom-editor')) {
    $script:scenario=$scenario
    $script:options=@{}
    $script:editorCalls=0
    $script:filter={param($line) $line -notlike '*private*'}
    $originalFilter=$script:filter
    function global:Import-Module { [CmdletBinding()]param([string]$Name)
        if($script:scenario -eq 'module-missing'){throw 'fixture missing module'}
    }
    if($scenario -eq 'legacy') {
        function global:Set-PSReadLineOption { [CmdletBinding()]param([string]$TokenKind,[ConsoleColor]$ForegroundColor,[string]$HistorySavePath,[string]$HistorySaveStyle)
            foreach($key in $PSBoundParameters.Keys){$script:options[$key]=$PSBoundParameters[$key]}
        }
    } else {
        function global:Set-PSReadLineOption { [CmdletBinding()]param([hashtable]$Colors,[string]$HistorySavePath,[string]$HistorySaveStyle)
            if($script:scenario -eq 'storage-failure' -and $HistorySavePath){throw 'fixture inaccessible file'}
            foreach($key in $PSBoundParameters.Keys){$script:options[$key]=$PSBoundParameters[$key]}
        }
    }
    function global:Get-Command { [CmdletBinding()]param([string]$Name)
        if($Name -eq 'PSConsoleHostReadLine') {
            return [pscustomobject]@{ModuleName=$(if($script:scenario -eq 'custom-editor'){'UserEditor'}else{'PSReadLine'});Definition='user editor';ScriptBlock={$script:editorCalls++;'fixture-line'}}
        }
        if($Name -eq 'prompt'){return [pscustomobject]@{ScriptBlock={'user prompt'}}}
        Microsoft.PowerShell.Core\Get-Command $Name
    }
    $highlight=if($scenario -in @('highlight-off','runtime-failure')){''}else{$token}
    $source=$template.Replace('__COMMAND_TOKEN__','').Replace('__TOKEN__',$highlight).Replace('__HISTORY_TOKEN__',$token).Replace('__HISTORY_PATH__',[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path))).Replace('__ELEVATED__','$false')
    & ([ScriptBlock]::Create($source))
    if($scenario -in @('module-missing','custom-editor')) {
        if($script:options.Count){throw 'incompatible editor was changed'}
    } elseif($scenario -eq 'storage-failure') {
        if($script:options.HistorySaveStyle -ne 'SaveNothing'){throw 'must not write external history on failure'}
    } else {
        if($script:options.HistorySaveStyle -ne 'SaveIncrementally' -or $script:options.HistorySavePath -ne $path){throw 'dedicated history options missing'}
        if($scenario -eq 'highlight-off' -and $script:options.ContainsKey('Colors')){throw 'history-only startup changed colors'}
    }
    if($script:filter -ne $originalFilter -or $script:editorCalls){throw 'history bootstrap changed filtering or read a command'}
    if($scenario -eq 'runtime-failure') {
        $file=[IO.Path]::GetTempFileName()
        try {
            $global:__FsTTYHistoryPath=$file
            __FsTTYHistoryCheck
            if(-not $global:__FsTTYHistoryReady){throw 'healthy native file incorrectly rejected'}
            $busy=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
            try {
                __FsTTYHistoryCheck
                if(-not $global:__FsTTYHistoryReady -or $global:__FsTTYHistoryWarned){throw 'another tab holding the file caused a false failure'}
            } finally {$busy.Dispose()}
            [IO.File]::Delete($file)
            if((PSConsoleHostReadLine) -ne 'fixture-line' -or $script:editorCalls -ne 1){throw 'history failure broke editor'}
            if($script:options.HistorySaveStyle -ne 'SaveNothing' -or -not $global:__FsTTYHistoryWarned){throw 'runtime failure did not degrade'}
            __FsTTYHistoryCheck
        } finally {if([IO.File]::Exists($file)){[IO.File]::Delete($file)}}
    }
    Write-Output ('PASS '+$scenario)
}
