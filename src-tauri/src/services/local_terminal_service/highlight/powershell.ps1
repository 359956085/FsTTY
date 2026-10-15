$global:__FsTTYHighlightToken = '__TOKEN__'
$global:__FsTTYHistoryToken = '__HISTORY_TOKEN__'
$global:__FsTTYHistoryPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__HISTORY_PATH__'))
$global:__FsTTYHistoryReady = $false
$global:__FsTTYHistoryWarned = $false
$global:__FsTTYCommandToken = '__COMMAND_TOKEN__'
$global:__FsTTYCommandSequence = 0
$global:__FsTTYCommandEnabled = $false
$global:__FsTTYCommandWarned = $false
function global:__FsTTYGlobalPhase([string]$value) {
    if ($global:__FsTTYCommandToken) { [Console]::Write(([char]27).ToString()+']777;fstty-global:'+$global:__FsTTYCommandToken+':'+$value+[char]7) }
}
function global:__FsTTYGlobalFailed {
    if (-not $global:__FsTTYCommandWarned) {
        $global:__FsTTYCommandWarned=$true
        __FsTTYGlobalPhase 'unavailable'
    }
}
function global:__FsTTYInsertionCapability {
    try {
        if ((Get-PSReadLineOption).EditMode.ToString() -eq 'Vi') { return 'copy' }
        $keys = @(Get-PSReadLineKeyHandler -Bound)
        if ($keys | Where-Object { $_.Key -in @('Ctrl+Alt+F12','Alt+Ctrl+F12') -and $_.Function -eq ('FsTTYHistoryClear_'+$global:__FsTTYCommandToken) }) { return 'clear' }
    } catch { }
    return 'copy'
}
function __FsTTYInstallInsertion {
    try {
        if ((Get-PSReadLineOption).EditMode.ToString() -eq 'Vi') { return }
        $keys=@(Get-PSReadLineKeyHandler -Bound)
        if ($keys | Where-Object { $_.Key -in @('Ctrl+Alt+F12','Alt+Ctrl+F12') }) { return }
        Set-PSReadLineKeyHandler -Chord 'Ctrl+Alt+F12' -BriefDescription ('FsTTYHistoryClear_'+$global:__FsTTYCommandToken) -ScriptBlock {
            $text=$null; $cursor=0
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$text,[ref]$cursor)
            [Microsoft.PowerShell.PSConsoleReadLine]::Delete(0,$text.Length)
        } -ErrorAction Stop
    } catch { }
}
function global:__FsTTYCaptureCommand([string]$line) {
    if (-not $global:__FsTTYCommandEnabled -or -not $line) { return }
    if ($global:__FsTTYPendingLine -ceq $line) {
        $global:__FsTTYLastLine=$line
        $global:__FsTTYLastAllowed=$global:__FsTTYPendingAllowed
    } elseif ($global:__FsTTYLastLine -cne $line) { return }
    # A native duplicate may bypass the filter; reuse only the last decision
    # for that exact accepted line, never evaluate the user's filter twice.
    if (-not $global:__FsTTYLastAllowed -or $line -match '[\x00-\x1f\x7f-\x9f]' -or [string]::IsNullOrWhiteSpace($line)) { return }
    $bytes=[Text.Encoding]::UTF8.GetBytes($line)
    if ($bytes.Length -gt 65536) { return }
    $global:__FsTTYCommandSequence++
    __FsTTYGlobalPhase ('command:'+$global:__FsTTYCommandSequence+':'+[Convert]::ToBase64String($bytes))
}
function global:__FsTTYHistoryFailed {
    if ($global:__FsTTYHistoryToken -and -not $global:__FsTTYHistoryWarned) {
        $global:__FsTTYHistoryWarned = $true
        [Console]::Write(([char]27).ToString() + ']777;fstty-history:' + $global:__FsTTYHistoryToken + ':failed' + [char]7)
    }
}
function global:__FsTTYHistoryCheck {
    if (-not $global:__FsTTYHistoryReady) { return }
    try {
        # Probe access without reading command text or changing file contents.
        $file = [IO.File]::Open($global:__FsTTYHistoryPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        $file.Dispose()
    } catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        # A different tab can briefly own PSReadLine's history mutex/file.
        # A sharing/lock violation is not a persistence failure; the native
        # editor retries under its own mutex, without delaying input here.
        if (($failure.HResult -band 0xFFFF) -in @(32, 33)) { return }
        $global:__FsTTYHistoryReady = $false
        try { Set-PSReadLineOption -HistorySaveStyle SaveNothing -ErrorAction Stop } catch { }
        __FsTTYHistoryFailed
    }
}
function global:__FsTTYHighlightPhase([string]$phase) {
    if (-not $global:__FsTTYHighlightToken) { return }
    # Standard boundaries keep console API output before the nonce notification.
    $boundary = @{prompt='A'; input='B'; execute='C'}[$phase]
    if ($boundary) { [Console]::Write(([char]27).ToString() + ']133;' + $boundary + [char]7) }
    [Console]::Write(([char]27).ToString() + ']777;fstty-highlight:' + $global:__FsTTYHighlightToken + ':' + $phase + [char]7)
}
function __FsTTYTrustedModule([string]$path) {
    try {
        # Elevated initialization never imports code from a user-writable module tree.
        $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
        $root = Split-Path -Parent $path
        $items = @(Get-Item -LiteralPath $root -Force -ErrorAction Stop) + @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop)
        $parent = Split-Path -Parent $root
        while ($parent -and $parent -ne [IO.Path]::GetPathRoot($parent)) {
            $items += Get-Item -LiteralPath $parent -Force -ErrorAction Stop
            $parent = Split-Path -Parent $parent
        }
        foreach ($item in $items) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
            $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
            $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
            if ($trusted -notcontains $owner) { return $false }
            # Request SID rules directly: sandbox/service identities can have no
            # resolvable account name even though their ACL entries are valid.
            foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
                $sid = $rule.IdentityReference.Value
                # Create/write/delete/ACL/owner rights; read and execute remain allowed.
                if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band 0xD0156) -and $trusted -notcontains $sid) { return $false }
            }
        }
        return $true
    } catch {
        # Unreadable or invalid candidates stay untrusted; do not prevent the
        # caller from considering another machine-installed module.
        return $false
    }
}
try {
    $stage = 'custom-line-editor'
    # A profile's replacement line editor is authoritative; do not replace it.
    $editor = Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue
    if ($editor -and $editor.ModuleName -ne 'PSReadLine' -and $editor.Definition -notmatch '^\s*\[Microsoft\.PowerShell\.PSConsoleReadLine\]::ReadLine\(') {
        throw 'custom-line-editor'
    }
    $stage = 'psreadline-import'
    if (__ELEVATED__) {
        $stage = 'psreadline-security'
        $loaded = Get-Module PSReadLine
        if ($loaded -and -not (__FsTTYTrustedModule $loaded.Path)) { throw 'untrusted-loaded-module' }
        $module = Get-Module -ListAvailable PSReadLine | Sort-Object Version -Descending | Where-Object { __FsTTYTrustedModule $_.Path } | Select-Object -First 1
        if (-not $module) { throw 'trusted-module-unavailable' }
        Import-Module -Name $module.Path -ErrorAction Stop
    } else {
        Import-Module PSReadLine -ErrorAction Stop
    }
    if ($global:__FsTTYCommandToken) {
        __FsTTYInstallInsertion
        try {
            if (-not (Get-Command Set-PSReadLineOption).Parameters.ContainsKey('AddToHistoryHandler')) { throw 'history-filter-unavailable' }
            $global:__FsTTYOriginalHistoryHandler=(Get-PSReadLineOption).AddToHistoryHandler
            $global:__FsTTYDefaultHistoryMethod=[Microsoft.PowerShell.PSConsoleReadLine].GetMethod('GetDefaultAddToHistoryOption', [type[]]@([string]))
            if (-not $global:__FsTTYOriginalHistoryHandler -and -not $global:__FsTTYDefaultHistoryMethod -and
                (Get-Module PSReadLine).Version -ge [version]'2.1') { throw 'default-filter-unavailable' }
            $global:__FsTTYLastLine=$null
            $global:__FsTTYLastAllowed=$false
            Set-PSReadLineOption -AddToHistoryHandler {
                param([string]$candidate)
                try {
                    $decision=if ($global:__FsTTYOriginalHistoryHandler) { $global:__FsTTYOriginalHistoryHandler.Invoke($candidate) }
                        elseif ($global:__FsTTYDefaultHistoryMethod) { $global:__FsTTYDefaultHistoryMethod.Invoke($null, @($candidate)) }
                        else { $true }
                    $global:__FsTTYPendingLine=$candidate
                    $global:__FsTTYPendingAllowed=if ($decision -is [bool]) { $decision } else { "$decision" -eq 'MemoryAndFile' }
                    return $decision
                } catch { $global:__FsTTYCommandEnabled=$false; __FsTTYGlobalFailed; throw }
            } -ErrorAction Stop
            $global:__FsTTYCommandEnabled=$true
        } catch { __FsTTYGlobalFailed }
    }
    if ($global:__FsTTYHistoryToken) {
        try {
            if (-not $global:__FsTTYHistoryPath) { throw 'history-storage-unavailable' }
            Set-PSReadLineOption -HistorySavePath $global:__FsTTYHistoryPath -HistorySaveStyle SaveIncrementally -ErrorAction Stop
            $global:__FsTTYHistoryReady = $true
        } catch {
            # Never fall back to the external console's default history file.
            try { Set-PSReadLineOption -HistorySaveStyle SaveNothing -ErrorAction Stop } catch { }
            __FsTTYHistoryFailed
        }
    }
    if ($global:__FsTTYHighlightToken) {
    $stage = 'psreadline-colors'
    $colors = @{ Command='34'; Keyword='34'; Parameter='36'; String='32'; Variable='35'; Number='33'; Comment='90'; Type='36'; Operator='36'; Member='34'; Error='31' }
    if ((Get-Command Set-PSReadLineOption).Parameters.ContainsKey('Colors')) {
        $ansi = @{}
        foreach ($key in $colors.Keys) { $ansi[$key] = ([char]27).ToString() + '[' + $colors[$key] + 'm' }
        Set-PSReadLineOption -Colors $ansi -ErrorAction Stop
    } else {
        $legacy = @{ Command='DarkBlue'; Keyword='DarkBlue'; Parameter='DarkCyan'; String='DarkGreen'; Variable='DarkMagenta'; Number='DarkYellow'; Comment='DarkGray'; Type='DarkCyan'; Operator='DarkCyan'; Member='DarkBlue' }
        foreach ($key in $legacy.Keys) { Set-PSReadLineOption -TokenKind $key -ForegroundColor $legacy[$key] -ErrorAction Stop }
        if ((Get-Command Set-PSReadLineOption).Parameters.ContainsKey('ErrorForegroundColor')) { Set-PSReadLineOption -ErrorForegroundColor DarkRed -ErrorAction Stop }
    }
    }
    $stage = 'psreadline-phases'
    $global:__FsTTYOriginalReadLine = (Get-Command PSConsoleHostReadLine).ScriptBlock
    $global:__FsTTYOriginalPrompt = (Get-Command prompt).ScriptBlock
    function global:prompt {
        __FsTTYHighlightPhase 'prompt'
        & $global:__FsTTYOriginalPrompt
    }
    function global:PSConsoleHostReadLine {
        __FsTTYHistoryCheck
        __FsTTYGlobalPhase ('input:'+(__FsTTYInsertionCapability))
        $global:__FsTTYPendingLine=$null
        __FsTTYHighlightPhase 'input'
        try {
            $line = & $global:__FsTTYOriginalReadLine
            __FsTTYCaptureCommand $line
            __FsTTYGlobalPhase 'execute'
            __FsTTYHighlightPhase 'execute'
            return $line
        } catch {
            __FsTTYHighlightPhase 'prompt'
            throw
        }
    }
    __FsTTYHighlightPhase 'ready'
} catch {
    __FsTTYGlobalFailed
    if (-not $global:__FsTTYHistoryReady) { __FsTTYHistoryFailed }
    __FsTTYHighlightPhase ('failed:' + $stage)
}

