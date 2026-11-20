# Optional startup launcher for "Shopee Coins Daily Check-in (Taiwan)".
# At Windows sign-in it opens Chrome with the chosen profile so the extension can check in,
# but only if today's check-in is not done yet. Usually run through the .bat files in this folder.
#
#   open_chrome.ps1             Open Chrome now with the chosen profile
#   open_chrome.ps1 -List       List every Chrome profile on this PC and pick one (saved to settings.txt)
#   open_chrome.ps1 -Startup    Startup mode: wait "delay_seconds", then decide whether to open Chrome; errors go to startup.log
#   open_chrome.ps1 -Install    Create a shortcut in the Windows Startup folder (runs -Startup at every sign-in)
#   open_chrome.ps1 -Uninstall  Remove that shortcut
#   open_chrome.ps1 -Check      Only show today's status and whether Chrome would be opened (does not open Chrome)
#   add -DryRun                 Print the command instead of opening Chrome (for debugging)
#
# Status file: the extension writes shopee_checkin.json to the folder set by "statusDir" in
#   status_config.json (in the extension folder = the parent of this folder), relative to Chrome's download folder.
#   {"lastDone":"YYYY-MM-DD"}; lastDone = today means today's check-in is done.
# It only looks at this extension's own status; it is independent of any other extension or launcher.
#
# In -Startup mode Chrome is NOT opened when:
#   1. the same Chrome profile is already running (e.g. another launcher just opened it), or
#   2. skip_if_done = yes (default) and the status file says today's check-in is already done.

param(
  [switch]$List,
  [switch]$Startup,
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Check,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ScriptPath   = $MyInvocation.MyCommand.Path
$Here         = Split-Path -Parent $ScriptPath
$ConfigPath   = Join-Path $Here 'settings.txt'
$LogPath      = Join-Path $Here 'startup.log'
$ShortcutName = 'ShopeeDailyCheckin_OpenChrome.lnk'
$Title        = 'Shopee Daily Check-in'

# ---------- helpers ----------

function Write-Log([string]$msg) {
  Write-Host $msg
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try {
    $old = @()
    if (Test-Path -LiteralPath $LogPath) {
      $old = @(Get-Content -LiteralPath $LogPath -Encoding UTF8 | Select-Object -Last 199)
    }
    Set-Content -LiteralPath $LogPath -Value ($old + $line) -Encoding UTF8
  } catch {}
}

# Read a text file as UTF-8, falling back to the system code page
function Read-TextFile([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  try {
    $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)
  } catch {
    $text = [Text.Encoding]::Default.GetString($bytes)
  }
  return $text.TrimStart([char]0xFEFF)
}

# Works with both ConvertFrom-Json objects and JavaScriptSerializer dictionaries
function Get-Child($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IDictionary]) {
    if ($obj.Contains($name)) { return $obj[$name] }
    return $null
  }
  $p = $obj.PSObject.Properties[$name]
  if ($p) { return $p.Value }
  return $null
}

function Get-Keys($obj) {
  if ($null -eq $obj) { return @() }
  if ($obj -is [System.Collections.IDictionary]) { return @($obj.Keys) }
  return @($obj.PSObject.Properties | ForEach-Object { $_.Name })
}

function Read-Json([string]$path) {
  $raw = Read-TextFile $path
  try { return ($raw | ConvertFrom-Json) } catch {
    # Windows PowerShell 5.1 fails on keys that differ only in case; use the .NET parser instead
    Add-Type -AssemblyName System.Web.Extensions
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = [int]::MaxValue
    return $ser.DeserializeObject($raw)
  }
}

# ---------- settings ----------

function Read-Config {
  $cfg = @{ 'account' = ''; 'window' = 'minimized'; 'delay_seconds' = '20'; 'skip_if_done' = 'yes'; 'chrome_path' = ''; 'chrome_user_data' = '' }
  if (Test-Path -LiteralPath $ConfigPath) {
    foreach ($line in ((Read-TextFile $ConfigPath) -split "`r?`n")) {
      $t = $line.Trim()
      if ($t -eq '' -or $t.StartsWith('#')) { continue }
      $i = $t.IndexOf('=')
      if ($i -lt 1) { continue }
      $cfg[$t.Substring(0, $i).Trim().ToLower()] = $t.Substring($i + 1).Trim()
    }
  }
  return $cfg
}

