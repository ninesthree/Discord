# Install dependencies without invoking npm.ps1 directly
# Uses node to run a tiny JS that shells out to the npm CLI bypassing execution policy

param(
    [string]$Dir = "$PSScriptRoot/.."
)

Write-Host "Installing dependencies in $Dir" -ForegroundColor Cyan
Set-Location -Path $Dir

# Try to call npm via node exec workaround
node -e "const {spawn} = require('node:child_process'); const p=spawn('npm.cmd',['install'],{stdio:'inherit'}); p.on('exit',c=>process.exit(c));"
