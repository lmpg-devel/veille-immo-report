[CmdletBinding()]
param(
  [string]$ProjectRoot = (Join-Path $PSScriptRoot ".."),
  [string]$Branch = "main",
  [int]$MaxAttempts = 2,
  [string]$GenerationScript = (Join-Path $PSScriptRoot "generate-daily-watch.ps1"),
  [switch]$AllowLocalRepositoryReset
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Git {
  param([string[]]$Arguments)

  & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

function Get-GitValue {
  param([string[]]$Arguments)

  $value = & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
  return ([string]($value | Select-Object -First 1)).Trim()
}

if ($MaxAttempts -lt 1 -or $MaxAttempts -gt 3) {
  throw "MaxAttempts must be between 1 and 3"
}

if ($env:GITHUB_ACTIONS -ne "true" -and -not $AllowLocalRepositoryReset) {
  throw "This script resets the CI checkout and may only run in GitHub Actions. Use -AllowLocalRepositoryReset only in an isolated test repository."
}

$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$generator = (Resolve-Path -LiteralPath $GenerationScript).Path
$tempRoot = if ($env:RUNNER_TEMP) {
  $env:RUNNER_TEMP
} else {
  [System.IO.Path]::GetTempPath()
}
$remoteRef = "origin/$Branch"
$publishPaths = @(
  "index.html",
  "results.json",
  "results-terrain.json",
  "reports",
  "mobile-index.html",
  "config/veille-immo.json"
)

Push-Location -LiteralPath $root
try {
  $repositoryRoot = (Resolve-Path -LiteralPath (Get-GitValue @("rev-parse", "--show-toplevel"))).Path
  if (-not $repositoryRoot.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ProjectRoot must be the Git repository root: $repositoryRoot"
  }

  Invoke-Git @("config", "user.name", "github-actions[bot]")
  Invoke-Git @("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
    Write-Host "Daily watch publish attempt $attempt of $MaxAttempts"

    Invoke-Git @("fetch", "--no-tags", "origin", $Branch)

    # The checkout is disposable on GitHub Actions. Resetting here guarantees
    # that every generation starts from the latest published application code.
    Invoke-Git @("reset", "--hard", $remoteRef)
    $startCommit = Get-GitValue @("rev-parse", "HEAD")

    $previousResults = Join-Path $tempRoot "veille-immo-previous-results-attempt-$attempt.json"
    Copy-Item -LiteralPath (Join-Path $root "results.json") -Destination $previousResults -Force
    & $generator `
      -ProjectRoot $root `
      -ConfigPath "config/veille-immo.json" `
      -OutputDir "reports" `
      -PagesPerLocation 2 `
      -RequestDelayMs 700 `
      -PreviousResultsPath $previousResults
    if (-not $?) {
      throw "Daily watch generation failed on attempt $attempt"
    }

    Invoke-Git @("fetch", "--no-tags", "origin", $Branch)
    $latestCommit = Get-GitValue @("rev-parse", $remoteRef)
    if ($latestCommit -ne $startCommit) {
      $message = "The remote branch changed during generation ($startCommit -> $latestCommit)."
      if ($attempt -ge $MaxAttempts) {
        throw "$message Retry limit reached; rerun the workflow."
      }
      Write-Warning "$message Discarding stale generated files and retrying from the new head."
      continue
    }

    Invoke-Git (@("add", "--") + $publishPaths)
    & git diff --cached --quiet
    $diffExitCode = $LASTEXITCODE
    if ($diffExitCode -eq 0) {
      Write-Host "No changes to commit"
      return
    }
    if ($diffExitCode -ne 1) {
      throw "git diff --cached --quiet failed with exit code $diffExitCode"
    }

    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
    Invoke-Git @("commit", "-m", "Update real estate watch $stamp")

    & git push origin "HEAD:$Branch"
    if ($LASTEXITCODE -eq 0) {
      Write-Host "Daily watch updates published successfully"
      return
    }

    Invoke-Git @("fetch", "--no-tags", "origin", $Branch)
    $afterPushCommit = Get-GitValue @("rev-parse", $remoteRef)
    if ($afterPushCommit -eq $startCommit) {
      throw "git push failed without a concurrent remote update; check credentials or branch protection"
    }
    if ($attempt -ge $MaxAttempts) {
      throw "The remote branch changed during push and the retry limit was reached"
    }

    Write-Warning "The remote branch changed during push. Regenerating once from the latest head."
  }

  throw "Daily watch publication ended without success"
} finally {
  Pop-Location
}
