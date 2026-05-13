import os from 'node:os';

export async function acquire() {
  if (os.platform() !== 'win32') return () => {};

  let SetThreadExecutionState;
  try {
    const koffi = (await import('koffi')).default;
    const k32 = koffi.load('kernel32.dll');
    SetThreadExecutionState = k32.func(
      'uint32 __stdcall SetThreadExecutionState(uint32 esFlags)'
    );
  } catch (err) {
    console.warn(`[wake-lock] koffi unavailable (${err?.message ?? err}); standby still possible`);
    return () => {};
  }

  const ES_CONTINUOUS      = 0x80000000;
  const ES_SYSTEM_REQUIRED = 0x00000001;

  let prev;
  try {
    prev = SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
  } catch (err) {
    console.warn(`[wake-lock] SetThreadExecutionState threw (${err?.message ?? err}); standby still possible`);
    return () => {};
  }
  if (prev === 0) {
    console.warn('[wake-lock] SetThreadExecutionState failed; standby still possible');
    return () => {};
  }
  console.log('[wake-lock] SYSTEM_REQUIRED acquired');

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { SetThreadExecutionState(ES_CONTINUOUS); } catch {}
    console.log('[wake-lock] released');
  };
}
