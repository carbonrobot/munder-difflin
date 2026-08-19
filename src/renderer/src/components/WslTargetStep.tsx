import type { CSSProperties } from 'react';
import type { WslDistroView } from '@/store/config';

/**
 * WslTargetStep — the onboarding step that asks where agents run.
 *
 * Lives in the wizard rather than in a launch-time modal on purpose. The GOD
 * session spawns as soon as the hive bootstraps, which happens the moment
 * onboarding is complete — so a modal racing that bootstrap either arrives too
 * late (Michael starts on Windows and keeps that PTY) or has to hold the whole
 * boot back. Asking inside the wizard means the answer is already persisted
 * before anything spawns, with no ordering to get wrong.
 *
 * The wizard renders this only on a Windows host that has a usable distro, and
 * persists the choice when the user moves on.
 */

export interface TerminalChoice {
  target: 'wsl' | 'windows';
  distro?: string;
}

const rowStyle: CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'flex-start', padding: 10,
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
  cursor: 'pointer'
};
const subStyle: CSSProperties = { fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '17px' };

export function WslTargetStep({
  distros, value, onChange, plain, isRoot
}: {
  distros: WslDistroView[];
  value: TerminalChoice;
  onChange: (next: TerminalChoice) => void;
  plain?: boolean;
  /** The distro's default user is root — Auto mode's flag is refused there. */
  isRoot?: boolean;
}) {
  const distro = value.distro ?? distros.find((d) => d.isDefault)?.name ?? distros[0]?.name ?? '';

  return (
    <>
      <p style={{ margin: 0, lineHeight: '22px' }}>
        {plain
          ? 'We found WSL2 on this machine. WSL2 is a Linux system running inside Windows — if you installed your coding tools there, your agents should run there too.'
          : <>We found WSL2 on this machine. If your agent CLI is installed there, run agents in WSL2 — <code>git</code> and <code>node</code> will resolve to their Linux builds too.</>}
      </p>

      <label style={rowStyle} onClick={() => onChange({ target: 'wsl', distro })}>
        <input
          type="radio"
          checked={value.target === 'wsl'}
          onChange={() => onChange({ target: 'wsl', distro })}
        />
        <span>
          <strong>WSL2{distro ? ` — ${distro}` : ''}</strong>
          <div style={subStyle}>
            {plain
              ? 'Pick this if you normally work inside WSL / Ubuntu.'
              : 'Recommended if your agent CLI is installed in WSL.'}
          </div>
        </span>
      </label>

      {value.target === 'wsl' && distros.length > 1 && (
        <label style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>
          Distro
          <select
            value={distro}
            onChange={(e) => onChange({ target: 'wsl', distro: e.target.value })}
            style={{
              width: '100%', marginTop: 4, padding: '6px 8px 4px',
              background: 'var(--cth-paper-100)', border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 13,
              color: 'var(--cth-ink-900)', outline: 'none'
            }}
          >
            {distros.map((d) => (
              <option key={d.name} value={d.name}>{d.name}{d.isDefault ? ' (default)' : ''}</option>
            ))}
          </select>
        </label>
      )}

      <label style={rowStyle} onClick={() => onChange({ target: 'windows' })}>
        <input
          type="radio"
          checked={value.target === 'windows'}
          onChange={() => onChange({ target: 'windows' })}
        />
        <span>
          <strong>Windows</strong>
          <div style={subStyle}>
            {plain
              ? 'Pick this if you installed your coding tools on Windows itself.'
              : 'Runs agents through cmd.exe, as before.'}
          </div>
        </span>
      </label>

      {isRoot && value.target === 'wsl' && (
        <div style={{
          ...subStyle, color: 'var(--cth-ink-900)', padding: 8,
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
        }}>
          <strong>Heads up:</strong> this distro runs as <code>root</code>. Auto mode passes
          a flag the CLI refuses under root, so agents will not start. Create a non-root user
          (<code>sudo adduser yourname</code>) and set it in Settings, or turn Auto mode off
          on the Permissions step.
        </div>
      )}

      <div style={subStyle}>You can change this later in Settings.</div>
    </>
  );
}
