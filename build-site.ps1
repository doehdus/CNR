[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$nodeDirectory = Join-Path $projectRoot '.tools\node-v22.23.4-win-x64'
$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
$npmScript = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
$siteDirectory = Join-Path $projectRoot 'site'
$typescriptScript = Join-Path $siteDirectory 'node_modules\typescript\bin\tsc'
$resultImporter = Join-Path $siteDirectory 'scripts\import-metric-results.mjs'
$metricResults = Join-Path $projectRoot 'results\metrics\stoi_estoi.json'

foreach ($requiredFile in @($nodeExecutable, $npmScript, $typescriptScript, $resultImporter)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required project tool is missing: $requiredFile"
    }
}

function Invoke-ProjectCommand {
    param([string]$Executable, [string[]]$Arguments)

    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Project command failed with exit code ${LASTEXITCODE}: $Executable"
    }
}

$previousPath = $env:PATH
$previousNpmCache = $env:npm_config_cache

try {
    $env:PATH = $nodeDirectory + [IO.Path]::PathSeparator + $previousPath
    $env:npm_config_cache = Join-Path $projectRoot '.cache\npm'

    Push-Location -LiteralPath $projectRoot
    try {
        # The website consumes completed result data; it never runs the calculator.
        Invoke-ProjectCommand $nodeExecutable @($resultImporter, '--source', $metricResults)

        Push-Location -LiteralPath $siteDirectory
        try {
            Invoke-ProjectCommand $nodeExecutable @($npmScript, 'test')
            Invoke-ProjectCommand $nodeExecutable @($typescriptScript, '--noEmit')
            Invoke-ProjectCommand $nodeExecutable @($npmScript, 'run', 'build')
        }
        finally {
            Pop-Location
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:PATH = $previousPath
    $env:npm_config_cache = $previousNpmCache
}

Write-Host 'Site build ready in site/dist. Audio and metric results are included.'
