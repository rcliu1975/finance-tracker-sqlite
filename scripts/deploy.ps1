$ErrorActionPreference = "Stop"

if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
  $firebaseCmd = Join-Path $env:APPDATA "npm\\firebase.cmd"
  if (Test-Path $firebaseCmd) {
    Set-Alias firebase $firebaseCmd -Scope Script
  } else {
    Write-Error "firebase CLI not found. Install firebase-tools first."
  }
}

if (-not (Test-Path "firebase-config.js")) {
  Write-Error "firebase-config.js not found. Add your Firebase Web config first."
}

if (-not (Test-Path ".firebaserc")) {
  Write-Error ".firebaserc not found. Add your Firebase project id first."
}

Write-Host "Deploying to Firebase Hosting..."
firebase deploy --only hosting
Write-Host "Deploy complete."
