import { useState, useEffect, type CSSProperties } from 'react';
import type { WslStatus } from '@/store/config';
import { PixelButton } from './PixelButton';

/**
 * WslFirstRunPrompt — asks ONCE where agents should run.
 *
 * Deliberately a question rather than a default. Defaulting to WSL would move an
 * existing Windows user's agents onto a different filesystem on upgrade, without
 * being asked; defaulting to Windows silently keeps everyone on the cmd.exe path
 * that truncates the hive protocol at its first newline. So we ask, once, and
 * record the answer either way — `wsl:setTarget` always stamps
 * terminalTargetChosen, so declining is remembered too.
 *
 * Self-gating: renders null unless main reports `decision.needsChoice`, which is
 * true only on a Windows host that has a usable distro AND has never been
 * answered. Off Windows this is always null.
 */

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60
};
const panel: CSSProperties = {
  width: 460, maxWidth: '90vw', padding: 16, background: 'var(--cth-paper-200)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-900), 6px 6px 0 rgba(0,0,0,0.35)',
  display: 'flex', flexDirection: 'column', gap: 10
};
const titleStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '16px',
  color: 'var(--cth-ink-900)', textTransform: 'uppercase'
};
const bodyStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-700)' };
const rowStyle: CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'flex-start', padding: 8,
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', cursor: 'pointer'
};

export function WslFirstRunPrompt({ onResolved }: { onResolved?: () => void } = {}) {
  const [status, setStatus] = useState<WslStatus | null>(null);
  const [choice, setChoice] = useState<'wsl' | 'windows'>('wsl');
  const [distro, setDistro] = useState('');
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const s = await window.cth.wsl.status();
        setStatus(s);
        setDistro(s.distro ?? s.distros.find((d) => d.isDefault)?.name ?? s.distros[0]?.name ?? '');
      } catch { /* status unavailable — stay hidden rather than guess */ }
    })();
  }, []);

  if (dismissed || !status || !status.decision.needsChoice) return null;

  const commit = async () => {
    setBusy(true);
    try {
      // Records terminalTargetChosen either way, so this never asks twice.
      await window.cth.wsl.setTarget(
        choice === 'wsl' ? { target: 'wsl', distro } : { target: 'windows' }
      );
      setDismissed(true);
      onResolved?.();
    } catch {
      // Even on failure, stop blocking the app — Settings has the same control.
      setDismissed(true);
      onResolved?.();
    } finally { setBusy(false); }
  };

  return (
    <div style={overlay}>
      <div style={panel}>
        <div style={titleStyle}>Where should agents run?</div>
        <div style={bodyStyle}>
          We found WSL2 on this machine{distro ? <> (<strong>{distro}</strong>)</> : null}. If your
          agent CLI is installed there, run agents in WSL2 — <code>git</code> and{' '}
          <code>node</code> will resolve to their Linux builds too.
        </div>

        <label style={rowStyle} onClick={() => setChoice('wsl')}>
          <input type="radio" checked={choice === 'wsl'} onChange={() => setChoice('wsl')} />
          <span>
            <strong>WSL2{distro ? ` — ${distro}` : ''}</strong>
            <div style={{ ...bodyStyle, fontSize: 11 }}>Recommended if your agent CLI is installed in WSL.</div>
          </span>
        </label>

        {status.distros.length > 1 && choice === 'wsl' && (
          <select
            value={distro}
            onChange={(e) => setDistro(e.target.value)}
            style={{
              padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
              fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
            }}
          >
            {status.distros.map((d) => (
              <option key={d.name} value={d.name}>{d.name}{d.isDefault ? ' (default)' : ''}</option>
            ))}
          </select>
        )}

        <label style={rowStyle} onClick={() => setChoice('windows')}>
          <input type="radio" checked={choice === 'windows'} onChange={() => setChoice('windows')} />
          <span>
            <strong>Windows (cmd.exe)</strong>
            <div style={{ ...bodyStyle, fontSize: 11 }}>Keeps today&apos;s behaviour.</div>
          </span>
        </label>

        <div style={{ ...bodyStyle, fontSize: 11 }}>You can change this later in Settings.</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <PixelButton onClick={() => void commit()} disabled={busy || (choice === 'wsl' && !distro)}>
            {busy ? 'Saving…' : 'Continue'}
          </PixelButton>
        </div>
      </div>
    </div>
  );
}
