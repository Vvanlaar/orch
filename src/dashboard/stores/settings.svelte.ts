import type { Terminal, TerminalId } from '../lib/types';
import { analyzeTerminals, getTerminalConfig, setTerminalConfig, setTerminalInteractiveConfig } from '../lib/api';

let terminals = $state<Terminal[]>([]);
let selectedTerminal = $state<TerminalId>('auto');
let interactiveSession = $state(true);
let analyzing = $state(false);
let loaded = $state(false);

export function getSettings() {
  return {
    get terminals() { return terminals; },
    get selectedTerminal() { return selectedTerminal; },
    get interactiveSession() { return interactiveSession; },
    get analyzing() { return analyzing; },
    get loaded() { return loaded; },
  };
}

export async function fetchTerminalConfig() {
  try {
    const config = await getTerminalConfig();
    terminals = config.terminals;
    selectedTerminal = config.preferred;
    interactiveSession = config.interactiveSession;
    loaded = true;
  } catch (err) {
    console.error('Failed to fetch terminal config:', err);
  }
}

export async function detectTerminals() {
  analyzing = true;
  try {
    terminals = await analyzeTerminals();
  } catch (err) {
    console.error('Failed to analyze terminals:', err);
  } finally {
    analyzing = false;
  }
}

export async function selectTerminal(terminal: TerminalId) {
  try {
    await setTerminalConfig(terminal);
    selectedTerminal = terminal;
  } catch (err) {
    console.error('Failed to set terminal:', err);
  }
}

export async function selectInteractiveSession(enabled: boolean) {
  try {
    await setTerminalInteractiveConfig(enabled);
    interactiveSession = enabled;
  } catch (err) {
    console.error('Failed to set interactive terminal mode:', err);
  }
}
