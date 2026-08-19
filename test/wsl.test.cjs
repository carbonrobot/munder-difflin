'use strict';

/**
 * WSL2 SPAWN TARGET.
 *
 * The Windows spawn path routes through `cmd.exe /d /s /c "<string>"` whenever an
 * npm shim cannot be decoded, and cmd.exe cuts a multi-line argument at its first
 * newline — which is how a Windows agent boots healthy having never received the
 * hive protocol (see win-cmd-shim.test.cjs for that story). Routing through
 * `wsl.exe -e` execs directly with no shell in between, so argv survives.
 *
 * Fixtures here are REAL output captured from a Windows-on-ARM host running
 * Ubuntu under WSL2, including the Windows-PATH leak that makes a login shell
 * resolve `claude` to a Windows binary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  decodeWslOutput, parseDistroList, isSelectableDistro, stripWindowsPathEntries,
  toWslPath, buildWslSpawn, buildWslPathProbe, buildWslWhich, pickDefaultDistro,
  extractProbedPath, PATH_PROBE_BEGIN, PATH_PROBE_END, WSL_EXE, resolveWslTarget
} = loadTs('src/main/wsl.ts');

// The REAL escaper node-pty applies to an argv array on Windows — the same module
// win-cmd-shim.test.cjs reaches into. Testing a copy would prove nothing.
const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent.js');

/** Verbatim `wsl.exe -l -v` from the host, as UTF-16LE bytes. */
const DISTRO_LIST_RAW =
  '  NAME                   STATE           VERSION\n' +
  '* Ubuntu                 Running         2\n' +
  '  docker-desktop-data    Stopped         2\n' +
  '  docker-desktop         Stopped         2\n';

/** A stock WSL login PATH: nvm's bin, then 17 Windows interop entries. */
const LEAKY_PATH = [
  '/root/.nvm/versions/node/v24.13.1/bin', '/usr/local/sbin', '/usr/local/bin',
  '/usr/sbin', '/usr/bin', '/sbin', '/bin',
  '/mnt/c/WINDOWS/system32', '/mnt/c/WINDOWS', '/mnt/c/Program Files/Git/cmd',
  '/mnt/c/nvm4w/nodejs', '/mnt/c/Users/carbo/AppData/Local/nvm'
].join(':');

// ── decoding ────────────────────────────────────────────────────────────────

test('decodeWslOutput decodes UTF-16LE, which is what -l -v emits', () => {
  const buf = Buffer.from('\uFEFF' + DISTRO_LIST_RAW, 'utf16le');
  const text = decodeWslOutput(buf);
  assert.ok(text.includes('Ubuntu'), 'Ubuntu should survive decoding');
  assert.ok(!text.includes('\u0000'), 'no NUL bytes should remain');
  assert.ok(!text.startsWith('\uFEFF'), 'BOM should be stripped');
});

test('decodeWslOutput leaves UTF-8 program output alone', () => {
  assert.equal(decodeWslOutput(Buffer.from('hello\n', 'utf8')), 'hello\n');
});

test('decodeWslOutput handles an empty buffer', () => {
  assert.equal(decodeWslOutput(Buffer.alloc(0)), '');
});

// ── distro listing ──────────────────────────────────────────────────────────

test('parseDistroList reads the real -l -v table', () => {
  const list = parseDistroList(DISTRO_LIST_RAW);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { name: 'Ubuntu', state: 'Running', version: 2, isDefault: true });
  assert.equal(list[1].name, 'docker-desktop-data');
  assert.equal(list[1].isDefault, false);
});

test('parseDistroList keeps spaces inside a distro name', () => {
  const list = parseDistroList('* Ubuntu 22.04 LTS       Running         2\n');
  assert.equal(list[0].name, 'Ubuntu 22.04 LTS');
  assert.equal(list[0].version, 2);
});

test('parseDistroList skips the header row', () => {
  assert.ok(!parseDistroList(DISTRO_LIST_RAW).some((d) => d.name === 'NAME'));
});

test('isSelectableDistro rejects the docker-desktop internals and WSL1', () => {
  const list = parseDistroList(DISTRO_LIST_RAW).filter(isSelectableDistro);
  assert.deepEqual(list.map((d) => d.name), ['Ubuntu']);
  assert.equal(isSelectableDistro({ name: 'Legacy', state: 'Stopped', version: 1, isDefault: false }), false);
});

