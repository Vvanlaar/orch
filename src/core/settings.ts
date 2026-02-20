import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { Terminal, TerminalId } from './types.js';
import { config } from './config.js';

const SETTINGS_FILE = join(process.cwd(), '.orch-settings.json');

interface Settings {
  preferredTerminal?: TerminalId;
  terminalInteractiveSession?: boolean;
}

const isWindows = process.platform === 'win32';

const KNOWN_TERMINALS: Terminal[] = [
  { id: 'auto', name: 'Auto (System Default)', cmd: null },
  // Windows
  { id: 'wt', name: 'Windows Terminal', cmd: 'wt' },
  { id: 'cmd', name: 'Command Prompt', cmd: 'cmd' },
  { id: 'powershell', name: 'PowerShell', cmd: 'powershell' },
  { id: 'pwsh', name: 'PowerShell Core', cmd: 'pwsh' },
  { id: 'git-bash', name: 'Git Bash', cmd: 'bash' },
  // Linux
  { id: 'gnome-terminal', name: 'GNOME Terminal', cmd: 'gnome-terminal' },
  { id: 'xterm', name: 'XTerm', cmd: 'xterm' },
  { id: 'tmux', name: 'tmux', cmd: 'tmux' },
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

export function getTerminalInteractiveSession(): boolean {
  const settings = loadSettings();
  return settings.terminalInteractiveSession ?? true;
}

export function setTerminalInteractiveSession(interactive: boolean): void {
  const settings = loadSettings();
  settings.terminalInteractiveSession = interactive;
  saveSettings(settings);
}

export function detectAvailableTerminals(): Terminal[] {
  return KNOWN_TERMINALS.map(t => ({
    ...t,
    available: t.cmd === null ? true : isTerminalAvailable(t.cmd),
  }));
}

const KNOWN_TERMINAL_PATHS: Record<string, string[]> = {
  pwsh: [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  ],
  wt: [
    `${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\wt.exe`,
  ],
};

function isTerminalAvailable(cmd: string): boolean {
  try {
    const whichCmd = isWindows ? `where ${cmd}` : `which ${cmd}`;
    execSync(whichCmd, { stdio: 'ignore' });
    return true;
  } catch {
    const paths = KNOWN_TERMINAL_PATHS[cmd];
    return paths?.some(p => existsSync(p)) ?? false;
  }
}

export function findTerminalPath(cmd: string): string | null {
  const paths = KNOWN_TERMINAL_PATHS[cmd];
  return paths?.find(p => existsSync(p)) ?? null;
}

export function getKnownTerminals(): Terminal[] {
  return KNOWN_TERMINALS;
}

export function isWindowsPlatform(): boolean {
  return isWindows;
}
