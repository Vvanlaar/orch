import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { Terminal, TerminalId } from './types.js';
import { config } from './config.js';
import { isSupabaseConfigured } from './db/client.js';
import { dbGetSetting, dbSetSetting } from './db/settings.js';

const SETTINGS_FILE = join(process.cwd(), '.orch-settings.json');

interface Settings {
  preferredTerminal?: TerminalId;
  terminalInteractiveSession?: boolean;
}

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const KNOWN_TERMINALS: Terminal[] = [
  { id: 'auto', name: 'Auto (System Default)', cmd: null },
  // Windows
  { id: 'wt', name: 'Windows Terminal', cmd: 'wt' },
  { id: 'cmd', name: 'Command Prompt', cmd: 'cmd' },
  { id: 'powershell', name: 'PowerShell', cmd: 'powershell' },
  { id: 'pwsh', name: 'PowerShell Core', cmd: 'pwsh' },
  { id: 'git-bash', name: 'Git Bash', cmd: 'bash' },
  // macOS
  { id: 'terminal-app', name: 'Terminal', cmd: 'open' },
  { id: 'iterm2', name: 'iTerm2', cmd: 'osascript' },
  // Linux
  { id: 'gnome-terminal', name: 'GNOME Terminal', cmd: 'gnome-terminal' },
  { id: 'xterm', name: 'XTerm', cmd: 'xterm' },
  { id: 'tmux', name: 'tmux', cmd: 'tmux' },
];

// ── JSON fallback ──

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

// ── Cached in-memory settings (avoid async in hot path) ──
// Settings are loaded from DB on startup and cached. Writes go to both cache and DB.
let cachedSettings: Settings | null = null;

export async function initSettings(): Promise<void> {
  if (!isSupabaseConfigured()) {
    cachedSettings = loadSettings();
    return;
  }
  try {
    const [terminal, interactive] = await Promise.all([
      dbGetSetting('preferredTerminal') as Promise<TerminalId | null>,
      dbGetSetting('terminalInteractiveSession') as Promise<boolean | null>,
    ]);
    cachedSettings = {
      preferredTerminal: terminal ?? undefined,
      terminalInteractiveSession: interactive ?? undefined,
    };
  } catch {
    cachedSettings = loadSettings(); // fallback to file
  }
}

function getSettings(): Settings {
  if (!cachedSettings) cachedSettings = loadSettings();
  return cachedSettings;
}

export function getTerminalPreference(): TerminalId {
  return getSettings().preferredTerminal ?? config.claude.preferredTerminal;
}

export function setTerminalPreference(terminal: TerminalId): void {
  const settings = getSettings();
  settings.preferredTerminal = terminal;
  cachedSettings = settings;
  if (isSupabaseConfigured()) {
    dbSetSetting('preferredTerminal', terminal).catch(() => {});
  }
  saveSettings(settings); // also save to file as fallback
}

export function getTerminalInteractiveSession(): boolean {
  return getSettings().terminalInteractiveSession ?? true;
}

export function setTerminalInteractiveSession(interactive: boolean): void {
  const settings = getSettings();
  settings.terminalInteractiveSession = interactive;
  cachedSettings = settings;
  if (isSupabaseConfigured()) {
    dbSetSetting('terminalInteractiveSession', interactive).catch(() => {});
  }
  saveSettings(settings);
}

export function detectAvailableTerminals(): Terminal[] {
  return KNOWN_TERMINALS.map(t => ({
    ...t,
    available: t.cmd === null ? true : isTerminalAvailable(t.id, t.cmd),
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
  'terminal-app': ['/System/Applications/Utilities/Terminal.app'],
  'iterm2': ['/Applications/iTerm.app'],
};

function isTerminalAvailable(id: string, cmd: string): boolean {
  // macOS app bundles: check existence instead of `which`
  const bundlePaths = KNOWN_TERMINAL_PATHS[id];
  if (isMac && bundlePaths?.some(p => p.endsWith('.app'))) {
    return bundlePaths.some(p => existsSync(p));
  }
  try {
    const whichCmd = isWindows ? `where ${cmd}` : `which ${cmd}`;
    execSync(whichCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return bundlePaths?.some(p => existsSync(p)) ?? false;
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

export function isMacPlatform(): boolean {
  return isMac;
}
