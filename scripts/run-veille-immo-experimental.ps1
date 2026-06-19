param(
  [string]$ConfigPath = "config/veille-immo.json",
  [string]$OutputDir = "reports",
  [int]$PagesPerLocation = 2,
  [int]$RequestDelayMs = 300,
  [int]$AgencyWebsiteLimit = 20,
  [string[]]$AdditionalListingsCsv = @(),
  [switch]$NoMobileIndexCopy
)

$ErrorActionPreference = "Stop"
$script:SourceDiagnostics = New-Object System.Collections.Generic.List[object]

function Resolve-FromWorkspace {
  param([string]$Path)

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return $Path
  }

  return Join-Path (Get-Location) $Path
}

function ConvertTo-Slug {
  param([string]$Value)

  $normalized = $Value.ToLowerInvariant().Normalize([Text.NormalizationForm]::FormD)
  $withoutMarks = -join ($normalized.ToCharArray() | Where-Object {
      [Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne [Globalization.UnicodeCategory]::NonSpacingMark
    })
  return (($withoutMarks -replace '[^a-z0-9]+', '+').Trim('+'))
}

function ConvertFrom-PriceText {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $digits = ($Value -replace '[^\d]', '')
  if ([string]::IsNullOrWhiteSpace($digits)) {
    return $null
  }

  return [int]$digits
}

function Get-FirstRegexGroup {
  param(
    [string]$Text,
    [string]$Pattern
  )

  $match = [regex]::Match($Text, $Pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($match.Success -and $match.Groups.Count -gt 1) {
    return $match.Groups[1].Value.Trim()
  }

  return $null
}

function Get-JsonObjectAfterMarker {
  param(
    [string]$Text,
    [string]$Marker
  )

  $markerIndex = $Text.IndexOf($Marker)
  if ($markerIndex -lt 0) {
    return $null
  }

  $jsonStart = $Text.IndexOf("{", $markerIndex)
  if ($jsonStart -lt 0) {
    return $null
  }

  $depth = 0
  $inString = $false
  $escape = $false

  for ($i = $jsonStart; $i -lt $Text.Length; $i++) {
    $ch = $Text[$i]

    if ($inString) {
      if ($escape) {
        $escape = $false
      }
      elseif ($ch -eq "\") {
        $escape = $true
      }
      elseif ($ch -eq '"') {
        $inString = $false
      }
    }
    else {
      if ($ch -eq '"') {
        $inString = $true
      }
      elseif ($ch -eq "{") {
        $depth++
      }
      elseif ($ch -eq "}") {
        $depth--
        if ($depth -eq 0) {
          $json = $Text.Substring($jsonStart, $i - $jsonStart + 1)
          return $json | ConvertFrom-Json
        }
      }
    }
  }

  return $null
}

function Get-ObjectPropertyValue {
  param(
    [object]$Object,
    [string]$Name
  )

  if ($null -eq $Object) {
    return $null
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($property) {
    return $property.Value
  }

  return $null
}

function Join-NonEmpty {
  param([object[]]$Values)

  return (($Values | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) -join " ")
}

function Format-Phone {
  param([string]$Phone)

  if ([string]::IsNullOrWhiteSpace($Phone)) {
    return $null
  }

  return $Phone.Trim()
}

function Invoke-Page {
  param([string]$Url)

  $headers = @{
    "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    "Accept-Language" = "fr-BE,fr;q=0.9,nl-BE;q=0.8,nl;q=0.7,en;q=0.6"
  }

  return Invoke-WebRequest -Uri $Url -Headers $headers -UseBasicParsing -TimeoutSec 30
}

function Add-SourceDiagnostic {
  param(
    [string]$Source,
    [string]$Location,
    [string]$Status,
    [string]$Message,
    [string]$Url
  )

  $script:SourceDiagnostics.Add([pscustomobject]@{
      Source = $Source
      Location = $Location
      Status = $Status
      Message = $Message
      Url = $Url
    })
}

function Get-ShortHash {
  param([string]$Value)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hash = $sha.ComputeHash($bytes)
    return (($hash | ForEach-Object { $_.ToString("x2") }) -join "").Substring(0, 16)
  }
  finally {
    $sha.Dispose()
  }
}

function Resolve-AbsoluteUrl {
  param(
    [string]$BaseUrl,
    [string]$Url
  )

  if ([string]::IsNullOrWhiteSpace($Url)) {
    return $null
  }
  if ($Url -match '^(mailto:|tel:|javascript:|#)') {
    return $null
  }

  try {
    return ([uri]::new([uri]::new($BaseUrl), [System.Net.WebUtility]::HtmlDecode($Url))).AbsoluteUri
  }
  catch {
    return $null
  }
}

function Get-CanonicalUrlKey {
  param([string]$Url)

  if ([string]::IsNullOrWhiteSpace($Url)) {
    return ""
  }
  return (($Url -replace '#.*$', '') -replace '\?.*$', '').TrimEnd('/').ToLowerInvariant()
}

function Add-ListingIfNew {
  param(
    [System.Collections.Generic.List[object]]$Collection,
    [object]$Listing
  )

  if ($null -eq $Listing) {
    return
  }

  $urlKey = Get-CanonicalUrlKey -Url $Listing.Url
  $exists = $Collection | Where-Object {
    (Get-CanonicalUrlKey -Url $_.Url) -eq $urlKey -or ($_.Source -eq $Listing.Source -and $_.Id -eq $Listing.Id)
  } | Select-Object -First 1

  if (-not $exists) {
    $Collection.Add($Listing)
  }
}

function Get-ImmowebSearchUrl {
  param(
    [object]$Location,
    [int]$MaxPrice,
    [int]$Page
  )

  return "https://www.immoweb.be/fr/recherche/maison/a-vendre/$($Location.immowebSlug)/$($Location.postalCode)?countries=BE&maxPrice=$MaxPrice&orderBy=newest&page=$Page"
}

function ConvertTo-PathSlug {
  param([string]$Value)

  return ((ConvertTo-Slug -Value $Value) -replace '\+', '-')
}

function Get-SecondHandSearchUrl {
  param(
    [object]$Location,
    [int]$MaxPrice
  )

  $query = [uri]::EscapeDataString((ConvertTo-PathSlug -Value $Location.name))
  return "https://www.2ememain.be/l/immo/maisons-a-vendre/q/$query/?priceTo=$MaxPrice"
}

function Get-FacebookMarketplaceSearchUrl {
  param(
    [object]$Location,
    [int]$MaxPrice
  )

  $query = [uri]::EscapeDataString("maison a vendre $($Location.name) $MaxPrice")
  return "https://www.facebook.com/marketplace/search/?query=$query"
}

function Get-ExperimentalListingRejectionReason {
  param(
    [string]$Source,
    [string]$Title,
    [string]$Html,
    [int]$Price,
    [object]$Location,
    [string]$Url
  )

  if ($Source -ne "2ememain") {
    return $null
  }

  $titleAndHead = "$Title " + ($Html.Substring(0, [Math]::Min($Html.Length, 5000)))
  $identitySlug = ConvertTo-PathSlug -Value "$Title $Url"
  $locationNeedles = @()
  if ($Location) {
    $locationNeedles += $Location.name
    $locationNeedles += $Location.postalCode
    $locationNeedles += $Location.immowebSlug
    $locationNeedles += $Location.zimmoSlug
    $locationNeedles += $Location.immovlanSlug
  }
  $locationNeedles = @($locationNeedles | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { ConvertTo-PathSlug -Value ([string]$_) } | Where-Object { $_ } | Select-Object -Unique)

  if ($Price -lt 50000) {
    return "Prix $Price sous le seuil coherent pour une vente"
  }

  if ($titleAndHead -match '(?i)\b(appartement|apparemment|appartementen|apartment|flat|studio|garage|garages|parking|staanplaats|box|terrain|grond|kot|kamer|chambre)\b') {
    return "Annonce non maison probable"
  }

  if ($locationNeedles.Count -gt 0) {
    $matchesLocation = $false
    foreach ($needle in $locationNeedles) {
      if ($identitySlug.Contains($needle)) {
        $matchesLocation = $true
        break
      }
    }
    if (-not $matchesLocation) {
      return "Commune cible absente de la fiche"
    }
  }

  return $null
}

function Get-PortalLinks {
  param(
    [object]$Config,
    [object]$Location
  )

  $maxPrice = [int]$Config.maxPrice
  $zimmoSlug = $Location.zimmoSlug
  $immovlanSlug = $Location.immovlanSlug
  $encodedLocalAgencyQuery = [uri]::EscapeDataString("maison a vendre $($Location.name) $maxPrice agence immobiliere")
  $encodedPrivateQuery = [uri]::EscapeDataString("maison a vendre $($Location.name) $maxPrice particulier sans agence")

  return [pscustomobject]@{
    Location = $Location.name
    Immoweb = Get-ImmowebSearchUrl -Location $Location -MaxPrice $maxPrice -Page 1
    Zimmo = "https://www.zimmo.be/fr/$zimmoSlug-$($Location.postalCode)/a-vendre/maison/?priceIncludeUnknown=0&priceMax=$maxPrice"
    Immovlan = "https://immo.vlan.be/fr/immobilier/maison/a-vendre/$immovlanSlug?maxprice=$maxPrice"
    SecondHand = Get-SecondHandSearchUrl -Location $Location -MaxPrice $maxPrice
    FacebookMarketplace = Get-FacebookMarketplaceSearchUrl -Location $Location -MaxPrice $maxPrice
    PrivateSearch = "https://www.bing.com/search?q=$encodedPrivateQuery"
    LocalAgencies = "https://www.bing.com/search?q=$encodedLocalAgencyQuery"
  }
}

function Read-ImmowebListing {
  param(
    [string]$Url,
    [object]$Location,
    [int]$MaxPrice
  )

  try {
    if ($config.strictExactLocation -ne $false) {
      $expectedPath = "/a-vendre/$($Location.immowebSlug)/"
      if ($Url -notmatch [regex]::Escape($expectedPath)) {
        return $null
      }
    }

    $response = Invoke-Page -Url $Url
    $html = $response.Content
    $titleRaw = Get-FirstRegexGroup -Text $html -Pattern '<title>(.*?)</title>'
    $title = [System.Net.WebUtility]::HtmlDecode($titleRaw)
    $classified = Get-JsonObjectAfterMarker -Text $html -Marker "window.classified = "
    $customer = if ($classified -and $classified.customers) { @($classified.customers)[0] } else { $null }

    if ($config.excludeMonthlySupplement -ne $false -and $title -match '\+\s*\d[\d\s\.\u00A0\u202F]*\s*(?:EUR|€)\s*/\s*mois') {
      return $null
    }

    if ($config.excludeNotarialSales -ne $false) {
      $isPublicSale = $classified -and $classified.flags -and ($classified.flags.isPublicSale -or $classified.flags.isAnInteractiveSale)
      $isNotaryCustomer = $customer -and $customer.type -and $customer.type -match '(?i)NOTARY|NOTAIRE|NOTARIS'
      $isNotaryText = (($title, $customer.name, $customer.email) -join " ") -match '(?i)\bnotaire\b|\bnotaires\b|\bnotaris\b|\bnotarissen\b|\bnotary\b'

      if ($isPublicSale -or $isNotaryCustomer -or $isNotaryText) {
        return $null
      }
    }

    $priceJson = if ($classified -and $classified.price) { $classified.price.mainValue } else { $null }
    if (-not $priceJson) {
      $priceJson = Get-FirstRegexGroup -Text $html -Pattern '"price"\s*:\s*\{[^}]*"mainValue"\s*:\s*(\d+)'
    }
    $priceFromTitle = Get-FirstRegexGroup -Text $title -Pattern '(\d[\d\s\.\u00A0\u202F]*)(?:\s*)(?:EUR|€)'
    $price = if ($priceJson) { [int]$priceJson } else { ConvertFrom-PriceText -Value $priceFromTitle }

    if ($null -eq $price -or $price -gt $MaxPrice) {
      return $null
    }

    $property = if ($classified) { $classified.property } else { $null }
    $propertyLocation = if ($property) { $property.location } else { $null }

    $bedrooms = if ($property -and $property.bedroomCount) { $property.bedroomCount } else { Get-FirstRegexGroup -Text $title -Pattern '-\s*(\d+)\s*chambre' }
    $surface = if ($property -and $property.netHabitableSurface) { $property.netHabitableSurface } else { Get-FirstRegexGroup -Text $title -Pattern '-\s*(\d+)\s*m.' }
    $locality = if ($propertyLocation -and $propertyLocation.locality) { $propertyLocation.locality } else { Get-FirstRegexGroup -Text $title -Pattern 'Maison\s+[àa]\s+vendre\s+[àa]\s+(.+?)\s+-' }
    if (-not $locality) {
      $locality = $Location.name
    }

    $street = if ($propertyLocation) { $propertyLocation.street } else { $null }
    $number = if ($propertyLocation) { $propertyLocation.number } else { $null }
    $postalCode = if ($propertyLocation) { $propertyLocation.postalCode } else { $Location.postalCode }
    $address = Join-NonEmpty @($street, $number, $postalCode, $locality)

    $latitude = if ($propertyLocation -and $propertyLocation.latitude) { [double]$propertyLocation.latitude } else { [double]$Location.latitude }
    $longitude = if ($propertyLocation -and $propertyLocation.longitude) { [double]$propertyLocation.longitude } else { [double]$Location.longitude }
    $geoPrecision = if ($propertyLocation -and $propertyLocation.latitude -and $propertyLocation.longitude -and $street) { "adresse publiee" } elseif ($propertyLocation -and $propertyLocation.latitude -and $propertyLocation.longitude) { "coordonnees publiees" } else { "centre commune" }

    $pictures = @()
    if ($classified -and $classified.media -and $classified.media.pictures) {
      $pictures = @($classified.media.pictures | ForEach-Object {
          if ($_.largeUrl) { $_.largeUrl }
          elseif ($_.mediumUrl) { $_.mediumUrl }
          elseif ($_.smallUrl) { $_.smallUrl }
        } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
    }

    if ($pictures.Count -eq 0) {
      $ogImage = Get-FirstRegexGroup -Text $html -Pattern '<meta\s+property="og:image"\s+content="([^"]+)"'
      if ($ogImage) {
        $pictures = @([System.Net.WebUtility]::HtmlDecode($ogImage))
      }
    }

    $agentName = if ($customer) { $customer.name } else { $null }
    $agentPhone = if ($customer) { Format-Phone $customer.phoneNumber } else { $null }
    $agentMobile = if ($customer) { Format-Phone $customer.mobileNumber } else { $null }
    $agentEmail = if ($customer) { $customer.email } else { $null }
    $agentWebsite = if ($customer) { $customer.website } else { $null }
    $id = Get-FirstRegexGroup -Text $Url -Pattern '/(\d{6,})(?:\?.*)?$'

    return [pscustomobject]@{
      Source = "Immoweb"
      Id = $id
      RequestedLocation = $Location.name
      Locality = $locality
      PostalCode = $postalCode
      Address = $address
      Latitude = $latitude
      Longitude = $longitude
      GeoPrecision = $geoPrecision
      Price = $price
      Bedrooms = $bedrooms
      SurfaceM2 = $surface
      AgentName = $agentName
      AgentPhone = $agentPhone
      AgentMobile = $agentMobile
      AgentEmail = $agentEmail
      AgentWebsite = $agentWebsite
      PhotoCount = $pictures.Count
      PhotoUrls = ($pictures -join " | ")
      Title = $title
      Url = $Url
    }
  }
  catch {
    Write-Warning "Impossible de lire l'annonce Immoweb $Url : $($_.Exception.Message)"
    return $null
  }
}

function Get-ImmowebListings {
  param(
    [object]$Config,
    [object]$Location,
    [int]$PagesPerLocation,
    [int]$RequestDelayMs
  )

  $urls = New-Object System.Collections.Generic.List[string]

  for ($page = 1; $page -le $PagesPerLocation; $page++) {
    $searchUrl = Get-ImmowebSearchUrl -Location $Location -MaxPrice ([int]$Config.maxPrice) -Page $page
    try {
      $response = Invoke-Page -Url $searchUrl
      $matches = [regex]::Matches($response.Content, 'https://www\.immoweb\.be/fr/annonce/maison/a-vendre/[^"<> ]+')
      foreach ($match in $matches) {
        $cleanUrl = [System.Net.WebUtility]::HtmlDecode($match.Value)
        if (-not $urls.Contains($cleanUrl)) {
          $urls.Add($cleanUrl)
        }
      }
    }
    catch {
      Write-Warning "Impossible de lire la recherche Immoweb $searchUrl : $($_.Exception.Message)"
    }

    Start-Sleep -Milliseconds $RequestDelayMs
  }

  $results = New-Object System.Collections.Generic.List[object]
  foreach ($url in $urls) {
    $listing = Read-ImmowebListing -Url $url -Location $Location -MaxPrice ([int]$Config.maxPrice)
    if ($listing) {
      $results.Add($listing)
    }

    Start-Sleep -Milliseconds $RequestDelayMs
  }

  return $results
}

function Read-ExperimentalListingPage {
  param(
    [string]$Url,
    [string]$Source,
    [object]$Location,
    [int]$MaxPrice,
    [object]$Agency
  )

  try {
    $response = Invoke-Page -Url $Url
    $html = $response.Content
    $titleRaw = Get-FirstRegexGroup -Text $html -Pattern '<title>(.*?)</title>'
    if (-not $titleRaw) {
      $titleRaw = Get-FirstRegexGroup -Text $html -Pattern '<meta\s+(?:property|name)=["'']og:title["'']\s+content=["'']([^"'']+)["'']'
    }
    $title = [System.Net.WebUtility]::HtmlDecode($titleRaw)
    if ([string]::IsNullOrWhiteSpace($title)) {
      $title = "$Source - annonce candidate"
    }

    if ($config.excludeNotarialSales -ne $false) {
      $notarialText = "$title $Url $html"
      if ($notarialText -match '(?i)\bbiddit\b|\bnotaire\b|\bnotaires\b|\bnotaris\b|\bnotarissen\b|\bnotary\b') {
        Add-SourceDiagnostic -Source $Source -Location $(if ($Location) { $Location.name } elseif ($Agency) { $Agency.Name } else { "Experimental" }) -Status "Candidat ignore" -Message "Vente notariale ou Biddit exclue" -Url $Url
        return $null
      }
    }

    $priceText = Get-FirstRegexGroup -Text $html -Pattern '(\d[\d\s\.\u00A0\u202F]{3,})\s*(?:EUR|€)'
    if (-not $priceText) {
      $priceText = Get-FirstRegexGroup -Text $title -Pattern '(\d[\d\s\.\u00A0\u202F]{3,})\s*(?:EUR|€)'
    }
    $price = ConvertFrom-PriceText -Value $priceText
    if ($null -eq $price -or $price -gt $MaxPrice) {
      Add-SourceDiagnostic -Source $Source -Location $(if ($Location) { $Location.name } elseif ($Agency) { $Agency.Name } else { "Experimental" }) -Status "Candidat ignore" -Message "Prix absent ou superieur au plafond" -Url $Url
      return $null
    }

    $rejectionReason = Get-ExperimentalListingRejectionReason -Source $Source -Title $title -Html $html -Price $price -Location $Location -Url $Url
    if ($rejectionReason) {
      Add-SourceDiagnostic -Source $Source -Location $(if ($Location) { $Location.name } elseif ($Agency) { $Agency.Name } else { "Experimental" }) -Status "Candidat ignore" -Message $rejectionReason -Url $Url
      return $null
    }

    $locality = $null
    if ($Location) {
      $locality = $Location.name
    }
    elseif ($config -and $config.locations) {
      $contentSample = "$title $Url"
      foreach ($configuredLocation in $config.locations) {
        if ($contentSample -match [regex]::Escape($configuredLocation.name) -or $contentSample -match [regex]::Escape($configuredLocation.immowebSlug)) {
          $locality = $configuredLocation.name
          $Location = $configuredLocation
          break
        }
      }
    }

    if (-not $locality) {
      $locality = "Commune a verifier"
    }

    $bedrooms = Get-FirstRegexGroup -Text "$title $html" -Pattern '(\d+)\s*(?:chambres?|slaapkamers?|bedrooms?)'
    $surface = Get-FirstRegexGroup -Text "$title $html" -Pattern '(\d{2,4})\s*m(?:²|2|&sup2;)'
    $ogImage = Get-FirstRegexGroup -Text $html -Pattern '<meta\s+(?:property|name)=["'']og:image["'']\s+content=["'']([^"'']+)["'']'
    $pictures = @()
    if ($ogImage) {
      $pictures = @([System.Net.WebUtility]::HtmlDecode($ogImage))
    }

    $lat = if ($Location -and $Location.latitude) { [double]$Location.latitude } else { $null }
    $lon = if ($Location -and $Location.longitude) { [double]$Location.longitude } else { $null }
    $geoPrecision = if ($Location) { "centre commune - experimental" } else { "adresse a verifier - experimental" }

    $agentName = if ($Agency -and $Agency.Name) { $Agency.Name } else { $null }
    $agentPhone = if ($Agency -and $Agency.Phone) { $Agency.Phone } else { $null }
    $agentEmail = if ($Agency -and $Agency.Email) { $Agency.Email } else { $null }
    $agentWebsite = if ($Agency -and $Agency.Website) { $Agency.Website } else { $null }

    return [pscustomobject]@{
      Source = $Source
      Id = Get-ShortHash -Value "$Source|$Url"
      RequestedLocation = if ($Location) { $Location.name } else { "Agences locales" }
      Locality = $locality
      PostalCode = if ($Location) { $Location.postalCode } else { $null }
      Address = ""
      Latitude = $lat
      Longitude = $lon
      GeoPrecision = $geoPrecision
      Price = $price
      Bedrooms = $bedrooms
      SurfaceM2 = $surface
      AgentName = $agentName
      AgentPhone = $agentPhone
      AgentMobile = $null
      AgentEmail = $agentEmail
      AgentWebsite = $agentWebsite
      PhotoCount = $pictures.Count
      PhotoUrls = ($pictures -join " | ")
      Title = $title
      Url = $Url
    }
  }
  catch {
    Add-SourceDiagnostic -Source $Source -Location $(if ($Location) { $Location.name } else { "Agences locales" }) -Status "Erreur detail" -Message $_.Exception.Message -Url $Url
    return $null
  }
}

function Get-ZimmoListings {
  param(
    [object]$Config,
    [object]$Location,
    [int]$RequestDelayMs
  )

  $maxPrice = [int]$Config.maxPrice
  $searchUrl = "https://www.zimmo.be/fr/$($Location.zimmoSlug)-$($Location.postalCode)/a-vendre/maison/?priceIncludeUnknown=0&priceMax=$maxPrice"
  $results = New-Object System.Collections.Generic.List[object]

  try {
    $response = Invoke-Page -Url $searchUrl
    $urlMatches = [regex]::Matches($response.Content, '(?:https://www\.zimmo\.be)?/fr/[^"'']*?/a-vendre/maison/[^"'']+', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $urls = @($urlMatches | ForEach-Object {
        Resolve-AbsoluteUrl -BaseUrl "https://www.zimmo.be" -Url $_.Value
      } | Where-Object { $_ -and $_ -notmatch '\?' } | Select-Object -Unique | Select-Object -First 20)

    Add-SourceDiagnostic -Source "Zimmo" -Location $Location.name -Status "Recherche OK" -Message "$($urls.Count) URL(s) candidate(s)" -Url $searchUrl

    foreach ($url in $urls) {
      $listing = Read-ExperimentalListingPage -Url $url -Source "Zimmo" -Location $Location -MaxPrice $maxPrice
      if ($listing) {
        $results.Add($listing)
      }
      Start-Sleep -Milliseconds $RequestDelayMs
    }
  }
  catch {
    Add-SourceDiagnostic -Source "Zimmo" -Location $Location.name -Status "Bloque ou indisponible" -Message $_.Exception.Message -Url $searchUrl
  }

  return $results
}

function Get-ImmovlanListings {
  param(
    [object]$Config,
    [object]$Location,
    [int]$RequestDelayMs
  )

  $maxPrice = [int]$Config.maxPrice
  $searchUrl = "https://immo.vlan.be/fr/immobilier/maison/a-vendre/$($Location.immovlanSlug)?maxprice=$maxPrice"
  $results = New-Object System.Collections.Generic.List[object]

  try {
    $response = Invoke-Page -Url $searchUrl
    $urlMatches = [regex]::Matches($response.Content, '(?:https://immo\.vlan\.be)?/fr/(?:detail|immobilier)/maison/a-vendre/[^"'']+', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $urls = @($urlMatches | ForEach-Object {
        Resolve-AbsoluteUrl -BaseUrl "https://immo.vlan.be" -Url $_.Value
      } | Where-Object { $_ -and $_ -ne $searchUrl } | Select-Object -Unique | Select-Object -First 20)

    Add-SourceDiagnostic -Source "Immovlan" -Location $Location.name -Status "Recherche OK" -Message "$($urls.Count) URL(s) candidate(s)" -Url $searchUrl

    foreach ($url in $urls) {
      $listing = Read-ExperimentalListingPage -Url $url -Source "Immovlan" -Location $Location -MaxPrice $maxPrice
      if ($listing) {
        $results.Add($listing)
      }
      Start-Sleep -Milliseconds $RequestDelayMs
    }
  }
  catch {
    Add-SourceDiagnostic -Source "Immovlan" -Location $Location.name -Status "Bloque ou indisponible" -Message $_.Exception.Message -Url $searchUrl
  }

  return $results
}

function Get-SecondHandListings {
  param(
    [object]$Config,
    [object]$Location,
    [int]$RequestDelayMs
  )

  $maxPrice = [int]$Config.maxPrice
  $searchUrl = Get-SecondHandSearchUrl -Location $Location -MaxPrice $maxPrice
  $results = New-Object System.Collections.Generic.List[object]

  try {
    $response = Invoke-Page -Url $searchUrl
    $urlMatches = [regex]::Matches($response.Content, '(?:https://www\.2ememain\.be)?/v/immo/maisons-a-vendre/m\d+[^"'']*', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $urls = @($urlMatches | ForEach-Object {
        Resolve-AbsoluteUrl -BaseUrl "https://www.2ememain.be" -Url $_.Value
      } | Where-Object { $_ } | Select-Object -Unique | Select-Object -First 20)

    Add-SourceDiagnostic -Source "2ememain" -Location $Location.name -Status "Recherche OK" -Message "$($urls.Count) URL(s) candidate(s) particulier/portail" -Url $searchUrl

    foreach ($url in $urls) {
      $listing = Read-ExperimentalListingPage -Url $url -Source "2ememain" -Location $Location -MaxPrice $maxPrice
      if ($listing) {
        $results.Add($listing)
      }
      Start-Sleep -Milliseconds $RequestDelayMs
    }
  }
  catch {
    Add-SourceDiagnostic -Source "2ememain" -Location $Location.name -Status "Bloque ou indisponible" -Message $_.Exception.Message -Url $searchUrl
  }

  return $results
}

function Get-AgencyWebsiteListings {
  param(
    [object]$Config,
    [object[]]$LocalAgencies,
    [int]$RequestDelayMs,
    [int]$MaxAgencies
  )

  $results = New-Object System.Collections.Generic.List[object]
  $agencies = @($LocalAgencies | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Website) } | Select-Object -First $MaxAgencies)
  $candidatePattern = '(a-vendre|vente|acheter|te-koop|koop|for-sale|maison|huis|woning|pand|bien|property|immobilier|immo)'

  foreach ($agency in $agencies) {
    $website = [string]$agency.Website
    if ($website -notmatch '^https?://') {
      $website = "https://$website"
    }

    try {
      $response = Invoke-Page -Url $website
      $hrefMatches = [regex]::Matches($response.Content, 'href=["'']([^"'']+)["'']', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
      $candidateUrls = @($hrefMatches | ForEach-Object {
          Resolve-AbsoluteUrl -BaseUrl $website -Url $_.Groups[1].Value
        } | Where-Object {
          $_ -and $_ -match $candidatePattern -and $_ -notmatch '\.(css|js|png|jpe?g|gif|webp|svg|pdf)(\?|$)'
        } | Select-Object -Unique | Select-Object -First 5)

      Add-SourceDiagnostic -Source "Agence locale" -Location $agency.Name -Status "Site lu" -Message "$($candidateUrls.Count) URL(s) candidate(s)" -Url $website

      foreach ($url in $candidateUrls) {
        $listing = Read-ExperimentalListingPage -Url $url -Source "Agence locale" -MaxPrice ([int]$Config.maxPrice) -Agency $agency
        if ($listing) {
          $results.Add($listing)
        }
        Start-Sleep -Milliseconds $RequestDelayMs
      }
    }
    catch {
      Add-SourceDiagnostic -Source "Agence locale" -Location $agency.Name -Status "Site bloque ou illisible" -Message $_.Exception.Message -Url $website
    }

    Start-Sleep -Milliseconds $RequestDelayMs
  }

  return $results
}

function Get-OpenStreetMapAgencies {
  param([object]$Config)

  if ($Config.includeOpenStreetMapAgencies -eq $false -or -not $Config.agencySearchBbox) {
    return @()
  }

  $bbox = $Config.agencySearchBbox
  $query = @"
[out:json][timeout:25];
(
  node["office"="estate_agent"]($($bbox.south),$($bbox.west),$($bbox.north),$($bbox.east));
  way["office"="estate_agent"]($($bbox.south),$($bbox.west),$($bbox.north),$($bbox.east));
  relation["office"="estate_agent"]($($bbox.south),$($bbox.west),$($bbox.north),$($bbox.east));
  node["shop"="estate_agent"]($($bbox.south),$($bbox.west),$($bbox.north),$($bbox.east));
  way["shop"="estate_agent"]($($bbox.south),$($bbox.west),$($bbox.north),$($bbox.east));
  relation["shop"="estate_agent"]($($bbox.south),$($bbox.west),$($bbox.north),$($bbox.east));
);
out tags center 250;
"@

  $body = "data=" + [uri]::EscapeDataString($query)
  $endpoints = @(
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  )
  $lastError = $null

  foreach ($endpoint in $endpoints) {
    try {
      $response = Invoke-WebRequest `
        -Uri $endpoint `
        -Method Post `
        -Headers @{ Accept = "application/json"; "User-Agent" = "Codex real-estate watch" } `
        -ContentType "application/x-www-form-urlencoded; charset=UTF-8" `
        -Body $body `
        -UseBasicParsing `
        -TimeoutSec 60

      $json = $response.Content | ConvertFrom-Json
      $agencies = New-Object System.Collections.Generic.List[object]

      foreach ($element in @($json.elements)) {
        $tags = $element.tags
        $name = Get-ObjectPropertyValue -Object $tags -Name "name"
        if ([string]::IsNullOrWhiteSpace($name)) {
          continue
        }

        $lat = if ($element.lat) { $element.lat } elseif ($element.center) { $element.center.lat } else { $null }
        $lon = if ($element.lon) { $element.lon } elseif ($element.center) { $element.center.lon } else { $null }
        if (-not $lat -or -not $lon) {
          continue
        }

        $phone = Get-ObjectPropertyValue -Object $tags -Name "phone"
        if (-not $phone) {
          $phone = Get-ObjectPropertyValue -Object $tags -Name "contact:phone"
        }

        $website = Get-ObjectPropertyValue -Object $tags -Name "website"
        if (-not $website) {
          $website = Get-ObjectPropertyValue -Object $tags -Name "contact:website"
        }

        $email = Get-ObjectPropertyValue -Object $tags -Name "email"
        if (-not $email) {
          $email = Get-ObjectPropertyValue -Object $tags -Name "contact:email"
        }

        $street = Get-ObjectPropertyValue -Object $tags -Name "addr:street"
        $houseNumber = Get-ObjectPropertyValue -Object $tags -Name "addr:housenumber"
        $postcode = Get-ObjectPropertyValue -Object $tags -Name "addr:postcode"
        $city = Get-ObjectPropertyValue -Object $tags -Name "addr:city"
        $address = Join-NonEmpty @($street, $houseNumber, $postcode, $city)

        $dedupeKey = "$name|$lat|$lon"
        if ($agencies | Where-Object { $_.DedupeKey -eq $dedupeKey }) {
          continue
        }

        $agencies.Add([pscustomobject]@{
            DedupeKey = $dedupeKey
            Source = "OpenStreetMap"
            Name = $name
            Address = $address
            Latitude = [double]$lat
            Longitude = [double]$lon
            Phone = Format-Phone $phone
            Email = $email
            Website = $website
            OsmUrl = "https://www.openstreetmap.org/$($element.type)/$($element.id)"
          })
      }

      return @($agencies.ToArray() | Sort-Object Name)
    }
    catch {
      $lastError = $_.Exception.Message
      Write-Warning "Endpoint OpenStreetMap indisponible ($endpoint) : $lastError"
    }
  }

  Write-Warning "Impossible de recuperer les agences locales OpenStreetMap : $lastError"
  return @()
}

function Convert-ExternalLinksToLocalActions {
  param([string]$Html)

  $pattern = '<a\b([^>]*?)\bhref=(["''])(https?://[^"'']+)\2([^>]*)>([\s\S]*?)</a>'
  return [regex]::Replace($Html, $pattern, {
      param($match)

      $url = [System.Net.WebUtility]::HtmlDecode($match.Groups[3].Value)
      $label = $match.Groups[5].Value
      $safeUrl = [System.Net.WebUtility]::HtmlEncode($url)
      return "<button type=""button"" class=""external-link-button"" data-external-url=""$safeUrl"">$label</button>"
    })
}

function ConvertTo-CoordinateDouble {
  param([object]$Value)

  if ($null -eq $Value) {
    return $null
  }
  if ($Value -is [double] -or $Value -is [float] -or $Value -is [decimal]) {
    return [double]$Value
  }

  $text = ([string]$Value).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }

  $normalized = ($text -replace '\s', '')
  if ($normalized -match '^-?\d+,\d+$') {
    $normalized = $normalized -replace ',', '.'
  }

  return [double]::Parse($normalized, [System.Globalization.CultureInfo]::InvariantCulture)
}

function New-HtmlReport {
  param(
    [object]$Config,
    [object[]]$Listings,
    [object[]]$PortalLinks,
    [object[]]$LocalAgencies,
    [object[]]$SourceDiagnostics,
    [datetime]$RunAt
  )

  $style = @"
body { font-family: Segoe UI, Arial, sans-serif; margin: 0; color: #182026; background: #f6f7f8; }
main { max-width: 1440px; margin: 0 auto; padding: 28px; }
h1 { margin: 0 0 6px; font-size: 28px; }
h2 { margin: 34px 0 12px; font-size: 20px; }
.meta { color: #5c6670; margin-bottom: 20px; }
.note { background: #fff8df; border: 1px solid #eed074; padding: 12px 14px; border-radius: 6px; margin: 16px 0 22px; }
#map { height: 430px; border: 1px solid #d8dee3; border-radius: 6px; background: #e8ecef; margin-bottom: 24px; }
.map-fallback { display: flex; align-items: center; justify-content: center; height: 100%; color: #4d5963; padding: 16px; text-align: center; }
.map-tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: -4px 0 10px; color: #4d5963; }
.map-toggle { display: inline-flex; align-items: center; gap: 8px; background: #fff; border: 1px solid #d8dee3; border-radius: 5px; padding: 8px 10px; }
.map-legend { display: inline-flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.legend-dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
.legend-listing { background: #0b5c86; }
.legend-agency { background: #fff; border: 1px solid #5f6b73; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
.listing-card { background: #fff; border: 1px solid #dde2e5; border-radius: 6px; overflow: hidden; }
.listing-body { padding: 14px; }
.listing-title { font-size: 16px; font-weight: 650; line-height: 1.35; margin-bottom: 9px; }
.source-badge { display: inline-block; margin: 0 6px 4px 0; padding: 3px 7px; border-radius: 999px; background: #eef2f4; color: #34424d; font-size: 12px; font-weight: 700; vertical-align: 1px; }
.source-immoweb { background: #e7f2f7; color: #0b5c86; }
.source-zimmo { background: #e9f6ed; color: #12633b; }
.source-immovlan { background: #fff2df; color: #875000; }
.source-agence-locale { background: #f2ebfa; color: #5a2b7a; }
.price { white-space: nowrap; font-weight: 700; color: #0b513c; }
.facts { display: flex; flex-wrap: wrap; gap: 8px 14px; color: #3d4852; margin: 8px 0 10px; }
.fact-label { color: #6a737d; }
.contact { background: #f3f6f7; border-radius: 6px; padding: 10px; margin-top: 10px; line-height: 1.45; }
.photo-strip { display: flex; gap: 8px; overflow-x: auto; overscroll-behavior-x: contain; padding: 10px; background: #111820; scroll-snap-type: x proximity; }
.photo-button { border: 0; padding: 0; background: transparent; cursor: zoom-in; scroll-snap-align: start; flex: 0 0 auto; }
.photo-button:focus-visible { outline: 3px solid #fff; outline-offset: 2px; border-radius: 5px; }
.photo-strip img { height: 168px; width: 224px; object-fit: cover; border-radius: 5px; display: block; background: #26313a; }
.photo-empty { color: #cfd8df; padding: 18px; min-height: 60px; }
.photo-viewer { position: fixed; inset: 0; z-index: 9999; background: rgba(12, 17, 22, 0.92); display: none; align-items: center; justify-content: center; padding: 24px; }
.photo-viewer[aria-hidden="false"] { display: flex; }
.photo-viewer-panel { max-width: min(1120px, 96vw); max-height: 92vh; display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.photo-viewer-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #fff; }
.photo-viewer-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.photo-viewer-close { border: 1px solid #c8d1d8; background: #fff; color: #121820; border-radius: 5px; padding: 9px 12px; cursor: pointer; font-weight: 650; }
.photo-viewer img { max-width: 96vw; max-height: calc(92vh - 56px); object-fit: contain; border-radius: 6px; background: #1f2932; }
.links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
.external-link-button { border: 0; background: transparent; color: #0b5c86; cursor: pointer; font: inherit; padding: 0; text-align: left; }
.external-link-button:hover, .external-link-button:focus-visible { text-decoration: underline; }
.external-link-viewer { position: fixed; inset: 0; z-index: 10000; background: rgba(12, 17, 22, 0.72); display: none; align-items: center; justify-content: center; padding: 20px; }
.external-link-viewer[aria-hidden="false"] { display: flex; }
.external-link-panel { width: min(620px, 96vw); background: #fff; border-radius: 7px; box-shadow: 0 18px 52px rgba(0, 0, 0, 0.28); padding: 18px; }
.external-link-title { font-weight: 700; margin-bottom: 10px; }
.external-link-url { width: 100%; box-sizing: border-box; min-height: 92px; resize: vertical; border: 1px solid #c9d2d8; border-radius: 5px; padding: 10px; color: #182026; font: 14px/1.35 Consolas, "Courier New", monospace; }
.external-link-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
.external-link-copy, .external-link-close { border: 1px solid #c8d1d8; border-radius: 5px; padding: 9px 12px; cursor: pointer; font-weight: 650; }
.external-link-copy { background: #0b5c86; border-color: #0b5c86; color: #fff; }
.external-link-close { background: #fff; color: #121820; }
.external-link-status { color: #5c6670; font-size: 13px; min-height: 18px; }
table { width: 100%; border-collapse: collapse; background: #fff; margin-top: 12px; }
th, td { border-bottom: 1px solid #e5e8ea; padding: 9px 10px; text-align: left; vertical-align: top; }
th { background: #eef2f4; font-weight: 600; }
a { color: #0b5c86; text-decoration: none; }
a:hover { text-decoration: underline; }
.empty { background: #fff; border: 1px solid #e5e8ea; padding: 16px; border-radius: 6px; }
.small { color: #687480; font-size: 13px; }
@media (max-width: 680px) {
  main { padding: 18px; }
  .cards { grid-template-columns: 1fr; }
  .photo-strip img { width: 190px; height: 142px; }
  .photo-viewer { padding: 14px; }
  .photo-viewer-toolbar { align-items: flex-start; flex-direction: column; }
  .external-link-viewer { align-items: flex-end; padding: 12px; }
  .external-link-panel { width: 100%; }
  #map { height: 360px; }
}
"@

  $listingCards = if ($Listings.Count -gt 0) {
    ($Listings | Sort-Object Price, RequestedLocation | ForEach-Object {
        $title = [System.Net.WebUtility]::HtmlEncode($_.Title)
        $source = if ($_.Source) { [System.Net.WebUtility]::HtmlEncode($_.Source) } else { "Source inconnue" }
        $sourceClass = "source-" + (([string]$_.Source).ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
        $locality = [System.Net.WebUtility]::HtmlEncode($_.Locality)
        $requested = [System.Net.WebUtility]::HtmlEncode($_.RequestedLocation)
        $price = "{0:N0} EUR" -f [int]$_.Price
        $beds = if ($_.Bedrooms) { [System.Net.WebUtility]::HtmlEncode($_.Bedrooms) } else { "" }
        $surface = if ($_.SurfaceM2) { "$([System.Net.WebUtility]::HtmlEncode($_.SurfaceM2)) m2" } else { "" }
        $address = if ($_.Address) { [System.Net.WebUtility]::HtmlEncode($_.Address) } else { "" }
        $geoPrecision = if ($_.GeoPrecision) { [System.Net.WebUtility]::HtmlEncode($_.GeoPrecision) } else { "" }
        $agent = if ($_.AgentName) { [System.Net.WebUtility]::HtmlEncode($_.AgentName) } else { "Contact non publie" }
        $phoneLinks = @()
        if ($_.AgentPhone) {
          $safePhone = [System.Net.WebUtility]::HtmlEncode($_.AgentPhone)
          $phoneLinks += "<a href='tel:$($_.AgentPhone)'>$safePhone</a>"
        }
        if ($_.AgentMobile -and $_.AgentMobile -ne $_.AgentPhone) {
          $safeMobile = [System.Net.WebUtility]::HtmlEncode($_.AgentMobile)
          $phoneLinks += "<a href='tel:$($_.AgentMobile)'>$safeMobile</a>"
        }
        if ($_.AgentEmail) {
          $safeEmail = [System.Net.WebUtility]::HtmlEncode($_.AgentEmail)
          $phoneLinks += "<a href='mailto:$($_.AgentEmail)'>$safeEmail</a>"
        }
        if ($_.AgentWebsite) {
          $safeWebsite = [System.Net.WebUtility]::HtmlEncode($_.AgentWebsite)
          $phoneLinks += "<a href='$($_.AgentWebsite)' target='_blank' rel='noopener noreferrer'>Site agence</a>"
        }
        $contact = if ($phoneLinks.Count -gt 0) { $phoneLinks -join " · " } else { "Numero non publie" }

        $photoUrls = if ($_.PhotoUrls) { @($_.PhotoUrls -split '\s+\|\s+') } else { @() }
        $photos = if ($photoUrls.Count -gt 0) {
          ($photoUrls | ForEach-Object {
              $photoUrl = [System.Net.WebUtility]::HtmlEncode($_)
              "<button type='button' class='photo-button' data-photo-src='$photoUrl' data-photo-title='$title' aria-label='Agrandir la photo'><img loading='lazy' src='$photoUrl' alt='Photo annonce'></button>"
            }) -join "`n"
        }
        else {
          "<div class='photo-empty'>Pas de photo extraite</div>"
        }

        $mapLink = if ($_.Latitude -and $_.Longitude) {
          "<a href='https://www.openstreetmap.org/?mlat=$($_.Latitude)&mlon=$($_.Longitude)#map=17/$($_.Latitude)/$($_.Longitude)' target='_blank' rel='noopener noreferrer'>Voir sur carte</a>"
        }
        else {
          ""
        }

        @"
<article class="listing-card" id="listing-$($_.Id)">
  <div class="photo-strip">$photos</div>
  <div class="listing-body">
    <div class="listing-title"><span class="source-badge $sourceClass">$source</span>$title</div>
    <div class="facts">
      <div><span class="fact-label">Prix</span> <span class="price">$price</span></div>
      <div><span class="fact-label">Commune</span> $locality</div>
      <div><span class="fact-label">Recherche</span> $requested</div>
      <div><span class="fact-label">Ch.</span> $beds</div>
      <div><span class="fact-label">Surface</span> $surface</div>
    </div>
    <div class="small">$address <span class="fact-label">($geoPrecision)</span></div>
    <div class="contact"><strong>$agent</strong><br>$contact</div>
    <div class="links"><a href="$($_.Url)" target="_blank" rel="noopener noreferrer">Ouvrir l'annonce</a>$mapLink</div>
  </div>
</article>
"@
      }) -join "`n"
  }
  else {
    "<div class='empty'>Aucune maison trouvee automatiquement sous $($Config.maxPrice) EUR pour les communes configurees.</div>"
  }

  $detectedAgencyRows = if ($Listings.Count -gt 0) {
    ($Listings | Where-Object { $_.AgentName } | Group-Object AgentName | Sort-Object @{ Expression = "Count"; Descending = $true }, Name | ForEach-Object {
        $first = $_.Group | Select-Object -First 1
        $phones = @($_.Group.AgentPhone + $_.Group.AgentMobile | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique) -join "<br>"
        $emails = @($_.Group.AgentEmail | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique) -join "<br>"
        $websites = @($_.Group.AgentWebsite | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
        $websiteHtml = if ($websites.Count -gt 0) { ($websites | ForEach-Object { "<a href='$_' target='_blank' rel='noopener noreferrer'>Site</a>" }) -join "<br>" } else { "" }
        $locations = @($_.Group.RequestedLocation | Select-Object -Unique) -join ", "
        "<tr><td>$([System.Net.WebUtility]::HtmlEncode($_.Name))</td><td>$($_.Count)</td><td>$([System.Net.WebUtility]::HtmlEncode($locations))</td><td>$([System.Net.WebUtility]::HtmlEncode($phones))</td><td>$([System.Net.WebUtility]::HtmlEncode($emails))</td><td>$websiteHtml</td></tr>"
      }) -join "`n"
  }
  else {
    ""
  }

  $detectedAgencyTable = if ($detectedAgencyRows) {
    @"
<table>
  <thead><tr><th>Agence annonce</th><th>Biens</th><th>Communes</th><th>Telephone</th><th>Email</th><th>Site</th></tr></thead>
  <tbody>$detectedAgencyRows</tbody>
</table>
"@
  }
  else {
    "<div class='empty'>Aucune agence detectee dans les annonces retenues.</div>"
  }

  $localAgencyRows = if ($LocalAgencies.Count -gt 0) {
    ($LocalAgencies | Sort-Object Name | ForEach-Object {
        $name = [System.Net.WebUtility]::HtmlEncode($_.Name)
        $address = [System.Net.WebUtility]::HtmlEncode($_.Address)
        $phone = [System.Net.WebUtility]::HtmlEncode($_.Phone)
        $email = [System.Net.WebUtility]::HtmlEncode($_.Email)
        $website = if ($_.Website) { "<a href='$($_.Website)' target='_blank' rel='noopener noreferrer'>Site</a>" } else { "" }
        "<tr><td>$name</td><td>$address</td><td>$phone</td><td>$email</td><td>$website</td><td><a href='$($_.OsmUrl)' target='_blank' rel='noopener noreferrer'>OSM</a></td></tr>"
      }) -join "`n"
  }
  else {
    ""
  }

  $localAgencyTable = if ($localAgencyRows) {
    @"
<table>
  <thead><tr><th>Agence locale OSM</th><th>Adresse</th><th>Telephone</th><th>Email</th><th>Site</th><th>Carte</th></tr></thead>
  <tbody>$localAgencyRows</tbody>
</table>
"@
  }
  else {
    "<div class='empty'>Aucune agence locale recuperee via OpenStreetMap/Overpass.</div>"
  }

  $sourceDiagnosticsRows = if ($SourceDiagnostics.Count -gt 0) {
    ($SourceDiagnostics | ForEach-Object {
        $source = [System.Net.WebUtility]::HtmlEncode($_.Source)
        $location = [System.Net.WebUtility]::HtmlEncode($_.Location)
        $status = [System.Net.WebUtility]::HtmlEncode($_.Status)
        $message = [System.Net.WebUtility]::HtmlEncode($_.Message)
        $url = [System.Net.WebUtility]::HtmlEncode($_.Url)
        "<tr><td>$source</td><td>$location</td><td>$status</td><td>$message</td><td><a href='$url' target='_blank' rel='noopener noreferrer'>Tester</a></td></tr>"
      }) -join "`n"
  }
  else {
    ""
  }

  $sourceDiagnosticsTable = if ($sourceDiagnosticsRows) {
    @"
<table>
  <thead><tr><th>Source</th><th>Commune / agence</th><th>Statut</th><th>Message</th><th>URL</th></tr></thead>
  <tbody>$sourceDiagnosticsRows</tbody>
</table>
"@
  }
  else {
    "<div class='empty'>Aucun diagnostic experimental.</div>"
  }

  $sourceSummary = if ($Listings.Count -gt 0) {
    (($Listings | Group-Object Source | Sort-Object Name | ForEach-Object { "$($_.Name): $($_.Count)" }) -join " · ")
  }
  else {
    "aucune annonce"
  }

  $portalRows = ($PortalLinks | ForEach-Object {
      $location = [System.Net.WebUtility]::HtmlEncode($_.Location)
      "<tr><td>$location</td><td><a href='$($_.Immoweb)' target='_blank' rel='noopener noreferrer'>Immoweb</a></td><td><a href='$($_.Zimmo)' target='_blank' rel='noopener noreferrer'>Zimmo</a></td><td><a href='$($_.Immovlan)' target='_blank' rel='noopener noreferrer'>Immovlan</a></td><td><a href='$($_.SecondHand)' target='_blank' rel='noopener noreferrer'>2ememain</a></td><td><a href='$($_.FacebookMarketplace)' target='_blank' rel='noopener noreferrer'>Facebook</a> · <a href='$($_.PrivateSearch)' target='_blank' rel='noopener noreferrer'>Web</a></td><td><a href='$($_.LocalAgencies)' target='_blank' rel='noopener noreferrer'>Agences locales</a></td></tr>"
    }) -join "`n"

  $listingMarkers = @($Listings | Where-Object { $_.Latitude -and $_.Longitude } | ForEach-Object {
      [pscustomobject]@{
        id = $_.Id
        title = $_.Title
        price = [int]$_.Price
        lat = ConvertTo-CoordinateDouble $_.Latitude
        lon = ConvertTo-CoordinateDouble $_.Longitude
        address = $_.Address
        precision = $_.GeoPrecision
        agent = $_.AgentName
        phone = if ($_.AgentMobile) { $_.AgentMobile } else { $_.AgentPhone }
        url = $_.Url
      }
    })
  $agencyMarkers = @($LocalAgencies | Where-Object { $_.Latitude -and $_.Longitude } | ForEach-Object {
      [pscustomobject]@{
        name = $_.Name
        lat = ConvertTo-CoordinateDouble $_.Latitude
        lon = ConvertTo-CoordinateDouble $_.Longitude
        address = $_.Address
        phone = $_.Phone
        url = $_.OsmUrl
      }
    })
  $listingMarkersJson = ConvertTo-Json -InputObject @($listingMarkers) -Depth 4 -Compress
  $agencyMarkersJson = ConvertTo-Json -InputObject @($agencyMarkers) -Depth 4 -Compress

  return @"
<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Veille immobiliere - $($RunAt.ToString("yyyy-MM-dd"))</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>$style</style>
</head>
<body>
<main>
  <h1>Veille immobiliere quotidienne - experimental multi-sources</h1>
  <div class="meta">Maisons a vendre jusqu'a $($Config.maxPrice) EUR - rapport du $($RunAt.ToString("yyyy-MM-dd HH:mm")) - $($Listings.Count) annonce(s) retenue(s), $($LocalAgencies.Count) agence(s) locale(s) OSM. Sources: $sourceSummary.</div>
  <div class="note">Version experimentale: Immoweb reste la source detaillee stable. Zimmo, Immovlan, 2ememain, les recherches particulier a particulier et les sites d'agences locales sont testes separement; les blocages ou resultats incomplets sont visibles dans le diagnostic des sources.</div>

  <h2>Carte des biens</h2>
  <div class="map-tools">
    <div class="map-legend">
      <span><span class="legend-dot legend-listing"></span>Biens retenus</span>
      <span><span class="legend-dot legend-agency"></span>Agences locales</span>
    </div>
    <label class="map-toggle"><input id="toggleAgencies" type="checkbox"> Afficher les agences locales</label>
  </div>
  <div id="map"><div class="map-fallback">Chargement de la carte...</div></div>

  <h2>Annonces trouvees automatiquement</h2>
  <section class="cards">
  $listingCards
  </section>

  <h2>Agences detectees dans les annonces</h2>
  $detectedAgencyTable

  <h2>Agences locales cartographiees</h2>
  <div class="small">Source: OpenStreetMap/Overpass sur le perimetre configure. Cette liste aide a reperer les agences locales a surveiller, mais ne remplace pas un annuaire officiel.</div>
  $localAgencyTable

  <h2>Diagnostic sources experimentales</h2>
  $sourceDiagnosticsTable

  <h2>Liens de controle par commune</h2>
  <table>
    <thead>
      <tr>
        <th>Commune</th>
        <th>Immoweb</th>
        <th>Zimmo</th>
        <th>Immovlan</th>
        <th>2ememain</th>
        <th>Particuliers</th>
        <th>Agences locales</th>
      </tr>
    </thead>
    <tbody>
$portalRows
    </tbody>
  </table>
</main>
<div id="photoViewer" class="photo-viewer" aria-hidden="true" role="dialog" aria-modal="true" aria-label="Photo agrandie">
  <div class="photo-viewer-panel">
    <div class="photo-viewer-toolbar">
      <div id="photoViewerTitle" class="photo-viewer-title"></div>
      <button id="photoViewerClose" class="photo-viewer-close" type="button">Retour à la page principale</button>
    </div>
    <img id="photoViewerImage" alt="Photo annonce agrandie">
  </div>
</div>
<div id="externalLinkViewer" class="external-link-viewer" aria-hidden="true" role="dialog" aria-modal="true" aria-label="Lien externe">
  <div class="external-link-panel">
    <div id="externalLinkTitle" class="external-link-title">Lien externe</div>
    <textarea id="externalLinkUrl" class="external-link-url" readonly></textarea>
    <div class="external-link-actions">
      <button id="externalLinkCopy" class="external-link-copy" type="button">Copier le lien</button>
      <button id="externalLinkClose" class="external-link-close" type="button">Fermer</button>
      <span id="externalLinkStatus" class="external-link-status" aria-live="polite"></span>
    </div>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const listingMarkers = $listingMarkersJson;
const agencyMarkers = $agencyMarkersJson;

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, function (char) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
  });
}

function money(value) {
  return new Intl.NumberFormat("fr-BE", { maximumFractionDigits: 0 }).format(value) + " EUR";
}

const externalLinkViewer = document.getElementById("externalLinkViewer");
const externalLinkTitle = document.getElementById("externalLinkTitle");
const externalLinkUrl = document.getElementById("externalLinkUrl");
const externalLinkCopy = document.getElementById("externalLinkCopy");
const externalLinkClose = document.getElementById("externalLinkClose");
const externalLinkStatus = document.getElementById("externalLinkStatus");
let lastExternalButton = null;

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

function closeExternalLinkPanel() {
  externalLinkViewer.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (lastExternalButton) {
    lastExternalButton.focus();
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".external-link-button");
  if (!button) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  openExternalLinkPanel(button);
}, true);

externalLinkCopy.addEventListener("click", async () => {
  const url = externalLinkUrl.value;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      externalLinkStatus.textContent = "Lien copié";
    } else {
      throw new Error("Clipboard unavailable");
    }
  } catch {
    externalLinkUrl.focus();
    externalLinkUrl.select();
    externalLinkStatus.textContent = "Lien sélectionné";
  }
});

