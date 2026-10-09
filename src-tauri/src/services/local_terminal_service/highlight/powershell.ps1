$global:__FsTTYHighlightToken = '__TOKEN__'
function global:__FsTTYHighlightPhase([string]$phase) {
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
    $stage = 'psreadline-phases'
    $global:__FsTTYOriginalReadLine = (Get-Command PSConsoleHostReadLine).ScriptBlock
    $global:__FsTTYOriginalPrompt = (Get-Command prompt).ScriptBlock
    function global:prompt {
        __FsTTYHighlightPhase 'prompt'
        & $global:__FsTTYOriginalPrompt
    }
    function global:PSConsoleHostReadLine {
        __FsTTYHighlightPhase 'input'
        try {
            $line = & $global:__FsTTYOriginalReadLine
            __FsTTYHighlightPhase 'execute'
            return $line
        } catch {
            __FsTTYHighlightPhase 'prompt'
            throw
        }
    }
    __FsTTYHighlightPhase 'ready'
} catch {
    __FsTTYHighlightPhase ('failed:' + $stage)
}

