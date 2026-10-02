# Programa el respaldo diario de TECNIFIN (tools/respaldo.mjs) como tarea de Windows.
# ASCII puro: PowerShell 5.1 lee los .ps1 como ANSI (ver CLAUDE.md).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\programar-respaldo.ps1            # muestra el estado
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\programar-respaldo.ps1 -Instalar  # crea o reemplaza la tarea
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\programar-respaldo.ps1 -Quitar
#
# -Instalar y -Quitar requieren PowerShell como ADMINISTRADOR (la tarea corre como SYSTEM).
# Sin elevacion, Get-ScheduledTask no ve tareas de SYSTEM y devuelve vacio: no es "no existe".
param(
  [switch]$Instalar,
  [switch]$Quitar,
  [string]$Hora = '23:30'
)
$ErrorActionPreference = 'Stop'
$Nombre = 'TECNIFIN-Respaldo'
$Repo = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$EsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

if (($Instalar -or $Quitar) -and -not $EsAdmin) {
  Write-Host 'Ejecute PowerShell como administrador para instalar o quitar la tarea.'
  exit 1
}

if ($Quitar) {
  Unregister-ScheduledTask -TaskName $Nombre -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarea $Nombre eliminada."
  exit 0
}

if ($Instalar) {
  $Accion = New-ScheduledTaskAction -Execute $Node -Argument 'tools\respaldo.mjs' -WorkingDirectory $Repo
  $Disparador = New-ScheduledTaskTrigger -Daily -At $Hora
  $Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $Ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $Nombre -Action $Accion -Trigger $Disparador -Principal $Principal `
    -Settings $Ajustes -Force | Out-Null
  Write-Host "Tarea $Nombre instalada: todos los dias a las $Hora, node tools\respaldo.mjs en $Repo"
  exit 0
}

if (-not $EsAdmin) {
  Write-Host 'Aviso: sin elevacion no se ven las tareas de SYSTEM; el estado puede salir vacio aunque exista.'
}
$Tarea = Get-ScheduledTask -TaskName $Nombre -ErrorAction SilentlyContinue
if ($Tarea) {
  $Info = Get-ScheduledTaskInfo -TaskName $Nombre
  Write-Host "Tarea ${Nombre}: $($Tarea.State). Ultima ejecucion: $($Info.LastRunTime) (resultado $($Info.LastTaskResult))."
} else {
  Write-Host "Tarea $Nombre no encontrada."
}
