param(
    [string]$IdentityName = 'dev.danielss.strand.msix.test',
    [string]$Publisher = 'CN=Strand MSIX Development',
    [string]$PublisherDisplayName = 'Daniel Schwarz',
    [string]$PackageVersion,
    [string]$OutputPath,
    [switch]$SkipAppBuild,
    [switch]$StoreSubmission
)

$ErrorActionPreference = 'Stop'

function ConvertTo-XmlText {
    param([Parameter(Mandatory = $true)][string]$Value)
    return [System.Security.SecurityElement]::Escape($Value)
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Candidate
    )
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $candidatePath = [IO.Path]::GetFullPath($Candidate)
    if (-not $candidatePath.StartsWith("$rootPath\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside $rootPath`: $candidatePath"
    }
    return $candidatePath
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageJson = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'package.json') |
    ConvertFrom-Json

if (-not $PackageVersion) {
    $parts = [string]$packageJson.version -split '\.'
    if ($parts.Count -ne 3) {
        throw "package.json version must have three numeric parts, got $($packageJson.version)"
    }
    $PackageVersion = "$($parts[0]).$($parts[1]).$($parts[2]).0"
}

if ($IdentityName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$') {
    throw 'IdentityName must be 3-50 characters using letters, numbers, periods, or hyphens.'
}
if ($PackageVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw 'PackageVersion must use four numeric parts, for example 1.1.1.0.'
}
foreach ($part in $PackageVersion -split '\.') {
    if ([int64]$part -gt 65535) {
        throw 'Every PackageVersion part must be between 0 and 65535.'
    }
}
try {
    [void][System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($Publisher)
} catch {
    throw "Publisher must be a valid X.500 distinguished name: $Publisher"
}
if ([string]::IsNullOrWhiteSpace($PublisherDisplayName)) {
    throw 'PublisherDisplayName is required.'
}
if ($StoreSubmission) {
    if ($IdentityName.EndsWith('.test', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'StoreSubmission requires the exact Partner Center package Identity Name.'
    }
    if ($Publisher -eq 'CN=Strand MSIX Development') {
        throw 'StoreSubmission requires the exact Partner Center Publisher ID.'
    }
}

$targetRoot = Join-Path $repoRoot 'target\msix'
$layoutPath = Assert-ChildPath -Root $repoRoot -Candidate (Join-Path $targetRoot 'layout')
$distPath = Assert-ChildPath -Root $repoRoot -Candidate (Join-Path $targetRoot 'dist')
if (-not $OutputPath) {
    $OutputPath = Join-Path $distPath "Strand_$($PackageVersion)_x64.msix"
}
$OutputPath = Assert-ChildPath -Root $repoRoot -Candidate $OutputPath

if (-not $SkipAppBuild) {
    $previousDistribution = $env:VITE_DISTRIBUTION
    try {
        $env:VITE_DISTRIBUTION = 'msix'
        & (Join-Path $repoRoot 'node_modules\.bin\tauri.CMD') build --no-bundle --ci
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri application build failed with exit code $LASTEXITCODE"
        }
    } finally {
        $env:VITE_DISTRIBUTION = $previousDistribution
    }
}

$executablePath = Join-Path $repoRoot 'target\release\strand.exe'
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "Missing application executable: $executablePath"
}

if (Test-Path -LiteralPath $layoutPath) {
    Remove-Item -LiteralPath $layoutPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $layoutPath 'Assets') | Out-Null
New-Item -ItemType Directory -Force -Path $distPath | Out-Null

Copy-Item -LiteralPath $executablePath -Destination (Join-Path $layoutPath 'strand.exe')
foreach ($asset in @('StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png')) {
    Copy-Item `
        -LiteralPath (Join-Path $repoRoot "crates\strand-tauri\icons\$asset") `
        -Destination (Join-Path $layoutPath "Assets\$asset")
}
$targetSizes = @(
    16, 20, 24, 30, 32, 36, 40, 44,
    48, 60, 64, 72, 80, 96, 256
)
foreach ($targetSize in $targetSizes) {
    foreach ($alternateForm in @('unplated', 'lightunplated')) {
        $asset =
            "Square44x44Logo.targetsize-$($targetSize)_altform-$alternateForm.png"
        Copy-Item `
            -LiteralPath (Join-Path $repoRoot "crates\strand-tauri\icons\$asset") `
            -Destination (Join-Path $layoutPath "Assets\$asset")
    }
}

$templatePath = Join-Path $repoRoot 'packaging\msix\AppxManifest.xml.in'
$manifest = Get-Content -Raw -LiteralPath $templatePath
$manifest = $manifest.Replace('__IDENTITY_NAME__', (ConvertTo-XmlText $IdentityName))
$manifest = $manifest.Replace('__PUBLISHER__', (ConvertTo-XmlText $Publisher))
$manifest = $manifest.Replace(
    '__PUBLISHER_DISPLAY_NAME__',
    (ConvertTo-XmlText $PublisherDisplayName)
)
$manifest = $manifest.Replace('__VERSION__', $PackageVersion)
$manifestPath = Join-Path $layoutPath 'AppxManifest.xml'
[IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))

$sdkRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
$makeAppx = Get-ChildItem -LiteralPath $sdkRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64\makeappx.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if (-not $makeAppx) {
    throw 'MakeAppx.exe was not found. Install the Windows SDK.'
}

& $makeAppx pack /o /v /h SHA256 /d $layoutPath /p $OutputPath
if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx failed with exit code $LASTEXITCODE"
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash
Write-Host "Built MSIX: $OutputPath"
if ($StoreSubmission) {
    $uploadPath = [IO.Path]::ChangeExtension($OutputPath, '.msixupload')
    $zipPath = [IO.Path]::ChangeExtension($OutputPath, '.zip')
    foreach ($candidate in @($uploadPath, $zipPath)) {
        if (Test-Path -LiteralPath $candidate) {
            Remove-Item -LiteralPath $candidate -Force
        }
    }
    Compress-Archive -LiteralPath $OutputPath -DestinationPath $zipPath
    Move-Item -LiteralPath $zipPath -Destination $uploadPath
    Write-Host "Built Store upload: $uploadPath"
}
Write-Host "Identity: $IdentityName"
Write-Host "Publisher: $Publisher"
Write-Host "Version: $PackageVersion"
Write-Host "SHA-256: $hash"
if (-not $StoreSubmission) {
    Write-Warning 'This package uses the development identity and is not a Partner Center submission.'
}
