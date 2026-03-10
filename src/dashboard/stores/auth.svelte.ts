import { getAuthStatus, startDeviceFlow, pollDeviceFlow } from '../lib/api';
import type { PollResponse } from '../lib/api';

type FlowState = 'idle' | 'polling' | 'complete' | 'error';

let authenticated = $state(false);
let clientIdConfigured = $state(false);
let flowState = $state<FlowState>('idle');
let userCode = $state('');
let verificationUri = $state('');
let deviceCode = $state('');
let errorMessage = $state('');
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let pollIntervalMs = 5000;

export function getAuth() {
  return {
    get authenticated() { return authenticated; },
    get clientIdConfigured() { return clientIdConfigured; },
    get flowState() { return flowState; },
    get userCode() { return userCode; },
    get verificationUri() { return verificationUri; },
    get errorMessage() { return errorMessage; },
  };
}

export async function fetchAuthStatus() {
  try {
    const s = await getAuthStatus();
    authenticated = s.authenticated;
    clientIdConfigured = s.clientIdConfigured;
  } catch { /* ignore */ }
}

export async function beginDeviceFlow() {
  errorMessage = '';
  try {
    const resp = await startDeviceFlow();
    userCode = resp.user_code;
    verificationUri = resp.verification_uri;
    deviceCode = resp.device_code;
    pollIntervalMs = (resp.interval || 5) * 1000;
    flowState = 'polling';
    schedulePoll();
  } catch (e: any) {
    flowState = 'error';
    errorMessage = e.message || 'Failed to start';
  }
}

function schedulePoll() {
  pollTimeout = setTimeout(async () => {
    try {
      const poll: PollResponse = await pollDeviceFlow(deviceCode);
      if (poll.status === 'complete') {
        clearPollTimer();
        flowState = 'complete';
        authenticated = true;
      } else if (poll.status === 'slow_down') {
        pollIntervalMs += 5000;
        schedulePoll();
      } else if (poll.status === 'expired' || poll.status === 'denied') {
        clearPollTimer();
        flowState = 'error';
        errorMessage = poll.status === 'expired' ? 'Code expired' : 'Access denied';
      } else if (poll.status === 'error') {
        clearPollTimer();
        flowState = 'error';
        errorMessage = poll.error || 'Unknown error';
      } else {
        // pending → keep polling at current interval
        schedulePoll();
      }
    } catch {
      clearPollTimer();
      flowState = 'error';
      errorMessage = 'Polling failed';
    }
  }, pollIntervalMs);
}

function clearPollTimer() {
  if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
}

export function cancelDeviceFlow() {
  clearPollTimer();
  flowState = 'idle';
  userCode = '';
  verificationUri = '';
  deviceCode = '';
  errorMessage = '';
}
