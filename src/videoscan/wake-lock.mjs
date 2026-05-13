import os from 'node:os';

export async function acquire() {
  if (os.platform() !== 'win32') return () => {};

  const koffi = (await import('koffi')).default;
  const k32 = koffi.load('kernel32.dll');
  const SetThreadExecutionState = k32.func(
    'uint32 __stdcall SetThreadExecutionState(uint32 esFlags)'
  );

  const ES_CONTINUOUS      = 0x80000000;
  const ES_SYSTEM_REQUIRED = 0x00000001;

  const prev = SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
  if (prev === 0) {
    console.warn('[wake-lock] SetThreadExecutionState failed; standby still possible');
    return () => {};
  }
  console.log('[wake-lock] SYSTEM_REQUIRED acquired');

  let released = false;
  return () => {
    if (released) return;
    released = true;
    SetThreadExecutionState(ES_CONTINUOUS);
    console.log('[wake-lock] released');
  };
}