# Replace the "account=" line, keep every other line as it is
function Save-Account([string]$value) {
  $lines = @()
  if (Test-Path -LiteralPath $ConfigPath) { $lines = @((Read-TextFile $ConfigPath) -split "`r?`n") }
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*account\s*=') { $lines[$i] = 'account=' + $value; $found = $true }
  }
  if (-not $found) { $lines += ('account=' + $value) }
  while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines = $lines[0..($lines.Count - 2)] }
  Set-Content -LiteralPath $ConfigPath -Value $lines -Encoding UTF8
}

function Test-No([string]$v) { return ($v -match '^\s*(no|false|0|off)\s*$') }

# ---------- Chrome ----------

function Get-UserDataDir($cfg) {
  if ($cfg['chrome_user_data']) { return $cfg['chrome_user_data'].Trim('"') }
  return (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')
}

function Find-Chrome($cfg) {
  $cands = @()
  if ($cfg['chrome_path']) { $cands += $cfg['chrome_path'] }
  foreach ($root in 'HKCU:', 'HKLM:') {
    try {
      $p = (Get-ItemProperty -Path "$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction Stop).'(default)'
      if ($p) { $cands += $p }
    } catch {}
  }
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if ($base) { $cands += (Join-Path $base 'Google\Chrome\Application\chrome.exe') }
  }
  foreach ($c in $cands) {
    $c = $c.Trim().Trim('"')
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  throw 'chrome.exe not found. Put its full path in settings.txt as "chrome_path=".'
}

# Read every Chrome profile from Chrome's "Local State" file
function Get-Profiles([string]$dataDir) {
  $statePath = Join-Path $dataDir 'Local State'
  if (-not (Test-Path -LiteralPath $statePath)) {
    throw "Chrome profile list not found: $statePath`nChrome may not be installed, or its data is elsewhere (set chrome_user_data= in settings.txt)."
  }
  $json = Read-Json $statePath
  $cache = Get-Child (Get-Child $json 'profile') 'info_cache'
  if ($null -eq $cache) { throw 'No profile list (profile.info_cache) in Chrome''s Local State.' }

  $list = @()
  foreach ($dir in (Get-Keys $cache)) {
    $info = Get-Child $cache $dir
    $list += [pscustomobject]@{
      Dir   = [string]$dir
      Name  = [string](Get-Child $info 'name')
      Email = [string](Get-Child $info 'user_name')
      Gaia  = [string](Get-Child $info 'gaia_name')
    }
  }
  # Default first, then by Profile number
  return @($list | Sort-Object @{ Expression = { if ($_.Dir -eq 'Default') { -1 } elseif ($_.Dir -match '(\d+)$') { [int]$Matches[1] } else { 9999 } } })
}

# Match by Gmail -> folder name -> display name -> Google name, case-insensitive
function Find-Profile($profiles, [string]$want) {
  $w = $want.Trim()
  foreach ($key in 'Email', 'Dir', 'Name', 'Gaia') {
    $hit = @($profiles | Where-Object { $v = $_.$key; $v -and ($v.Trim() -ieq $w) })
    if ($hit.Count -eq 1) { return $hit[0] }
    if ($hit.Count -gt 1) { throw "$($hit.Count) profiles are named ""$w"". Use the Gmail address or the folder name instead." }
  }
  return $null
}

function Resolve-Target($cfg) {
  $want = $cfg['account']
  if (-not $want) { throw '"account=" in settings.txt is empty. Run 1_select_chrome_profile.bat first.' }
  $dataDir  = Get-UserDataDir $cfg
  $profiles = @(Get-Profiles $dataDir)
  $p = Find-Profile $profiles $want
  if ($null -eq $p) { throw "Profile ""$want"" not found. Run 1_select_chrome_profile.bat to see the list." }
  return @{ Profile = $p; DataDir = $dataDir }
}

function Format-Profile($p) {
  if ($p.Email) { return '{0} / {1}' -f $p.Name, $p.Email }
  return $p.Name
}

function Open-Chrome($cfg) {
  $t = Resolve-Target $cfg
  $p = $t.Profile
  $chrome = Find-Chrome $cfg

  $chromeArgs = @('--profile-directory="' + $p.Dir + '"')
  if ($cfg['chrome_user_data']) { $chromeArgs += ('--user-data-dir="' + $t.DataDir + '"') }
  $style = 'Normal'
  if ($cfg['window'] -match '^\s*min') { $style = 'Minimized' }

  if ($DryRun) {
    Write-Host ('[DryRun] "{0}" {1}   window: {2}' -f $chrome, ($chromeArgs -join ' '), $style)
    return
  }
  Start-Process -FilePath $chrome -ArgumentList $chromeArgs -WindowStyle $style
  Write-Log ('Opened Chrome with "{0}" ({1})' -f (Format-Profile $p), $p.Dir)
}

# Is this Chrome profile already running (e.g. another launcher just opened it)?
# Only Chrome started with --profile-directory can be recognised; a Chrome you opened by hand has no such
# argument, so it is treated as "not running".
function Test-ProfileRunning($t) {
  try {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop)
    $a = '--profile-directory="' + $t.Profile.Dir + '"'
    $b = '--profile-directory=' + $t.Profile.Dir
    foreach ($p in $procs) {
      $cl = [string]$p.CommandLine
      if (-not $cl -or $cl -match '--type=') { continue }   # main process only, skip tab / helper processes
      if ($cl.IndexOf($a, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
      if ($cl -match ('(^|\s)' + [regex]::Escape($b) + '(\s|$)')) { return $true }
    }
  } catch {}
  return $false
}

# ---------- status file ----------

# Chrome's download folder for this profile (download.default_directory in Preferences), else the system Downloads folder
function Get-DownloadDir($t) {
  try {
    $prefs = Join-Path (Join-Path $t.DataDir $t.Profile.Dir) 'Preferences'
    if (Test-Path -LiteralPath $prefs) {
      $dir = [string](Get-Child (Get-Child (Read-Json $prefs) 'download') 'default_directory')
      if ($dir -and (Test-Path -LiteralPath $dir)) { return $dir }
    }
  } catch {}
  try {
    $p = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  } catch {}
  return (Join-Path $env:USERPROFILE 'Downloads')
}

# Folder of the status file: "statusDir" in status_config.json in the extension folder (the parent of this folder),
# relative to Chrome's download folder - the same place the extension writes to. Default: Downloads\ChromeExtensionStatus
function Get-StatusDir($t) {
  $dl = Get-DownloadDir $t
  $rel = 'ChromeExtensionStatus'
  try {
    $cfgPath = Join-Path (Split-Path -Parent $Here) 'status_config.json'
    if (Test-Path -LiteralPath $cfgPath) {
      $v = [string](Get-Child (Read-Json $cfgPath) 'statusDir')
      if ($v.Trim()) { $rel = $v.Trim() }
    }
  } catch {}
  return (Join-Path $dl ($rel -replace '/', '\'))
}

# Returns @{ Done = is today's check-in done; Lines = text lines to show }
function Get-PluginStatus($cfg) {
  $t = Resolve-Target $cfg
  $dir = Get-StatusDir $t
  $lines = @("Status folder: $dir")
  $today = (Get-Date).ToString('yyyy-MM-dd')
  $sp = Join-Path $dir 'shopee_checkin.json'
  if (-not (Test-Path -LiteralPath $sp)) {
    $lines += 'Shopee: no status file yet (reload the extension once in chrome://extensions to create it)'
    return @{ Done = $false; Lines = $lines }
  }
  $last = [string](Get-Child (Read-Json $sp) 'lastDone')
  if ($last -eq $today) {
    $lines += 'Shopee: already checked in today'
    return @{ Done = $true; Lines = $lines }
  }
  $lines += ('Shopee: not checked in today yet (last check-in: {0})' -f $(if ($last) { $last } else { 'never' }))
  return @{ Done = $false; Lines = $lines }
}

# ---------- modes ----------

function Show-List($cfg) {
  $profiles = @(Get-Profiles (Get-UserDataDir $cfg))
  Write-Host ''
  Write-Host 'Chrome profiles on this PC:'
  Write-Host ''
  for ($i = 0; $i -lt $profiles.Count; $i++) {
    $p = $profiles[$i]
    $email = if ($p.Email) { $p.Email } else { '(not signed in to Google)' }
    Write-Host ('  [{0}] {1}' -f ($i + 1), $p.Name)
    Write-Host ('      Gmail : {0}' -f $email)
    Write-Host ('      Folder: {0}' -f $p.Dir)
    Write-Host ''
  }
  if ($cfg['account']) {
    $cur = Find-Profile $profiles $cfg['account']
    if ($cur) { Write-Host ('Current setting: {0}' -f (Format-Profile $cur)) }
    else { Write-Host ('Current setting "{0}" does not match any profile.' -f $cfg['account']) }
    Write-Host ''
  }

  $ans = Read-Host 'Type the number of the profile with the extension installed (Enter = keep current)'
  $n = 0
  if ([int]::TryParse(($ans + '').Trim(), [ref]$n) -and $n -ge 1 -and $n -le $profiles.Count) {
    $p = $profiles[$n - 1]
    # Prefer the Gmail address (readable and survives renaming); otherwise the folder name
    $value = if ($p.Email) { $p.Email } else { $p.Dir }
    Save-Account $value
    Write-Host ('Saved to settings.txt: account={0}' -f $value)
  } elseif (($ans + '').Trim() -ne '') {
    Write-Host 'Invalid number, nothing changed.'
  }
}

function Install-Startup($cfg) {
  # Make sure the settings work before installing
  $t = Resolve-Target $cfg
  $null = Find-Chrome $cfg

  $startupDir = [Environment]::GetFolderPath('Startup')
  $lnk = Join-Path $startupDir $ShortcutName
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ScriptPath + '" -Startup'
  $sc.WorkingDirectory = $Here
  $sc.WindowStyle = 7
  $sc.Description = 'Shopee Daily Check-in: open Chrome at sign-in only if today is not checked in yet'
  $sc.Save()

  Write-Log ('Startup launcher installed for: {0}' -f (Format-Profile $t.Profile))
  Write-Host ('Shortcut: {0}' -f $lnk)
  Write-Host '(If you move this folder later, run the install again.)'
}

function Uninstall-Startup {
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) $ShortcutName
  if (Test-Path -LiteralPath $lnk) {
    Remove-Item -LiteralPath $lnk
    Write-Log 'Startup launcher removed.'
  } else {
    Write-Host 'The startup launcher was not installed.'
  }
}

# ---------- main ----------

try {
  $cfg = Read-Config
  if ($List) {
    Show-List $cfg
  } elseif ($Install) {
    Install-Startup $cfg
  } elseif ($Uninstall) {
    Uninstall-Startup
  } elseif ($Check) {
    $st = Get-PluginStatus $cfg
    $st.Lines | ForEach-Object { Write-Host $_ }
    Write-Host ''
    if (Test-No $cfg['skip_if_done']) { Write-Host 'skip_if_done=no in settings.txt: Chrome is always opened at startup' }
    elseif ($st.Done) { Write-Host '-> At startup now: already checked in today, Chrome would NOT be opened' }
    else { Write-Host '-> At startup now: not checked in today yet, Chrome WOULD be opened' }
  } else {
    if ($Startup) {
      $sec = 0
      [void][int]::TryParse([string]$cfg['delay_seconds'], [ref]$sec)
      if ($sec -gt 0) { Start-Sleep -Seconds $sec }
      $t0 = $null
      try { $t0 = Resolve-Target $cfg } catch {}
      if ($t0 -and (Test-ProfileRunning $t0)) {
        Write-Log ('Chrome ({0}) is already running, not opening it again' -f (Format-Profile $t0.Profile))
        exit 0
      }
      if (-not (Test-No $cfg['skip_if_done'])) {
        $st = $null
        try { $st = Get-PluginStatus $cfg } catch { Write-Log ('Could not read the status, opening Chrome anyway: ' + $_.Exception.Message) }
        if ($st -and $st.Done) {
          Write-Log ('Already checked in today, not opening Chrome (' + (($st.Lines | Select-Object -Skip 1) -join '; ') + ')')
          exit 0
        }
      }
    }
    Open-Chrome $cfg
  }
} catch {
  $msg = $_.Exception.Message
  Write-Log ('Failed: ' + $msg)
  if ($Startup) {
    # The window is hidden at startup, so show a message box that closes itself after 60 seconds
    try { $null = (New-Object -ComObject WScript.Shell).Popup("Opening Chrome at startup failed:`n`n$msg", 60, $Title, 48) } catch {}
  }
  exit 1
}
