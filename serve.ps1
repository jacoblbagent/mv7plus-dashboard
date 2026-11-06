# Serves this folder on http://localhost:8788 and opens the dashboard.
#
# A localhost origin is the most reliable place to run WebHID: it is a secure
# context on every Windows build, and no install or admin rights are involved.
# Uses a plain loopback TcpListener because HttpListener needs a URL ACL.
# Close this window to stop the server.

$ErrorActionPreference = 'Stop'

$port = 8788
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://localhost:$port/index.html"

function Open-Dashboard {
  if ($env:MV7_NO_BROWSER -eq '1') { return }
  try { Start-Process $url } catch { Write-Host "Open $url in Chrome or Edge." }
}

# Another copy may already be serving this port; reuse it instead of failing.
try {
  $probe = [System.Net.Sockets.TcpClient]::new()
  $probe.Connect('127.0.0.1', $port)
  $probe.Close()
  Write-Host "Dashboard already running at $url"
  Open-Dashboard
  exit 0
} catch { }

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
try {
  $listener.Start()
} catch {
  Write-Host "Could not listen on port $port. Open index.html directly instead."
  Open-Dashboard
  exit 1
}

$contentTypes = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
}

function Send-Response {
  param($Stream, [int]$Status, [string]$Reason, [string]$ContentType, [byte[]]$Body)

  $header = "HTTP/1.1 $Status $Reason`r`n" +
            "Content-Type: $ContentType`r`n" +
            "Content-Length: $($Body.Length)`r`n" +
            "Cache-Control: no-store`r`n" +
            "Connection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
  $Stream.Flush()
}

$basePath = [System.IO.Path]::GetFullPath($root).TrimEnd('\', '/')

Write-Host "MV7+ Control at $url"
Write-Host "Keep this window open. Close it to stop the server."
Open-Dashboard

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 5000
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { $client.Close(); continue }

    # Drain the request headers; only the path from the request line is used.
    while (($line = $reader.ReadLine()) -ne $null -and $line -ne '') { }

    $parts = $requestLine.Split(' ')
    $path = if ($parts.Length -ge 2) { $parts[1] } else { '/' }
    $path = [System.Uri]::UnescapeDataString($path.Split('?')[0])
    if ($path -eq '/') { $path = '/index.html' }

    $candidate = [System.IO.Path]::GetFullPath((Join-Path $basePath $path.TrimStart('/')))

    # Never serve a file outside this folder.
    if (-not $candidate.StartsWith($basePath, [System.StringComparison]::OrdinalIgnoreCase)) {
      Send-Response -Stream $stream -Status 403 -Reason 'Forbidden' -ContentType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('Forbidden'))
    } elseif (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($candidate)
      $ext = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
      $type = if ($contentTypes.ContainsKey($ext)) { $contentTypes[$ext] } else { 'application/octet-stream' }
      Send-Response -Stream $stream -Status 200 -Reason 'OK' -ContentType $type -Body $bytes
    } else {
      Send-Response -Stream $stream -Status 404 -Reason 'Not Found' -ContentType 'text/plain' -Body ([System.Text.Encoding]::UTF8.GetBytes('Not found'))
    }
  } catch {
    # A dropped connection is normal; keep serving.
  } finally {
    $client.Close()
  }
}
