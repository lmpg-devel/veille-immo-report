param(
  [string]$CsvPath = "reports/veille-immo-2026-06-18.csv",
  [string]$OutputPath = "publish/veille-immo-report/results.json",
  [string]$ReportUrl = "https://lmpg-devel.github.io/veille-immo-report/"
)

$ErrorActionPreference = "Stop"

function Resolve-WorkspacePath {
  param([string]$Path)
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return $Path
  }
  return Join-Path (Get-Location).Path $Path
}

function ConvertTo-NullableInt {
  param($Value)
  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  $digits = $text -replace "[^\d-]", ""
  if ([string]::IsNullOrWhiteSpace($digits)) { return $null }
  return [int]$digits
}

function ConvertTo-NullableDouble {
  param($Value)
  if ($null -eq $Value) { return $null }
  $text = ([string]$Value).Trim().Replace(",", ".")
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  $number = 0.0
  if ([double]::TryParse($text, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    return $number
  }
  return $null
}

$resolvedCsvPath = Resolve-WorkspacePath $CsvPath
$resolvedOutputPath = Resolve-WorkspacePath $OutputPath

if (-not (Test-Path -LiteralPath $resolvedCsvPath)) {
  throw "CSV introuvable: $resolvedCsvPath"
}

$rows = Import-Csv -LiteralPath $resolvedCsvPath
$listings = foreach ($row in $rows) {
  $photos = @()
  if (-not [string]::IsNullOrWhiteSpace($row.PhotoUrls)) {
    $photos = @($row.PhotoUrls -split "\s+\|\s+" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }

  [ordered]@{
    source = $row.Source
    id = if ([string]::IsNullOrWhiteSpace($row.Id)) { $row.Url } else { $row.Id }
    title = $row.Title
    price = ConvertTo-NullableInt $row.Price
    bedrooms = ConvertTo-NullableInt $row.Bedrooms
    surfaceM2 = ConvertTo-NullableInt $row.SurfaceM2
    locality = $row.Locality
    requestedLocation = $row.RequestedLocation
    postalCode = $row.PostalCode
    address = $row.Address
    latitude = ConvertTo-NullableDouble $row.Latitude
    longitude = ConvertTo-NullableDouble $row.Longitude
    geoPrecision = $row.GeoPrecision
    agentName = $row.AgentName
    agentPhone = $row.AgentPhone
    agentEmail = $row.AgentEmail
    agentWebsite = $row.AgentWebsite
    photoCount = ConvertTo-NullableInt $row.PhotoCount
    photoUrl = if ($photos.Count -gt 0) { $photos[0] } else { $null }
    url = $row.Url
  }
}

$payload = [ordered]@{
  schemaVersion = 1
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  reportUrl = $ReportUrl
  count = @($listings).Count
  listings = @($listings)
}

$outputDir = Split-Path -Parent $resolvedOutputPath
if (-not (Test-Path -LiteralPath $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir | Out-Null
}

$json = $payload | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($resolvedOutputPath, $json, $utf8NoBom)
Write-Host "JSON ecrit: $resolvedOutputPath ($(@($listings).Count) annonces)"