externalLinkClose.addEventListener("click", closeExternalLinkPanel);
externalLinkViewer.addEventListener("click", (event) => {
  if (event.target === externalLinkViewer) {
    closeExternalLinkPanel();
  }
});

const mapElement = document.getElementById("map");
if (window.L && (listingMarkers.length || agencyMarkers.length)) {
  window.listingMarkers = listingMarkers;
  window.agencyMarkers = agencyMarkers;
  mapElement.innerHTML = "";
  const map = L.map("map", { scrollWheelZoom: true, attributionControl: true });
  map.attributionControl.setPrefix("");
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const listingLayer = L.layerGroup().addTo(map);
  const agencyLayer = L.layerGroup();
  window.veilleImmoAgencyLayer = agencyLayer;
  const listingBounds = [];
  const allBounds = [];
  listingMarkers.forEach((item) => {
    const marker = L.marker([item.lat, item.lon]).addTo(listingLayer);
    marker.bindPopup(
      "<strong>" + escapeHtml(money(item.price)) + "</strong><br>" +
      escapeHtml(item.address) + "<br>" +
      "<span>" + escapeHtml(item.precision) + "</span><br>" +
      escapeHtml(item.agent) + " " + escapeHtml(item.phone) + "<br>" +
      "<button type='button' class='external-link-button' data-external-url='" + escapeHtml(item.url) + "'>Ouvrir l'annonce</button>"
    );
    listingBounds.push([item.lat, item.lon]);
    allBounds.push([item.lat, item.lon]);
  });

  agencyMarkers.forEach((item) => {
    L.circleMarker([item.lat, item.lon], {
      radius: 4,
      color: "#5f6b73",
      weight: 1,
      fillColor: "#ffffff",
      fillOpacity: 0.85
    }).addTo(agencyLayer).bindPopup(
      "<strong>" + escapeHtml(item.name) + "</strong><br>" +
      escapeHtml(item.address) + "<br>" +
      escapeHtml(item.phone) + "<br>" +
      "<button type='button' class='external-link-button' data-external-url='" + escapeHtml(item.url) + "'>Voir sur OSM</button>"
    );
    allBounds.push([item.lat, item.lon]);
  });

  const initialBounds = listingBounds.length ? listingBounds : allBounds;
  if (initialBounds.length === 1) {
    map.setView(initialBounds[0], 14);
  } else {
    map.fitBounds(initialBounds, { padding: [26, 26] });
  }

  const agencyToggle = document.getElementById("toggleAgencies");
  agencyToggle.addEventListener("change", () => {
    if (agencyToggle.checked) {
      agencyLayer.addTo(map);
    } else {
      map.removeLayer(agencyLayer);
    }
  });
} else {
  mapElement.innerHTML = "<div class='map-fallback'>Carte indisponible: aucun point ou bibliotheque Leaflet non chargee.</div>";
}

