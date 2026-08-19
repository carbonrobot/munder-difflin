/**
 * WSL2 as a spawn target.
 *
 * On Windows the agent CLI is spawned through `cmd.exe /d /s /c "<one string>"`
 * whenever it cannot be decoded to a real interpreter (see pty.ts). That path is
 * lossy in a way that silently breaks the hive protocol: cmd.exe treats CR/LF as
 * a statement separator, so the multi-line `--append-system-prompt` block is cut
 * at its first newline and the agent boots healthy having never learned that
 * inbox/outbox exist.
 *
 * Routing through `wsl.exe -e` sidesteps the shell entirely — argv is handed to
 * execvp inside the distro, so newlines, quotes and parens survive verbatim.
 *
 * TWO traps this module exists to close:
 *
 *  1. **Windows PATH leaks into WSL.** WSL appends the Windows PATH by default,
 *     so a *login* shell inside Ubuntu resolves `claude` to
 *     `/mnt/c/nvm4w/nodejs/claude` — the WINDOWS binary — and `node` to nothing
 *     at all when nvm initialises from .bashrc. Spawning that from a Linux PTY is
 *     a cross-OS mess. Every PATH this module hands out is stripped of `/mnt/*`.
 *
 *  2. **`wsl.exe -l -v` speaks UTF-16LE.** Read it as utf8 and every character
 *     arrives NUL-separated, so a naive parse yields one garbage distro named
 *     "U\0b\0u\0n\0t\0u". decodeWslOutput sniffs and decodes.
 */

/** Windows path to wsl.exe. Absolute on purpose: PATH lookup from an Electron
 *  main process is not guaranteed to include System32. */
export const WSL_EXE = 'C:\\Windows\\System32\\wsl.exe';

export interface WslDistro {
  name: string;
  state: string;
  version: number;
  /** The `*`-marked default distro in `wsl -l -v`. */
  isDefault: boolean;
}

export interface WslSpawnOptions {
  distro: string;
  /** Linux user to run as. Unset = the distro's configured default user. */
  user?: string;
  /** Working directory, as a LINUX path. */
  cwd?: string;
  /** Absolute Linux path to the executable. MUST already be resolved — `-e` does
   *  no shell lookup, and the default in-distro PATH would find the Windows
   *  binary on /mnt/c first (trap 1 above). */
  command: string;
  args?: string[];
  /** Extra environment for the child, applied via /usr/bin/env. */
  env?: Record<string, string>;
  /** Clean (de-/mnt-ed) PATH to export for the child, so tools the agent itself
   *  shells out to — git, node — resolve to their Linux builds. */
  path?: string;
}

/**
 * PURE. Decode raw wsl.exe stdout. WSL writes UTF-16LE for its informational
 * commands (`-l -v`, `--status`) but UTF-8 for a program's own output, and which
 * you get has varied across builds — so sniff rather than assume. A UTF-16LE
 * ASCII payload is half NUL bytes; UTF-8 has none.
 */
