param(
  [string]$SourceHtml = ".\mobile-index.html",
  [string]$OutputHtml = ".\browser-index.html",
  [string]$SiteDir = ".\web-report-site"
)

$ErrorActionPreference = "Stop"
$source = Resolve-Path -LiteralPath $SourceHtml
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

Set-Content -LiteralPath $OutputHtml -Value $html -Encoding UTF8
New-Item -ItemType Directory -Force -Path $SiteDir | Out-Null
Copy-Item -LiteralPath $OutputHtml -Destination (Join-Path $SiteDir "index.html") -Force

$written = Get-Content -Raw -LiteralPath $OutputHtml
[pscustomobject]@{
  Output = (Resolve-Path -LiteralPath $OutputHtml).Path
  SiteIndex = (Resolve-Path -LiteralPath (Join-Path $SiteDir "index.html")).Path
  Bytes = (Get-Item -LiteralPath $OutputHtml).Length
  WindowOpenCount = [regex]::Matches($written, 'window\.open').Count
  CopyPanelStillPresent = [regex]::Matches($written, 'navigator\.clipboard|Lien copié').Count
  AbsoluteRefs = [regex]::Matches($written, 'C:\\|Users\\lmpg|Users/lmpg|file://').Count
}
