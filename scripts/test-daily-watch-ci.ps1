[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Git {
  param(
    [string]$WorkingDirectory,
    [string[]]$Arguments
  )

  & git -C $WorkingDirectory @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git -C $WorkingDirectory $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("veille-immo-ci-test-" + [guid]::NewGuid().ToString("N"))
$remote = Join-Path $testRoot "remote.git"
$seed = Join-Path $testRoot "seed"
$runner = Join-Path $testRoot "runner"
$concurrent = Join-Path $testRoot "concurrent"
$originalGitHubActions = $env:GITHUB_ACTIONS
$originalRunnerTemp = $env:RUNNER_TEMP
$originalConcurrentClone = $env:VEILLE_IMMO_TEST_CONCURRENT_CLONE

try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  Invoke-Git $testRoot @("init", "--bare", $remote)
  Invoke-Git $testRoot @("init", "-b", "main", $seed)

  New-Item -ItemType Directory -Path (Join-Path $seed "scripts"), (Join-Path $seed "config"), (Join-Path $seed "reports") | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "run-daily-watch-ci.ps1") -Destination (Join-Path $seed "scripts/run-daily-watch-ci.ps1")

  @'
param(
  [string]$ProjectRoot,
  [string]$ConfigPath,
  [string]$OutputDir,
  [int]$PagesPerLocation,
  [int]$RequestDelayMs,
  [string]$PreviousResultsPath
)
$counterPath = Join-Path $ProjectRoot ".generation-attempt"
$attempt = if (Test-Path -LiteralPath $counterPath) { 1 + [int](Get-Content -LiteralPath $counterPath -Raw) } else { 1 }
Set-Content -LiteralPath $counterPath -Value $attempt
$reports = Join-Path $ProjectRoot $OutputDir
New-Item -ItemType Directory -Force -Path $reports | Out-Null
$sourceState = Get-Content -LiteralPath (Join-Path $ProjectRoot "pwa.js") -Raw
Set-Content -LiteralPath (Join-Path $ProjectRoot "index.html") -Value "generated-attempt=$attempt source=$sourceState"
Set-Content -LiteralPath (Join-Path $ProjectRoot "mobile-index.html") -Value "mobile-attempt=$attempt source=$sourceState"
Set-Content -LiteralPath (Join-Path $reports "index.html") -Value "report-attempt=$attempt source=$sourceState"
Set-Content -LiteralPath (Join-Path $reports "veille-immo-test.csv") -Value "id,price`n1,100000"
Set-Content -LiteralPath (Join-Path $reports "veille-immo-test.html") -Value "daily-attempt=$attempt"
Set-Content -LiteralPath (Join-Path $reports "agences-locales-test.csv") -Value "name`nAgency"
Set-Content -LiteralPath (Join-Path $ProjectRoot "results.json") -Value "{`"generatedAt`":`"test-$attempt`",`"listings`":[{`"id`":`"1`"}]}"

if ($attempt -eq 1) {
  $clone = $env:VEILLE_IMMO_TEST_CONCURRENT_CLONE
  git -C $clone pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) { throw "Concurrent clone pull failed" }
  Set-Content -LiteralPath (Join-Path $clone "pwa.js") -Value "concurrent-source-change"
  git -C $clone add pwa.js
  git -C $clone commit -m "Concurrent source update"
  if ($LASTEXITCODE -ne 0) { throw "Concurrent commit failed" }
  git -C $clone push origin main
  if ($LASTEXITCODE -ne 0) { throw "Concurrent push failed" }
}
'@ | Set-Content -LiteralPath (Join-Path $seed "scripts/stub-generate.ps1") -Encoding UTF8

  Set-Content -LiteralPath (Join-Path $seed "index.html") -Value "initial"
  Set-Content -LiteralPath (Join-Path $seed "mobile-index.html") -Value "initial"
  Set-Content -LiteralPath (Join-Path $seed "pwa.js") -Value "initial-source"
  Set-Content -LiteralPath (Join-Path $seed "results.json") -Value '{"generatedAt":"initial","listings":[]}'
  Set-Content -LiteralPath (Join-Path $seed "config/veille-immo.json") -Value "{}"
  Set-Content -LiteralPath (Join-Path $seed "reports/index.html") -Value "initial"

  Invoke-Git $seed @("config", "user.name", "CI test")
  Invoke-Git $seed @("config", "user.email", "ci-test@example.invalid")
  Invoke-Git $seed @("remote", "add", "origin", $remote)
  Invoke-Git $seed @("add", ".")
  Invoke-Git $seed @("commit", "-m", "Initial fixture")
  Invoke-Git $seed @("push", "-u", "origin", "main")

  Invoke-Git $testRoot @("clone", "-b", "main", $remote, $runner)
  Invoke-Git $testRoot @("clone", "-b", "main", $remote, $concurrent)
  Invoke-Git $concurrent @("config", "user.name", "Concurrent test")
  Invoke-Git $concurrent @("config", "user.email", "concurrent@example.invalid")

  $env:GITHUB_ACTIONS = "true"
  $env:RUNNER_TEMP = $testRoot
  $env:VEILLE_IMMO_TEST_CONCURRENT_CLONE = $concurrent

  & (Join-Path $runner "scripts/run-daily-watch-ci.ps1") `
    -ProjectRoot $runner `
    -Branch "main" `
    -MaxAttempts 2 `
    -GenerationScript (Join-Path $runner "scripts/stub-generate.ps1")
  if (-not $?) {
    throw "CI publication integration test failed"
  }

  $publishedSource = (& git --git-dir=$remote show "main:pwa.js") -join "`n"
  $publishedIndex = (& git --git-dir=$remote show "main:index.html") -join "`n"
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect published fixture"
  }
  if ($publishedSource.Trim() -ne "concurrent-source-change") {
    throw "Concurrent source change was not preserved"
  }
  if ($publishedIndex -notmatch "generated-attempt=2" -or $publishedIndex -notmatch "concurrent-source-change") {
    throw "Generated output was not rebuilt from the concurrent source update"
  }

  Write-Output "Daily watch CI concurrency test: OK"
} finally {
  $env:GITHUB_ACTIONS = $originalGitHubActions
  $env:RUNNER_TEMP = $originalRunnerTemp
  $env:VEILLE_IMMO_TEST_CONCURRENT_CLONE = $originalConcurrentClone

  if (Test-Path -LiteralPath $testRoot) {
    $resolvedTestRoot = (Resolve-Path -LiteralPath $testRoot).Path
    $resolvedTempRoot = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path
    if (-not $resolvedTestRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove test directory outside the system temp directory: $resolvedTestRoot"
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
  }
}
