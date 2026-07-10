function Find-ClaudeBinary {
  $command = Get-Command claude.exe -ErrorAction SilentlyContinue
  if ($command -and $command.Source -and $command.Source -notmatch '\\WindowsApps\\') {
    return $command.Source
  }

  $extensionRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
  $candidate = Get-ChildItem -Directory -LiteralPath $extensionRoot -Filter 'anthropic.claude-code-*-win32-x64' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName 'resources\native-binary\claude.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
  return $candidate
}

function Find-CodexBinary {
  $command = Get-Command codex.exe -ErrorAction SilentlyContinue
  if ($command -and $command.Source -and $command.Source -notmatch '\\WindowsApps\\') {
    return $command.Source
  }

  $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  $candidate = Get-ChildItem -File -Recurse -LiteralPath $binRoot -Filter 'codex.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -ExpandProperty FullName -First 1
  return $candidate
}

function Get-NemoProjectRoot {
  return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}