test('pickDefaultDistro prefers the starred distro, ignoring docker', () => {
  assert.equal(pickDefaultDistro(parseDistroList(DISTRO_LIST_RAW)).name, 'Ubuntu');
  assert.equal(pickDefaultDistro([]), null);
});

// ── the PATH leak: the correctness guarantee ────────────────────────────────

test('stripWindowsPathEntries removes every /mnt entry and keeps Linux ones', () => {
  const clean = stripWindowsPathEntries(LEAKY_PATH);
  assert.ok(!clean.split(':').some((e) => e.startsWith('/mnt/')), 'no /mnt entries may survive');
  assert.ok(clean.includes('/root/.nvm/versions/node/v24.13.1/bin'), 'nvm bin must survive');
  assert.ok(clean.includes('/usr/bin'));
});

test('stripWindowsPathEntries drops empty segments rather than emitting ::', () => {
  assert.equal(stripWindowsPathEntries('/usr/bin::/bin'), '/usr/bin:/bin');
});

test('stripWindowsPathEntries honours a non-default mount root', () => {
  assert.equal(stripWindowsPathEntries('/usr/bin:/win/c/WINDOWS', '/win'), '/usr/bin');
});

// ── path translation ────────────────────────────────────────────────────────

test('toWslPath maps a drive path onto /mnt', () => {
  assert.equal(toWslPath('C:\\dev\\proj'), '/mnt/c/dev/proj');
  assert.equal(toWslPath('D:/data'), '/mnt/d/data');
  assert.equal(toWslPath('C:\\'), '/mnt/c');
});

test('toWslPath unwraps a \\\\wsl.localhost UNC path to its in-distro path', () => {
  assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj'), '/home/me/proj');
  assert.equal(toWslPath('\\\\wsl$\\Ubuntu\\home\\me'), '/home/me');
});

test('toWslPath passes an existing Linux path through untouched', () => {
  assert.equal(toWslPath('/home/me/proj'), '/home/me/proj');
});

// ── spawn construction ──────────────────────────────────────────────────────

test('buildWslSpawn uses -e (exec, no shell), never --', () => {
  const { file, args } = buildWslSpawn({
    distro: 'Ubuntu', user: 'root', cwd: '/home/me', command: '/usr/local/bin/claude'
  });
  assert.equal(file, WSL_EXE);
  assert.deepEqual(args, ['-d', 'Ubuntu', '-u', 'root', '--cd', '/home/me', '-e', '/usr/local/bin/claude']);
  assert.ok(!args.includes('--'), '`--` would hand the command to a shell and re-open the quoting swamp');
});

test('buildWslSpawn translates a Windows cwd on the way in', () => {
  const { args } = buildWslSpawn({ distro: 'Ubuntu', cwd: 'C:\\dev\\proj', command: '/usr/bin/claude' });
  assert.equal(args[args.indexOf('--cd') + 1], '/mnt/c/dev/proj');
});

test('buildWslSpawn carries a MULTI-LINE argument byte-exactly — the whole point', () => {
  const protocol = 'HIVE PROTOCOL\n\nYou have an inbox/ and an outbox/.\n"quoted" & (parens) | pipes ^ carets';
  const { args } = buildWslSpawn({
    distro: 'Ubuntu', command: '/usr/bin/claude', args: ['--append-system-prompt', protocol]
  });
  assert.equal(args[args.length - 1], protocol, 'the prompt must survive unmodified');
  assert.ok(args[args.length - 1].includes('\n'), 'and must still contain its newlines');
});

test('a multi-line arg survives node-pty\'s Windows escaper as one argument', () => {
  // On Windows node-pty runs argsToCommandLine (MSDN/CRT escaping) over an argv
  // ARRAY and hands the result to CreateProcess with no shell in between, so
  // wsl.exe's own CRT parser recovers the argument intact. This is the same
  // mechanism win-cmd-shim.test.cjs relies on, asserted here for the WSL argv.
  const protocol = 'line one\nline two';
  const { file, args } = buildWslSpawn({
    distro: 'Ubuntu', command: '/usr/bin/claude', args: ['--append-system-prompt', protocol]
  });
  // argsToCommandLine(file, args) — the two-arg form node-pty actually calls.
  const cmdline = argsToCommandLine(file, args);
  assert.ok(cmdline.includes('\n'), 'the newline is preserved in the command line');
  assert.ok(/"line one\nline two"/.test(cmdline), 'and is wrapped in ONE quoted argument');
  assert.equal((cmdline.match(/--append-system-prompt/g) || []).length, 1);
});

