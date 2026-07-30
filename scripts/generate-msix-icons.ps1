param(
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourcePath = Join-Path $repoRoot 'strand.png'
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot 'crates\strand-tauri\icons'
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$targetSizes = @(
    16, 20, 24, 30, 32, 36, 40, 44,
    48, 60, 64, 72, 80, 96, 256
)
$alternateForms = @('unplated', 'lightunplated')
$source = [Drawing.Image]::FromFile($sourcePath)

try {
    foreach ($targetSize in $targetSizes) {
        foreach ($alternateForm in $alternateForms) {
            $bitmap = [Drawing.Bitmap]::new(
                $targetSize,
                $targetSize,
                [Drawing.Imaging.PixelFormat]::Format32bppArgb
            )
            try {
                $graphics = [Drawing.Graphics]::FromImage($bitmap)
                try {
                    $graphics.Clear([Drawing.Color]::Transparent)
                    $graphics.CompositingMode =
                        [Drawing.Drawing2D.CompositingMode]::SourceCopy
                    $graphics.CompositingQuality =
                        [Drawing.Drawing2D.CompositingQuality]::HighQuality
                    $graphics.InterpolationMode =
                        [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $graphics.PixelOffsetMode =
                        [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                    $graphics.SmoothingMode =
                        [Drawing.Drawing2D.SmoothingMode]::HighQuality
                    $graphics.DrawImage(
                        $source,
                        [Drawing.Rectangle]::new(0, 0, $targetSize, $targetSize),
                        0,
                        0,
                        $source.Width,
                        $source.Height,
                        [Drawing.GraphicsUnit]::Pixel
                    )
                } finally {
                    $graphics.Dispose()
                }

                $filename =
                    "Square44x44Logo.targetsize-$($targetSize)_altform-$alternateForm.png"
                $bitmap.Save(
                    (Join-Path $OutputDirectory $filename),
                    [Drawing.Imaging.ImageFormat]::Png
                )
            } finally {
                $bitmap.Dispose()
            }
        }
    }
} finally {
    $source.Dispose()
}

Write-Host (
    "Generated $($targetSizes.Count * $alternateForms.Count) " +
    "MSIX app-list icons in $OutputDirectory"
)
