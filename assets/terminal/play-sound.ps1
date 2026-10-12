# Fixed Gremlyn outcome-audio helper (design D5).
#
# Plays exactly one packaged, deterministic cue asset. The cue is a closed
# enum and the asset directory is resolved by the caller from Gremlyn's own
# module location -- never from a job, repository or operator-supplied string.
# Arguments arrive as an argument vector (no shell), so nothing here is
# interpolated into a command line.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('success', 'failure')]
  [string]$Cue,

  [Parameter(Mandatory = $true)]
  [string]$AssetDir
)

$ErrorActionPreference = 'Stop'

$name = if ($Cue -eq 'success') { 'success.wav' } else { 'failure.wav' }
$path = Join-Path -Path $AssetDir -ChildPath $name
if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
  throw "missing cue asset: $name"
}

# SoundPlayer is a .NET Framework type available in Windows PowerShell; the
# daemon never assumes audibility from a successful exit.
$player = New-Object System.Media.SoundPlayer
try {
  $player.SoundLocation = $path
  $player.PlaySync()
} finally {
  $player.Dispose()
}