const photoViewer = document.getElementById("photoViewer");
const photoViewerImage = document.getElementById("photoViewerImage");
const photoViewerTitle = document.getElementById("photoViewerTitle");
const photoViewerClose = document.getElementById("photoViewerClose");
let lastPhotoButton = null;

function openPhotoViewer(button) {
  lastPhotoButton = button;
  photoViewerImage.src = button.dataset.photoSrc;
  photoViewerTitle.textContent = button.dataset.photoTitle || "Photo annonce";
  photoViewer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  photoViewerClose.focus();
}

function closePhotoViewer() {
  photoViewer.setAttribute("aria-hidden", "true");
  photoViewerImage.removeAttribute("src");
  document.body.style.overflow = "";
  if (lastPhotoButton) {
    lastPhotoButton.focus();
  }
}

document.querySelectorAll(".photo-button").forEach((button) => {
  button.addEventListener("click", () => openPhotoViewer(button));
});

photoViewerClose.addEventListener("click", closePhotoViewer);
photoViewer.addEventListener("click", (event) => {
  if (event.target === photoViewer) {
    closePhotoViewer();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && photoViewer.getAttribute("aria-hidden") === "false") {
    closePhotoViewer();
  }
  if (event.key === "Escape" && externalLinkViewer.getAttribute("aria-hidden") === "false") {
    closeExternalLinkPanel();
  }
});
</script>
</body>
</html>
"@
}

