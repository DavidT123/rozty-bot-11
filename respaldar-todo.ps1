$fecha = Get-Date -Format "yyyyMMdd_HHmmss"
if (!(Test-Path "backups")) { New-Item -ItemType Directory -Path "backups" | Out-Null }
$dest = "backups\respaldo_$fecha.zip"
Compress-Archive -Path data, sessions, .env -DestinationPath $dest -Force
Write-Host "Respaldo creado en $dest"
