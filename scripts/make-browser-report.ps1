param(
  [string]$SourceHtml = ".\mobile-index.html",
  [string]$OutputHtml = ".\browser-index.html",
  [string]$SiteDir = ".\web-report-site"
)

$ErrorActionPreference = "Stop"
$source = Resolve-Path -LiteralPath $SourceHtml
$outputFullPath = [System.IO.Path]::GetFullPath($OutputHtml)
$html = Get-Content -Raw -LiteralPath $source

$old = @"
function openExternalLinkPanel(button) {
  lastExternalButton = button;
  externalLinkTitle.textContent = button.textContent.trim() || "Lien externe";
  externalLinkUrl.value = button.dataset.externalUrl || "";
  externalLinkStatus.textContent = "";
  externalLinkViewer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  externalLinkUrl.focus();
  externalLinkUrl.select();
}
"@

$new = @"
function openExternalLinkPanel(button) {
  const url = button.dataset.externalUrl || "";
  if (!url) {
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) {
    opened.opener = null;
  }
}
"@

if (-not $html.Contains($old)) {
  throw "Bloc openExternalLinkPanel introuvable dans $SourceHtml"
}

$html = $html.Replace($old, $new)
$html = $html.Replace("<title>Veille immobiliere", "<title>Veille immobiliere web")
$html = $html.Replace('<div class="note">Extraction automatique detaillee:', '<div class="note">Version navigateur: les annonces s ouvrent dans un onglet separe. Extraction automatique detaillee:')

$pwaHead = @"
  <meta name="theme-color" content="#0b5c86">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="application-name" content="Veille Immo">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="icons/icon.svg" type="image/svg+xml">
"@

if (-not $html.Contains('rel="manifest"')) {
  $html = $html.Replace("</head>", "$pwaHead`n</head>")
}

if (-not $html.Contains('src="pwa.js"')) {
  $html = $html.Replace("</body>", "<script src=""pwa.js"" defer></script>`n</body>")
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($outputFullPath, $html, $utf8NoBom)
New-Item -ItemType Directory -Force -Path $SiteDir | Out-Null
$siteIndexPath = [System.IO.Path]::GetFullPath((Join-Path $SiteDir "index.html"))
if ($outputFullPath -ne $siteIndexPath) {
  Copy-Item -LiteralPath $OutputHtml -Destination $siteIndexPath -Force
}

$written = Get-Content -Raw -LiteralPath $OutputHtml
[pscustomobject]@{
  Output = (Resolve-Path -LiteralPath $OutputHtml).Path
  SiteIndex = (Resolve-Path -LiteralPath $siteIndexPath).Path
  Bytes = (Get-Item -LiteralPath $OutputHtml).Length
  WindowOpenCount = [regex]::Matches($written, 'window\.open').Count
  CopyPanelStillPresent = [regex]::Matches($written, 'navigator\.clipboard|Lien copié').Count
  AbsoluteRefs = [regex]::Matches($written, 'C:\\|Users\\lmpg|Users/lmpg|file://').Count
}