$resolvedConfigPath = Resolve-FromWorkspace -Path $ConfigPath
$resolvedOutputDir = Resolve-FromWorkspace -Path $OutputDir
$config = Get-Content -Raw -LiteralPath $resolvedConfigPath | ConvertFrom-Json

New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null

$runAt = Get-Date
$dateStamp = $runAt.ToString("yyyy-MM-dd")
$allListings = New-Object System.Collections.Generic.List[object]
$portalLinks = New-Object System.Collections.Generic.List[object]
$agenciesCsvPath = Join-Path $resolvedOutputDir "agences-locales-$dateStamp.csv"
$todayAgenciesCsv = if ((Test-Path -LiteralPath $agenciesCsvPath) -and ((Get-Item -LiteralPath $agenciesCsvPath).Length -gt 500)) {
  Get-Item -LiteralPath $agenciesCsvPath
}
$previousAgenciesCsv = Get-ChildItem -LiteralPath $resolvedOutputDir -Filter "agences-locales-*.csv" -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -gt 500 } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if ($todayAgenciesCsv) {
  Write-Host "Agences locales: cache du jour"
  $localAgencies = Import-Csv -LiteralPath $todayAgenciesCsv.FullName
}
else {
  Write-Host "Recherche agences locales OpenStreetMap"
  $localAgencies = Get-OpenStreetMapAgencies -Config $config
}
if (@($localAgencies).Count -eq 0 -and $previousAgenciesCsv) {
  Write-Warning "Utilisation du dernier CSV agences non vide: $($previousAgenciesCsv.FullName)"
  $localAgencies = Import-Csv -LiteralPath $previousAgenciesCsv.FullName
}
$localAgenciesArray = @($localAgencies)

