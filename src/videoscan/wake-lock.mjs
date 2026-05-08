// Stub: prevents OS sleep during a scan. No-op fallback when no platform impl.
// Returns a `release` function the caller invokes on shutdown.
export async function acquire() {
  if (process.platform !== 'win32') return () => {};
  try {
    const { spawn } = await import('child_process');
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class P{[DllImport(\"kernel32.dll\")]public static extern uint SetThreadExecutionState(uint e);}';" +
          // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
          "[P]::SetThreadExecutionState(0x80000000 -bor 0x00000001 -bor 0x00000040) | Out-Null;" +
          "while ($true) { Start-Sleep -Seconds 30 }",
      ],
      { stdio: 'ignore', detached: false, windowsHide: true },
    );
    ps.on('error', () => {});
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { ps.kill(); } catch {}
    };
  } catch {
    return () => {};
  }
}
