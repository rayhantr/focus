# Generates crescent-moon PNG icons for Prayer Focus.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gen-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root "assets"
New-Item -ItemType Directory -Force $assets | Out-Null

function New-Crescent([int]$size, [string]$path, [string]$hex) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $color = [System.Drawing.ColorTranslator]::FromHtml($hex)
    $brush = New-Object System.Drawing.SolidBrush $color
    $inset = [Math]::Max(1, [int]($size * 0.05))
    $d = $size - 2 * $inset
    $g.FillEllipse($brush, $inset, $inset, $d, $d)

    # punch out an offset circle to form the crescent
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $clear = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Transparent)
    $ox = [int]($size * 0.28)
    $oy = -[int]($size * 0.10)
    $g.FillEllipse($clear, $inset + $ox, $inset + $oy, $d, $d)

    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "wrote $path"
}

New-Crescent 16  (Join-Path $assets "tray-16.png")   "#35C471"
New-Crescent 128 (Join-Path $assets "toast-icon.png") "#35C471"
foreach ($s in 16, 32, 48, 256) {
    New-Crescent $s (Join-Path $assets "ico-$s.png") "#2AA75F"
}