test('buildWslSpawn exports a cleaned PATH so the agent\'s own git/node are Linux', () => {
  const { args } = buildWslSpawn({
    distro: 'Ubuntu', command: '/usr/bin/claude', path: LEAKY_PATH, env: { AGENT_ID: 'a1' }
  });
  const envIdx = args.indexOf('/usr/bin/env');
  assert.ok(envIdx > 0, 'env should be used to carry PATH + per-agent vars');
  const pathArg = args.find((a) => a.startsWith('PATH='));
  assert.ok(pathArg && !pathArg.includes('/mnt/'), 'the exported PATH must have no Windows entries');
  assert.ok(args.includes('AGENT_ID=a1'));
  // env vars must precede the executable, or they become its arguments.
  assert.ok(args.indexOf('AGENT_ID=a1') < args.indexOf('/usr/bin/claude'));
});

test('buildWslSpawn skips an env var whose NAME cannot be expressed', () => {
  const { args } = buildWslSpawn({
    distro: 'Ubuntu', command: '/usr/bin/claude', env: { GOOD: '1', 'BAD NAME': 'x', 'BAD=EQ': 'y' }
  });
  assert.ok(args.includes('GOOD=1'));
  assert.ok(!args.some((a) => a.startsWith('BAD')), 'a malformed name would corrupt the argv after it');
});

test('buildWslSpawn refuses to guess a missing distro or command', () => {
  assert.throws(() => buildWslSpawn({ distro: '', command: '/usr/bin/claude' }), /distro is required/);
  assert.throws(() => buildWslSpawn({ distro: 'Ubuntu', command: '' }), /absolute Linux path/);
});

// ── probes ──────────────────────────────────────────────────────────────────

test('buildWslPathProbe uses an INTERACTIVE shell, because nvm lives in .bashrc', () => {
  const { args } = buildWslPathProbe('Ubuntu', 'root');
  assert.ok(args.includes('-ic'), 'bash -lc reports no node at all on a stock nvm setup');
  assert.ok(!args.includes('-lc'));
  assert.match(args[args.length - 1], /__MD_PATH_BEGIN__/);
});

// A REAL .bashrc banner captured from the host: figlet ASCII art printed to
// stdout, containing an apostrophe. Interpolating this into a quoted shell
// string produced a malformed script and a bogus "command not found".
const BANNER = [
  '                _                           _           _   ',
  '               | |                         | |         | |  ',
  "  ___ __ _ _ __| |__   ___  _ __  _ __ ___ | |__   ___ | |_ ",
  " / __/ _` | '__| '_ \\ / _ \\| '_ \\| '__/ _ \\| '_ \\ / _ \\| ",
  ''
].join('\n');

test('extractProbedPath ignores an rc-file banner and returns only the PATH', () => {
  const raw = `${BANNER}${PATH_PROBE_BEGIN}/usr/bin:/bin${PATH_PROBE_END}`;
  assert.equal(extractProbedPath(raw), '/usr/bin:/bin');
});

test('extractProbedPath survives a banner containing an apostrophe', () => {
  assert.ok(BANNER.includes("'"), 'fixture must contain the character that broke quoting');
  const raw = `${BANNER}${PATH_PROBE_BEGIN}/usr/bin${PATH_PROBE_END}\n`;
  assert.equal(extractProbedPath(raw), '/usr/bin');
});

test('extractProbedPath returns null when the probe produced no markers', () => {
  assert.equal(extractProbedPath(BANNER), null);
  assert.equal(extractProbedPath(''), null);
  assert.equal(extractProbedPath(`${PATH_PROBE_BEGIN}${PATH_PROBE_END}`), null);
});

