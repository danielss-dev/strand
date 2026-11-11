# Authenticode-sign Windows binaries through Azure Artifact Signing, then check
# that Windows trusts the signature.
#
# Usage: scripts/windows-sign.ps1 <file> [<file> ...]   (.exe or .msi)
#
# Env (release.yml sets all five when WINDOWS_SIGNING is on; docs/packaging.md):
#   WINDOWS_SIGN_DLIB       Azure.CodeSigning.Dlib.dll from the pinned
#                           Microsoft.ArtifactSigning.Client package
#   WINDOWS_SIGN_METADATA   JSON with Endpoint, CodeSigningAccountName and
#                           CertificateProfileName
#   AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET
#                           the service principal the dlib signs as (Azure.Identity
#                           environment credential)
#
# Tauri runs this as bundle.windows.signCommand for strand.exe and the MSI;
# scripts/build-companion.mjs runs it for strand-cli.exe and release.yml for
# the strand-azdo helper.
param(
    [Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Path
)
$ErrorActionPreference = 'Stop'

$dlib = $env:WINDOWS_SIGN_DLIB
$metadata = $env:WINDOWS_SIGN_METADATA
if (-not $dlib -or -not $metadata) { throw 'Signing needs WINDOWS_SIGN_DLIB and WINDOWS_SIGN_METADATA' }
foreach ($file in $dlib, $metadata) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Signing file not found: $file" }
}
# The dlib needs a recent SignTool: take the newest Windows SDK's.
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/10.*/x64/signtool.exe" |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
if (-not $signtool) { throw 'Windows SDK signtool.exe is required to sign' }

foreach ($file in $Path) {
    $full = (Resolve-Path -LiteralPath $file).Path
    & $signtool.FullName sign /v /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 `
        /dlib (Resolve-Path -LiteralPath $dlib).Path /dmdf (Resolve-Path -LiteralPath $metadata).Path $full
    if ($LASTEXITCODE -ne 0) { throw "Signing failed: $full" }
    $signature = Get-AuthenticodeSignature -LiteralPath $full
    if ($signature.Status -ne 'Valid') {
        throw "$full signature is $($signature.Status): $($signature.StatusMessage)"
    }
    Write-Host "Signed $full ($($signature.SignerCertificate.Subject))"
}