export function decodeWslOutput(buf: Buffer): string {
  if (buf.length === 0) return '';
  let nuls = 0;
  const probe = Math.min(buf.length, 256);
  for (let i = 0; i < probe; i++) if (buf[i] === 0) nuls++;
  const text = nuls > probe / 4 ? buf.toString('utf16le') : buf.toString('utf8');
  // Strip a BOM and normalise CRLF; wsl.exe emits both.
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/**
 * PURE. Parse `wsl.exe -l -v`.
 *
 * Distro names may contain spaces ("Ubuntu 22.04 LTS"), so this anchors on the
 * two fixed trailing columns and takes everything before them as the name — a
 * naive whitespace split would shear such a name in half.
 */
export function parseDistroList(raw: string): WslDistro[] {
  const out: WslDistro[] = [];
  for (const line of decodeCRLF(raw).split('\n')) {
    const m = /^(\*?)\s*(.+?)\s{2,}(\S+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const [, star, name, state, version] = m;
    if (name === 'NAME') continue; // header
    out.push({ name, state, version: Number(version), isDefault: star === '*' });
  }
  return out;
}

function decodeCRLF(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * PURE. Docker Desktop registers two internal distros that are not usable shells.
 * Offering them in a picker is a support ticket waiting to happen.
 */
export function isSelectableDistro(d: WslDistro): boolean {
  return d.version === 2 && !/^docker-desktop(-data)?$/i.test(d.name);
}

/**
 * PURE. Remove Windows-interop entries from a WSL PATH.
 *
 * This is the correctness guarantee of the whole feature: with 17 `/mnt/c/...`
 * entries on a stock login PATH, `claude`, `npm` and friends resolve to Windows
 * executables. Dropping them means an agent — and everything the agent shells out
 * to — can only ever find Linux builds.
 */
export function stripWindowsPathEntries(pathVar: string, mountRoot = '/mnt'): string {
  const prefix = mountRoot.endsWith('/') ? mountRoot : `${mountRoot}/`;
  return pathVar
    .split(':')
    .filter((e) => e && !e.startsWith(prefix))
    .join(':');
}

/**
 * PURE. Translate a path into the distro's namespace.
 *
 * Handles the three shapes a cwd can arrive in on a Windows host:
 *   C:\dev\proj                      → /mnt/c/dev/proj
 *   \\wsl.localhost\Ubuntu\home\me   → /home/me      (already inside the distro)
 *   /home/me/proj                    → unchanged
 */
export function toWslPath(p: string, mountRoot = '/mnt'): string {
  if (!p) return p;
  const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i.exec(p);
  if (unc) return (unc[1] ?? '\\').replace(/\\/g, '/') || '/';
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/');
    return `${mountRoot}/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  return p.replace(/\\/g, '/');
}

/**
 * PURE. Build the wsl.exe invocation.
 *
 * `-e` and not `--` deliberately: `--` hands the remainder to a shell, which
 * re-parses it and puts us straight back in the quoting swamp cmd.exe already
 * taught us about. `-e` execs directly, so argv is byte-exact — verified against
 * a literal newline surviving the round trip.
 *
 * Environment rides on /usr/bin/env rather than WSLENV: WSLENV needs a var to
 * exist on the Windows side and encodes translation flags per name, which is a
 * poor fit for per-agent values that are already plain Linux strings.
 */
export function buildWslSpawn(opts: WslSpawnOptions): { file: string; args: string[] } {
  if (!opts.distro) throw new Error('buildWslSpawn: distro is required');
  if (!opts.command) throw new Error('buildWslSpawn: command must be an absolute Linux path');
  const args: string[] = ['-d', opts.distro];
  if (opts.user) args.push('-u', opts.user);
  if (opts.cwd) args.push('--cd', toWslPath(opts.cwd));
  args.push('-e');

  const envPairs: string[] = [];
  if (opts.path) envPairs.push(`PATH=${stripWindowsPathEntries(opts.path)}`);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    // A NUL or newline in a var NAME cannot be expressed; skip rather than
    // corrupt the argv that follows it.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    envPairs.push(`${k}=${v}`);
  }
  if (envPairs.length) args.push('/usr/bin/env', ...envPairs);

  args.push(opts.command, ...(opts.args ?? []));
  return { file: WSL_EXE, args };
}

/** Sentinels wrapping the probed PATH. An INTERACTIVE shell sources .bashrc,
 *  which on a real machine prints banners (figlet, neofetch, motd, fortune) to
 *  STDOUT — the captured value is therefore never clean. Observed in the wild:
 *  a figlet banner whose ASCII art contains an apostrophe, which broke naive
 *  quoting downstream. Delimit and extract instead of trusting the stream. */
export const PATH_PROBE_BEGIN = '__MD_PATH_BEGIN__';
export const PATH_PROBE_END = '__MD_PATH_END__';

/**
 * PURE. Build the argv that captures a usable PATH from inside the distro.
 *
 * `-ic` (INTERACTIVE) and not `-lc`: nvm, fnm, asdf and mise all initialise from
 * .bashrc, which a login shell never sources. On a stock setup `bash -lc` reports
 * no `node` whatsoever and a Windows `claude`; `bash -ic` reports both correctly.
 */
export function buildWslPathProbe(distro: string, user?: string): { file: string; args: string[] } {
  const args = ['-d', distro];
  if (user) args.push('-u', user);
  args.push('-e', 'bash', '-ic', `printf '%s%s%s' '${PATH_PROBE_BEGIN}' "$PATH" '${PATH_PROBE_END}'`);
  return { file: WSL_EXE, args };
}

/**
 * PURE. Pull the PATH out of a probe's stdout, discarding any rc-file banner.
 * Returns null when the markers are absent (probe failed / shell died), so the
 * caller can fall back rather than export a PATH made of ASCII art.
 */
export function extractProbedPath(raw: string): string | null {
  const start = raw.indexOf(PATH_PROBE_BEGIN);
  const end = raw.indexOf(PATH_PROBE_END, start + 1);
  if (start < 0 || end < 0) return null;
  const value = raw.slice(start + PATH_PROBE_BEGIN.length, end).trim();
  return value || null;
}

/**
 * PURE. Build the argv that resolves a command against an explicit clean PATH.
 *
 * PATH rides on /usr/bin/env as its own argv element rather than being
 * interpolated into the shell string. A PATH is arbitrary text from the user's
 * machine; interpolating it means one apostrophe in one directory name silently
 * produces a malformed script and a "command not found" that looks like a
 * missing CLI. env sidesteps quoting entirely.
 */
export function buildWslWhich(
  distro: string,
  command: string,
  cleanPath: string,
  user?: string
): { file: string; args: string[] } {
  const args = ['-d', distro];
  if (user) args.push('-u', user);
  const safe = command.replace(/'/g, "'\\''");
  args.push('-e', '/usr/bin/env', `PATH=${cleanPath}`, 'bash', '-c', `command -v '${safe}'`);
  return { file: WSL_EXE, args };
}

/**
 * PURE. Pick the distro a first run should preselect: the `*` default when it is
 * selectable, else the first selectable one, else null.
 */
export function pickDefaultDistro(distros: WslDistro[]): WslDistro | null {
  const usable = distros.filter(isSelectableDistro);
  return usable.find((d) => d.isDefault) ?? usable[0] ?? null;
}

// --- target selection ---------------------------------------------------------

/** The subset of HarnessConfig this module needs. Declared structurally rather
 *  than imported so wsl.ts stays free of the config module (and of electron),
 *  which is what keeps the decision unit-testable on any platform. */
export interface TerminalTargetConfig {
  terminalTarget?: 'auto' | 'windows' | 'wsl';
  wslDistro?: string;
  wslUser?: string;
  terminalTargetChosen?: boolean;
}

export interface TargetDecision {
  /** 'native' = today's path for this OS (cmd.exe/shim on Windows, $SHELL on unix). */
  mode: 'native' | 'wsl';
  distro?: string;
  user?: string;
  /** True when WSL exists, the user has never answered, and we are therefore
   *  running native by default. The UI asks ONCE and records the answer; we do
   *  not silently move an existing user's agents to another filesystem. */
  needsChoice: boolean;
  /** Why we landed here. Surfaced in diagnostics and in the terminal when a
   *  configured target had to be abandoned - a silent fallback to cmd.exe is
   *  exactly the failure mode this whole feature exists to remove. */
  reason: string;
}

/**
 * PURE. Decide where a terminal should run.
 *
 * `distros` is passed in (rather than detected here) so the decision can be
 * tested against any machine shape, including "Windows with no WSL at all".
 */
export function resolveWslTarget(
  cfg: TerminalTargetConfig,
  platform: string,
  distros: WslDistro[]
): TargetDecision {
  // macOS/Linux already ARE the unix path; WSL is a Windows-only concept.
  if (platform !== 'win32') {
    return { mode: 'native', needsChoice: false, reason: 'not a Windows host' };
  }
  const usable = distros.filter(isSelectableDistro);

  if (cfg.terminalTarget === 'wsl') {
    if (!usable.length) {
      return { mode: 'native', needsChoice: false, reason: 'WSL selected but no usable v2 distro was found' };
    }
    // A distro can be uninstalled or renamed after being persisted. Fall back
    // LOUDLY rather than spawning into a distro the user did not pick.
    const named = cfg.wslDistro ? usable.find((d) => d.name === cfg.wslDistro) : null;
    if (cfg.wslDistro && !named) {
      return {
        mode: 'native',
        needsChoice: false,
        reason: `WSL distro "${cfg.wslDistro}" is no longer installed`
      };
    }
    const chosen = named ?? pickDefaultDistro(usable);
    if (!chosen) {
      return { mode: 'native', needsChoice: false, reason: 'WSL selected but no distro could be chosen' };
    }
    return { mode: 'wsl', distro: chosen.name, user: cfg.wslUser, needsChoice: false, reason: 'WSL selected' };
  }

  if (cfg.terminalTarget === 'windows') {
    return { mode: 'native', needsChoice: false, reason: 'Windows selected' };
  }

  // 'auto' or unset: run native, but tell the UI to ask when WSL is actually
  // there and the question has never been put to the user.
  return {
    mode: 'native',
    needsChoice: usable.length > 0 && cfg.terminalTargetChosen !== true,
    reason: usable.length ? 'no target chosen yet' : 'no WSL distro available'
  };
}

// --- impure: talking to the real wsl.exe -------------------------------------
// Everything above this line is pure and unit-tested on any platform. Below, we
// actually shell out - so each call is guarded, timed out, and cached, because a
// cold distro can take seconds to answer and this sits in the spawn path.

import { spawnSync } from 'node:child_process';

/** A wsl.exe call's decoded result. `ok` is false for a non-zero exit OR a
 *  spawn that never ran (wsl.exe absent - i.e. not a WSL-capable host). */
interface WslResult { ok: boolean; stdout: string; stderr: string }

function runWsl(args: string[], timeout = 20_000): WslResult {
  try {
    const r = spawnSync(WSL_EXE, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (r.error) return { ok: false, stdout: '', stderr: String(r.error.message ?? r.error) };
    return {
      ok: r.status === 0,
      stdout: decodeWslOutput(r.stdout ?? Buffer.alloc(0)),
      stderr: decodeWslOutput(r.stderr ?? Buffer.alloc(0))
    };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** True only on a Windows host that actually has WSL with a usable v2 distro.
 *  Everything else - macOS, Linux, Windows without WSL, WSL1-only - is false, so
 *  callers can treat WSL mode as simply unavailable rather than special-casing. */
export function wslAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  return detectDistros().length > 0;
}

let distroCache: WslDistro[] | null = null;

/** Selectable v2 distros, docker-desktop internals excluded. Cached for the
 *  process: a user who installs a distro mid-session can re-detect from Settings. */
export function detectDistros(force = false): WslDistro[] {
  if (!force && distroCache) return distroCache;
  if (process.platform !== 'win32') return (distroCache = []);
  const res = runWsl(['-l', '-v']);
  distroCache = res.ok ? parseDistroList(res.stdout).filter(isSelectableDistro) : [];
  return distroCache;
}

/** Drop cached detection + resolution. Call after the user changes distro/user in
 *  Settings, or asks to re-scan. */
export function clearWslCache(): void {
  distroCache = null;
  pathCache.clear();
  whichCache.clear();
}

const pathCache = new Map<string, string>();

/**
 * The distro's PATH with every Windows-interop entry removed.
 *
 * Cached per distro+user: the probe runs an INTERACTIVE bash (to pick up
 * nvm/asdf/mise from .bashrc) which is slow enough - and noisy enough - that
 * doing it on every spawn would be felt. Returns '' when the probe fails, which
 * callers must treat as "could not resolve" rather than "empty PATH".
 */
export function captureWslPath(distro: string, user?: string): string {
  const key = `${distro} ${user ?? ''}`;
  const hit = pathCache.get(key);
  if (hit !== undefined) return hit;
  const probe = buildWslPathProbe(distro, user);
  const res = runWsl(probe.args);
  // extractProbedPath, not a raw trim: .bashrc banners print to stdout and one
  // observed figlet banner contained an apostrophe.
  const value = res.ok ? extractProbedPath(res.stdout) : null;
  const clean = value ? stripWindowsPathEntries(value) : '';
  pathCache.set(key, clean);
  return clean;
}

const whichCache = new Map<string, string | null>();

/**
 * Resolve a command to an absolute path INSIDE the distro, searching only the
 * cleaned PATH. Returns null when it is genuinely not installed in Linux -
 * which is the answer we want, rather than silently falling back to the Windows
 * build sitting on /mnt/c.
 */
export function resolveWslCommand(distro: string, command: string, user?: string): string | null {
  if (command.startsWith('/')) return command; // already absolute in-distro
  const key = `${distro} ${user ?? ''} ${command}`;
  const hit = whichCache.get(key);
  if (hit !== undefined) return hit;
  const cleanPath = captureWslPath(distro, user);
  if (!cleanPath) { whichCache.set(key, null); return null; }
  const res = runWsl(buildWslWhich(distro, command, cleanPath, user).args);
  const lines = res.ok ? res.stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const line = lines.length ? lines[lines.length - 1] : '';
  // `command -v` prints a path for an external binary; a shell builtin or alias
  // would print a bare word, which is not something we can exec.
  const resolved = line.startsWith('/') ? line : null;
  whichCache.set(key, resolved);
  return resolved;
}