foreach ($location in $config.locations) {
  Write-Host "Recherche Immoweb: $($location.name)"
  $portalLinks.Add((Get-PortalLinks -Config $config -Location $location))
  $listings = Get-ImmowebListings -Config $config -Location $location -PagesPerLocation $PagesPerLocation -RequestDelayMs $RequestDelayMs
  foreach ($listing in $listings) {
    Add-ListingIfNew -Collection $allListings -Listing $listing
  }

  Write-Host "Recherche Zimmo experimental: $($location.name)"
  $zimmoListings = Get-ZimmoListings -Config $config -Location $location -RequestDelayMs $RequestDelayMs
  foreach ($listing in $zimmoListings) {
    Add-ListingIfNew -Collection $allListings -Listing $listing
  }

  Write-Host "Recherche Immovlan experimental: $($location.name)"
  $immovlanListings = Get-ImmovlanListings -Config $config -Location $location -RequestDelayMs $RequestDelayMs
  foreach ($listing in $immovlanListings) {
    Add-ListingIfNew -Collection $allListings -Listing $listing
  }

  Write-Host "Recherche 2ememain experimental: $($location.name)"
  $secondHandListings = Get-SecondHandListings -Config $config -Location $location -RequestDelayMs $RequestDelayMs
  foreach ($listing in $secondHandListings) {
    Add-ListingIfNew -Collection $allListings -Listing $listing
  }
}

