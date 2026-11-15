$ErrorActionPreference = 'Stop'
$bad = 0
$files = @(git ls-files '*.ps1' '*.psm1' '*.psd1')
if ($LASTEXITCODE) { throw 'git ls-files failed' }
foreach ($file in $files) {
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD $file), [ref]$null, [ref]$parseErrors) | Out-Null
    foreach ($error in $parseErrors) {
        Write-Host "${file}:$($error.Extent.StartLineNumber): $($error.Message)"
        $bad++
    }
}
if ($bad) { throw "$bad PowerShell parse errors" }
