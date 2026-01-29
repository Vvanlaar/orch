import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { Terminal, TerminalId } from './types.js';
import { config } from './config.js';

const SETTINGS_FILE = join(process.cwd(), '.orch-settings.json');

interface Settings {
  preferredTerminal?: TerminalId;
}

const KNOWN_TERMINALS: Terminal[] = [
  { id: 'auto', name: 'Auto (System Default)', cmd: null },
  { id: 'wt', name: 'Windows Terminal', cmd: 'wt' },
  { id: 'cmd', name: 'Command Prompt', cmd: 'cmd' },
  { id: 'powershell', name: 'PowerShell', cmd: 'powershell' },
  { id: 'pwsh', name: 'PowerShell Core', cmd: 'pwsh' },
  { id: 'git-bash', name: 'Git Bash', cmd: 'bash' },
];

function loadSettings(): Settings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

function saveSettings(settings: Settings): void {
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function getTerminalPreference(): TerminalId {
  const settings = loadSettings();
  return settings.preferredTerminal ?? config.claude.preferredTerminal;
}

export function setTerminalPreference(terminal: TerminalId): void {
  const settings = loadSettings();
  settings.preferredTerminal = terminal;
  saveSettings(settings);
}

export function detectAvailableTerminals(): Terminal[] {
  return KNOWN_TERMINALS.map(t => ({
    ...t,
    available: t.cmd === null ? true : isTerminalAvailable(t.cmd),
  }));
}

function isTerminalAvailable(cmd: string): boolean {
  try {
    execSync(`where ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getKnownTerminals(): Terminal[] {
  return KNOWN_TERMINALS;
}