Write-Host "Recherche sites agences locales experimental"
$agencyWebsiteListings = Get-AgencyWebsiteListings -Config $config -LocalAgencies $localAgenciesArray -RequestDelayMs $RequestDelayMs -MaxAgencies $AgencyWebsiteLimit
foreach ($listing in $agencyWebsiteListings) {
  Add-ListingIfNew -Collection $allListings -Listing $listing
}

foreach ($additionalCsv in $AdditionalListingsCsv) {
  if ([string]::IsNullOrWhiteSpace($additionalCsv)) {
    continue
  }

  $resolvedAdditionalCsv = Resolve-FromWorkspace $additionalCsv
  if (-not (Test-Path -LiteralPath $resolvedAdditionalCsv)) {
    Add-SourceDiagnostic -Source "Alertes email" -Location "CSV complementaire" -Status "Absent" -Message "Fichier introuvable: $additionalCsv" -Url ""
    continue
  }

  $additionalListings = @(Import-Csv -LiteralPath $resolvedAdditionalCsv)
  foreach ($listing in $additionalListings) {
    Add-ListingIfNew -Collection $allListings -Listing $listing
  }
  Add-SourceDiagnostic -Source "Alertes email" -Location (Split-Path -Leaf $resolvedAdditionalCsv) -Status "Import CSV" -Message "$($additionalListings.Count) annonce(s) importee(s) avant deduplication" -Url ""
}

