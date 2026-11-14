[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$nodeDirectory = Join-Path $projectRoot '.tools\node-v22.23.4-win-x64'
$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
$npmScript = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
$pythonExecutable = Join-Path $projectRoot '.venv\Scripts\python.exe'
$siteDirectory = Join-Path $projectRoot 'site'
$typescriptScript = Join-Path $siteDirectory 'node_modules\typescript\bin\tsc'

foreach ($requiredFile in @($nodeExecutable, $npmScript, $pythonExecutable, $typescriptScript)) {
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
        Invoke-ProjectCommand $pythonExecutable @(
            '-m', 'metrics.calculate_metrics', '--algorithm', 'noisy', '--algorithm', 'ss_fixed'
        )
        Copy-Item -LiteralPath (Join-Path $projectRoot 'metrics\results\stoi_estoi.json') `
            -Destination (Join-Path $siteDirectory 'public\metrics\results\stoi_estoi.json')

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
