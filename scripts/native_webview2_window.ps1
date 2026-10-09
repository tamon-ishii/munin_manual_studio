param(
    [Parameter(Mandatory=$true)][int]$OwnerPid,
    [ValidateSet('info','hover','capture','resize')][string]$Action='info',
    [double]$X=0, [double]$Y=0,
    [int]$Width=1440, [int]$Height=940,
    [string]$OutputPath
)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int height,bool repaint);
}
'@
# Read and use physical desktop coordinates even when the caller's DPI differs.
[void][FixtureWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
$process=Get-Process -Id $OwnerPid
$handle=$process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'Fixture window is not ready' }
[uint32]$actualPid=0
[void][FixtureWindow]::GetWindowThreadProcessId($handle,[ref]$actualPid)
if ($actualPid -ne $OwnerPid) { throw 'Window ownership mismatch' }
$dpi=[FixtureWindow]::GetDpiForWindow($handle)
if ($dpi -eq 0) { throw 'Cannot read the window DPI' }
[void][FixtureWindow]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 100
if ([FixtureWindow]::GetForegroundWindow() -ne $handle) { throw 'The owned Studio window is not in the foreground' }
if ($Action -eq 'resize') {
  Add-Type -AssemblyName System.Windows.Forms
  $available=[System.Windows.Forms.Screen]::FromHandle($handle).WorkingArea
  $fixtureWidth=[Math]::Min($Width,$available.Width)
  $fixtureHeight=[Math]::Min($Height,$available.Height)
  if (-not [FixtureWindow]::MoveWindow($handle,$available.Left,$available.Top,$fixtureWidth,$fixtureHeight,$true)) { throw 'Cannot resize fixture window' }
  Start-Sleep -Milliseconds 400
}
$origin=New-Object FixtureWindow+Point
if (-not [FixtureWindow]::ClientToScreen($handle,[ref]$origin)) { throw 'Cannot resolve fixture client origin' }
if ($Action -eq 'hover') {
  if (-not [FixtureWindow]::SetCursorPos($origin.X+[int]($X*$dpi/96),$origin.Y+[int]($Y*$dpi/96))) { throw 'Cannot move the pointer' }
  Start-Sleep -Milliseconds 1200
}
$bounds=New-Object FixtureWindow+Rect
if (-not [FixtureWindow]::GetWindowRect($handle,[ref]$bounds)) { throw 'Cannot read fixture window bounds' }
if ($Action -eq 'capture') {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  $screen=[System.Windows.Forms.Screen]::FromHandle($handle).Bounds
  if ($bounds.Left -lt $screen.Left -or $bounds.Top -lt $screen.Top -or $bounds.Right -gt $screen.Right -or $bounds.Bottom -gt $screen.Bottom) { throw 'Fixture window is clipped by the display' }
  $bitmap=New-Object System.Drawing.Bitmap ($bounds.Right-$bounds.Left),($bounds.Bottom-$bounds.Top)
  $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bitmap.Size)
    $bitmap.Save($OutputPath,[System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
@{pid=$OwnerPid;dpi=$dpi;scale=$dpi/96;bounds=@{left=$bounds.Left;top=$bounds.Top;right=$bounds.Right;bottom=$bounds.Bottom}} | ConvertTo-Json -Compress
