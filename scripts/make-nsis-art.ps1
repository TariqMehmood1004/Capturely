# Regenerates the NSIS installer artwork (src-tauri/icons/nsis-sidebar.bmp, nsis-header.bmp)
# from src-tauri/icons/icon.png. NSIS needs 24-bit BMPs at exactly 164x314 (welcome/finish
# sidebar) and 150x57 (page header); both are drawn at 4x and downscaled for clean edges.
#   powershell -ExecutionPolicy Bypass -File scripts/make-nsis-art.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root  = Split-Path -Parent $PSScriptRoot
$icons = Join-Path $root 'src-tauri\icons'
$logo  = [System.Drawing.Image]::FromFile((Join-Path $icons 'icon.png'))
$S = 4

function Hex([string]$h, [int]$a = 255) {
  $c = [System.Drawing.ColorTranslator]::FromHtml($h)
  [System.Drawing.Color]::FromArgb($a, $c.R, $c.G, $c.B)
}

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap ($w * $S), ($h * $S), ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  return @($bmp, $g)
}

function Draw-Centered($g, [string]$text, $font, $brush, [float]$width, [float]$y) {
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $g.DrawString($text, $font, $brush, (New-Object System.Drawing.RectangleF 0, $y, $width, 400), $fmt)
}

function Save-Bmp($bmp, [int]$w, [int]$h, [string]$path) {
  $out = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($bmp, 0, 0, $w, $h)
  $g.Dispose()
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $out.Dispose()
  Write-Host "Wrote $path"
}

# --- Sidebar 164x314: the app's dark surface, a soft violet glow behind the mark -------------
$W = 164; $H = 314
$bmp, $g = New-Canvas $W $H
$g.Clear((Hex '#0b0b0e'))

$glow = New-Object System.Drawing.Drawing2D.GraphicsPath
$glow.AddEllipse((-40 * $S), (-10 * $S), (244 * $S), (200 * $S))
$pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow
$pgb.CenterColor = (Hex '#8b5cf6' 56)
$pgb.SurroundColors = @((Hex '#0b0b0e' 0))
$g.FillPath($pgb, $glow)

$m = 64
$g.DrawImage($logo, (($W - $m) / 2 * $S), (50 * $S), ($m * $S), ($m * $S))

$white = New-Object System.Drawing.SolidBrush (Hex '#ececf1')
$muted = New-Object System.Drawing.SolidBrush (Hex '#8d8d99')
$fTitle = New-Object System.Drawing.Font 'Segoe UI Semibold', (15 * $S), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fTag   = New-Object System.Drawing.Font 'Segoe UI', (9.5 * $S), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fPill  = New-Object System.Drawing.Font 'Segoe UI Semibold', (8.5 * $S), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fFoot  = New-Object System.Drawing.Font 'Segoe UI', (8.5 * $S), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)

Draw-Centered $g 'Capturely' $fTitle $white ($W * $S) (128 * $S)
Draw-Centered $g 'Record. Click. Zoom.' $fTag $muted ($W * $S) (152 * $S)

# A flat pill (no outline) with the red recording dot.
$pillText = 'SCREEN RECORDER'
$sz = $g.MeasureString($pillText, $fPill)
$dot = 6 * $S
$pw = $sz.Width + $dot + 20 * $S; $ph = 20 * $S
$px = ($W * $S - $pw) / 2; $py = 182 * $S
$pill = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = $ph
$pill.AddArc($px, $py, $r, $r, 90, 180)
$pill.AddArc(($px + $pw - $r), $py, $r, $r, 270, 180)
$pill.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush (Hex '#1d1d23')), $pill)
$g.FillEllipse((New-Object System.Drawing.SolidBrush (Hex '#f43f5e')), ($px + 9 * $S), ($py + ($ph - $dot) / 2), $dot, $dot)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
$g.DrawString($pillText, $fPill, (New-Object System.Drawing.SolidBrush (Hex '#c9c9d1')), (New-Object System.Drawing.RectangleF ($px + $dot + 6 * $S), $py, ($pw - $dot - 10 * $S), $ph), $fmt)

$g.FillRectangle((New-Object System.Drawing.SolidBrush (Hex '#23232a')), (28 * $S), (270 * $S), (($W - 56) * $S), $S)
Draw-Centered $g 'by SyntaxilitY' $fFoot $muted ($W * $S) (280 * $S)

$g.Dispose()
Save-Bmp $bmp $W $H (Join-Path $icons 'nsis-sidebar.bmp')
$bmp.Dispose()

# --- Header 150x57: on the white page header strip, left aligned ------------------------------
$W = 150; $H = 57
$bmp, $g = New-Canvas $W $H
$g.Clear([System.Drawing.Color]::White)
$m = 34
$g.DrawImage($logo, (8 * $S), ((($H - $m) / 2) * $S), ($m * $S), ($m * $S))
$ink   = New-Object System.Drawing.SolidBrush (Hex '#18181b')
$sub   = New-Object System.Drawing.SolidBrush (Hex '#6b6b78')
$fName = New-Object System.Drawing.Font 'Segoe UI Semibold', (13 * $S), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fBy   = New-Object System.Drawing.Font 'Segoe UI', (8.5 * $S), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('Capturely', $fName, $ink, (48 * $S), (12 * $S))
$g.DrawString('by SyntaxilitY', $fBy, $sub, (49 * $S), (30 * $S))
$g.Dispose()
Save-Bmp $bmp $W $H (Join-Path $icons 'nsis-header.bmp')
$bmp.Dispose()

$logo.Dispose()
