# Changes the real display setting through Windows Settings UI Automation.
param([ValidateSet(100,150,200)][int]$Scale=150)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Start-Process 'ms-settings:display'
$deadline=[DateTime]::UtcNow.AddSeconds(20)
$settings=$null
while ([DateTime]::UtcNow -lt $deadline) {
    $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Settings')
  $settings=[System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,$condition)
  if($settings){break}
  $process=Get-Process SystemSettings -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1
  if ($process) { $settings=[System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle); if($settings){break} }
  Start-Sleep -Milliseconds 200
}
if (-not $settings) { throw 'Windows display Settings did not expose a native window' }
Start-Sleep -Seconds 2
$controls=$settings.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
$report=@($controls | ForEach-Object {@{name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;enabled=$_.Current.IsEnabled}})
New-Item -ItemType Directory -Force -Path native-smoke-results | Out-Null
$report | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 "native-smoke-results/display-settings-$Scale.json"
$remote=@($controls | Where-Object {$_.Current.Name -match 'cannot be changed.*remote|remote session'})
if($remote.Count){throw ('Display scaling unavailable in this session: '+$remote[0].Current.Name)}
$combos=@($controls | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and $_.Current.IsEnabled -and ($_.Current.Name -match 'scale|size of text|100%|150%|200%')})
if($combos.Count -ne 1){throw "Expected one enabled display-scale combo; found $($combos.Count). See display-settings-$Scale.json"}
# The hosted desktop starts at 1024x768, which offers only 100/125%.
# Select a real larger display mode before requesting 150/200%.
if ($Scale -gt 125) {
  $resolution=@($controls | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and $_.Current.Name -eq 'Display resolution'})[0]
  $resolution.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  Start-Sleep -Milliseconds 500
  $modes=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $modes | ForEach-Object {@{name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName}} | ConvertTo-Json | Set-Content -Encoding UTF8 "native-smoke-results/display-modes-$Scale.json"
  $resolutionPattern=if($Scale -eq 200){'^1600 [×x] 1200'}else{'^1920 [×x] 1080'}
  $large=@($modes | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem -and $_.Current.Name -match $resolutionPattern})
  if (-not $large.Count) { throw 'Hosted display exposes no larger resolution for 150/200% scaling; see display-modes report' }
  $large[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
  Start-Sleep -Seconds 2
  $buttons=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($button in $buttons){if($button.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $button.Current.Name -match '^Keep changes$'){$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()}}
  Start-Sleep -Seconds 2
  $controls=$settings.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $combos=@($controls | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and $_.Current.Name -eq 'Scale'})
}
$combo=$combos[0]
$expand=$combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
$expand.Expand()
Start-Sleep -Milliseconds 500
$choices=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
$choices | ForEach-Object {@{name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;enabled=$_.Current.IsEnabled}} | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 "native-smoke-results/display-options-$Scale.json"
$items=@($choices | Where-Object {$_.Current.Name -match "^$Scale%($|\s)" -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem})
if($items.Count -ne 1){throw "Expected one $Scale percent option; found $($items.Count)"}
$items[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
Start-Sleep -Seconds 2
Write-Output "Selected actual Windows display scale $Scale percent; WebView2 must independently confirm window DPI."
