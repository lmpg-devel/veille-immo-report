[CmdletBinding()]
param(
  [string]$ProjectRoot = (Join-Path $PSScriptRoot ".."),
  [string]$ConfigPath = "config/veille-immo.json",
  [string]$OutputDir = "reports",
  [int]$PagesPerLocation = 2,
  [int]$RequestDelayMs = 700,
  [string]$PreviousResultsPath,
  [int]$TerrainMaxPrice = 100000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command,
    [string[]]$Arguments = @()
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$config = if ([System.IO.Path]::IsPathRooted($ConfigPath)) {
  $ConfigPath
} else {
  Join-Path $root $ConfigPath
}
$output = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
  $OutputDir
} else {
  Join-Path $root $OutputDir
}

if (-not (Test-Path -LiteralPath $config)) {
  throw "Configuration file not found: $config"
}

$currentResults = Join-Path $root "results.json"
if (-not (Test-Path -LiteralPath $currentResults)) {
  throw "Current results baseline not found: $currentResults"
}

if ([string]::IsNullOrWhiteSpace($PreviousResultsPath)) {
  $tempRoot = if ($env:RUNNER_TEMP) {
    $env:RUNNER_TEMP
  } else {
    [System.IO.Path]::GetTempPath()
  }
  $PreviousResultsPath = Join-Path $tempRoot "veille-immo-previous-results.json"
}

Push-Location -LiteralPath $root
try {
  Copy-Item -LiteralPath $currentResults -Destination $PreviousResultsPath -Force

  & (Join-Path $root "scripts/run-veille-immo.ps1") `
    -ConfigPath $config `
    -OutputDir $output `
    -PagesPerLocation $PagesPerLocation `
    -RequestDelayMs $RequestDelayMs
  if (-not $?) {
    throw "Daily scraper failed"
  }

  & (Join-Path $root "scripts/make-browser-report.ps1") `
    -SourceHtml (Join-Path $output "index.html") `
    -OutputHtml (Join-Path $root "index.html")
  if (-not $?) {
    throw "Browser report generation failed"
  }

  $csv = Get-ChildItem -LiteralPath $output -Filter "veille-immo-*.csv" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $csv) {
    throw "No veille-immo CSV produced"
  }

  $baseResults = Join-Path $root "results-base.json"
  & (Join-Path $root "scripts/make-results-json.ps1") `
    -CsvPath $csv.FullName `
    -OutputPath $baseResults `
    -ReportUrl "https://lmpg-devel.github.io/veille-immo-report/" `
    -PropertyType "maison" `
    -MaxPrice 350000
  if (-not $?) {
    throw "Base JSON generation failed"
  }

  Invoke-NativeCommand "node" @(
    (Join-Path $root "scripts/advanced-source-extract.mjs"),
    "--config", $config,
    "--baseResults", $baseResults,
    "--outJson", $currentResults,
    "--sources", "immovlan,2ememain,zimmo-apify",
    "--maxPerLocation", "12",
    "--delayMs", "350"
  )

  Invoke-NativeCommand "node" @(
    (Join-Path $root "scripts/mark-new-listings.mjs"),
    "--current", $currentResults,
    "--previous", $PreviousResultsPath,
    "--out", $currentResults
  )

  $terrainOutput = Join-Path $output "terrains"
  $terrainResults = Join-Path $root "results-terrain.json"
  $terrainBaseResults = Join-Path $tempRoot "veille-immo-terrain-base-results.json"
  $terrainPreviousResults = Join-Path $tempRoot "veille-immo-previous-terrain-results.json"
  if (Test-Path -LiteralPath $terrainResults) {
    Copy-Item -LiteralPath $terrainResults -Destination $terrainPreviousResults -Force
  }
  else {
    $emptyTerrainPayload = [ordered]@{
      schemaVersion = 1
      generatedAt = (Get-Date).ToUniversalTime().ToString("o")
      propertyType = "terrain"
      maxPrice = $TerrainMaxPrice
      count = 0
      listings = @()
    } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($terrainPreviousResults, $emptyTerrainPayload, (New-Object System.Text.UTF8Encoding $false))
  }

  & (Join-Path $root "scripts/run-veille-immo.ps1") `
    -ConfigPath $config `
    -OutputDir $terrainOutput `
    -PagesPerLocation $PagesPerLocation `
    -RequestDelayMs $RequestDelayMs `
    -PropertyType "terrain" `
    -MaxPrice $TerrainMaxPrice `
    -SkipMobileIndex
  if (-not $?) {
    throw "Daily terrain scraper failed"
  }

  $terrainCsv = Get-ChildItem -LiteralPath $terrainOutput -Filter "veille-immo-*.csv" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $terrainCsv) {
    throw "No terrain CSV produced"
  }

  & (Join-Path $root "scripts/make-results-json.ps1") `
    -CsvPath $terrainCsv.FullName `
    -OutputPath $terrainBaseResults `
    -ReportUrl "https://lmpg-devel.github.io/veille-immo-report/" `
    -PropertyType "terrain" `
    -MaxPrice $TerrainMaxPrice
  if (-not $?) {
    throw "Terrain JSON generation failed"
  }

  Invoke-NativeCommand "node" @(
    (Join-Path $root "scripts/advanced-source-extract.mjs"),
    "--config", $config,
    "--baseResults", $terrainBaseResults,
    "--outJson", $terrainResults,
    "--propertyType", "terrain",
    "--maxPrice", [string]$TerrainMaxPrice,
    "--sources", "immovlan,2ememain,zimmo-apify",
    "--maxPerLocation", "12",
    "--delayMs", "350"
  )

  Invoke-NativeCommand "node" @(
    (Join-Path $root "scripts/mark-new-listings.mjs"),
    "--current", $terrainResults,
    "--previous", $terrainPreviousResults,
    "--out", $terrainResults
  )

  $payload = Get-Content -LiteralPath $currentResults -Raw | ConvertFrom-Json
  $terrainPayload = Get-Content -LiteralPath $terrainResults -Raw | ConvertFrom-Json
  [pscustomobject]@{
    Csv = $csv.FullName
    Results = $currentResults
    Count = @($payload.listings).Count
    TerrainCsv = $terrainCsv.FullName
    TerrainResults = $terrainResults
    TerrainCount = @($terrainPayload.listings).Count
    GeneratedAt = $payload.generatedAt
  }
} finally {
  Pop-Location
}
