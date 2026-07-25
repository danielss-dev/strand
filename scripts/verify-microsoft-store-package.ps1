param(
    [Parameter(Mandatory = $true)]
    [string]$MsiPath,

    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'

function Assert-ValidSignature {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    if ($signature.Status -ne 'Valid') {
        throw "Microsoft Store signature check failed for $resolved`: $($signature.Status) ($($signature.StatusMessage))"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "Microsoft Store signature check found no signer for $resolved"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "Microsoft Store signature check found no timestamp for $resolved"
    }

    Write-Host "Valid Authenticode signature: $resolved"
    Write-Host "  Signer: $($signature.SignerCertificate.Subject)"
    Write-Host "  Timestamp: $($signature.TimeStamperCertificate.Subject)"
}

Assert-ValidSignature -Path $ExecutablePath
Assert-ValidSignature -Path $MsiPath