$csvPath = Join-Path $resolvedOutputDir "veille-immo-$dateStamp.csv"
$htmlPath = Join-Path $resolvedOutputDir "veille-immo-$dateStamp.html"
$latestPath = Join-Path $resolvedOutputDir "latest.html"
$indexPath = Join-Path $resolvedOutputDir "index.html"

$listingsArray = @($allListings.ToArray())
$portalLinksArray = @($portalLinks.ToArray())

$listingsArray | Sort-Object Price, RequestedLocation | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
if ($localAgenciesArray.Count -gt 0 -or -not (Test-Path -LiteralPath $agenciesCsvPath)) {
  $localAgenciesArray |
    Select-Object Source, Name, Address, Latitude, Longitude, Phone, Email, Website, OsmUrl |
    Export-Csv -Path $agenciesCsvPath -NoTypeInformation -Encoding UTF8
}
else {
  Write-Warning "CSV agences locales conserve car la collecte OpenStreetMap est vide: $agenciesCsvPath"
}
$html = New-HtmlReport -Config $config -Listings $listingsArray -PortalLinks $portalLinksArray -LocalAgencies $localAgenciesArray -SourceDiagnostics @($script:SourceDiagnostics.ToArray()) -RunAt $runAt
$html = Convert-ExternalLinksToLocalActions -Html $html
Set-Content -LiteralPath $htmlPath -Value $html -Encoding UTF8
Set-Content -LiteralPath $latestPath -Value $html -Encoding UTF8
Set-Content -LiteralPath $indexPath -Value $html -Encoding UTF8
$mobileIndexPath = Join-Path (Split-Path -Parent $PSScriptRoot) "experimental-mobile-index.html"
if (-not $NoMobileIndexCopy) {
  Set-Content -LiteralPath $mobileIndexPath -Value $html -Encoding UTF8
}

Write-Host ""
Write-Host "Rapport HTML: $htmlPath"
Write-Host "Index HTML: $indexPath"
if (-not $NoMobileIndexCopy) {
  Write-Host "Index mobile: $mobileIndexPath"
}
Write-Host "CSV: $csvPath"
Write-Host "CSV agences locales: $agenciesCsvPath"
Write-Host "Annonces multi-sources retenues: $($allListings.Count)"
Write-Host "Agences locales OSM: $($localAgenciesArray.Count)"
Write-Host "Diagnostics sources: $($script:SourceDiagnostics.Count)"