test('buildWslWhich passes PATH via env, never interpolated into the shell', () => {
  const { args } = buildWslWhich('Ubuntu', 'claude', "/opt/o'brien/bin:/usr/bin", 'root');
  assert.ok(args.includes('/usr/bin/env'), 'env carries PATH as its own argv element');
  assert.ok(args.includes("PATH=/opt/o'brien/bin:/usr/bin"), 'an apostrophe in PATH must not be escaped or split');
  assert.equal(args[args.length - 1], "command -v 'claude'");
});

test('buildWslWhich escapes a quote in the command name', () => {
  const { args } = buildWslWhich('Ubuntu', "od'd", '/usr/bin');
  assert.match(args[args.length - 1], /command -v 'od'\\''d'/);
});

// -- target selection --------------------------------------------------------

const UBUNTU = { name: 'Ubuntu', state: 'Running', version: 2, isDefault: true };
const DOCKER = { name: 'docker-desktop', state: 'Stopped', version: 2, isDefault: false };

test('resolveWslTarget never engages WSL off Windows', () => {
  for (const platform of ['darwin', 'linux']) {
    const d = resolveWslTarget({ terminalTarget: 'wsl', wslDistro: 'Ubuntu' }, platform, [UBUNTU]);
    assert.equal(d.mode, 'native', platform + ' must keep its own native path');
    assert.equal(d.needsChoice, false);
  }
});

test('resolveWslTarget: an unset target runs native but ASKS when WSL exists', () => {
  const d = resolveWslTarget({}, 'win32', [UBUNTU]);
  assert.equal(d.mode, 'native', 'never silently move an existing user to another filesystem');
  assert.equal(d.needsChoice, true);
});

test('resolveWslTarget does not ask when the only distros are docker internals', () => {
  const d = resolveWslTarget({}, 'win32', [DOCKER]);
  assert.equal(d.needsChoice, false);
  assert.equal(d.mode, 'native');
});

test('resolveWslTarget does not ask twice once the user has answered', () => {
  const d = resolveWslTarget({ terminalTarget: 'auto', terminalTargetChosen: true }, 'win32', [UBUNTU]);
  assert.equal(d.needsChoice, false);
});

test('resolveWslTarget honours an explicit windows choice', () => {
  const d = resolveWslTarget({ terminalTarget: 'windows', terminalTargetChosen: true }, 'win32', [UBUNTU]);
  assert.equal(d.mode, 'native');
  assert.equal(d.needsChoice, false);
});

test('resolveWslTarget engages WSL with the named distro', () => {
  const d = resolveWslTarget(
    { terminalTarget: 'wsl', wslDistro: 'Ubuntu', wslUser: 'carbo', terminalTargetChosen: true },
    'win32', [UBUNTU]
  );
  assert.equal(d.mode, 'wsl');
  assert.equal(d.distro, 'Ubuntu');
  assert.equal(d.user, 'carbo');
});

test('resolveWslTarget falls back LOUDLY when the saved distro is gone', () => {
  const d = resolveWslTarget(
    { terminalTarget: 'wsl', wslDistro: 'Debian', terminalTargetChosen: true }, 'win32', [UBUNTU]
  );
  assert.equal(d.mode, 'native', 'must not spawn into a distro the user did not pick');
  assert.match(d.reason, /no longer installed/);
});

test('resolveWslTarget falls back when WSL is selected but absent entirely', () => {
  const d = resolveWslTarget({ terminalTarget: 'wsl', terminalTargetChosen: true }, 'win32', []);
  assert.equal(d.mode, 'native');
  assert.match(d.reason, /no usable v2 distro/);
});

test('resolveWslTarget picks the default distro when none was named', () => {
  const d = resolveWslTarget({ terminalTarget: 'wsl', terminalTargetChosen: true }, 'win32', [UBUNTU, DOCKER]);
  assert.equal(d.mode, 'wsl');
  assert.equal(d.distro, 'Ubuntu');
});

test('every decision carries a reason, so a fallback is never silent', () => {
  const cases = [
    [{}, 'win32', [UBUNTU]],
    [{ terminalTarget: 'wsl', wslDistro: 'Gone' }, 'win32', [UBUNTU]],
    [{ terminalTarget: 'windows' }, 'win32', []],
    [{}, 'linux', []]
  ];
  for (const [cfg, plat, distros] of cases) {
    const d = resolveWslTarget(cfg, plat, distros);
    assert.ok(d.reason && d.reason.length > 0, 'reason must be set for ' + JSON.stringify(cfg));
  }
});
