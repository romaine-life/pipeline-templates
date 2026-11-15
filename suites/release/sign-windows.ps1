$ErrorActionPreference = 'Stop'
if (-not $env:AT_TERMINAL_PFX) { throw 'AT_TERMINAL_PFX is missing' }
$bytes = [Convert]::FromBase64String($env:AT_TERMINAL_PFX)
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $bytes, $env:AT_TERMINAL_PFX_PASSWORD,
    [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
try {
    $files = @(Get-ChildItem -LiteralPath dist -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll', '.ps1', '.psm1', '.psd1' })
    if (-not $files.Count) { throw 'dist has no Authenticode assets; non-Authenticode packaging remains a one-off' }
    foreach ($file in $files) {
        $result = Set-AuthenticodeSignature -LiteralPath $file.FullName -Certificate $certificate -HashAlgorithm SHA256
        if ($result.Status -ne 'Valid') { throw "Signing $($file.Name): $($result.StatusMessage)" }
    }
} finally {
    $certificate.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
}
