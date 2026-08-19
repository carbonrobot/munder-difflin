import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import type { WslStatus } from '@/store/config';
import { PixelButton } from './PixelButton';

/**
 * WslSettings — where agent terminals run, on Windows.
 *
 * Many developers install their agent CLI inside WSL2, but the Windows spawn path targets
 * cmd.exe, which truncates a multi-line argument at its first newline: the hive
 * protocol rides on such an argument, so a Windows agent could boot looking
 * perfectly healthy having never learned it had an inbox. Targeting WSL execs
 * directly inside the distro, so argv survives intact.
 *
 * Renders nothing off Windows — on macOS/Linux the native path already IS the
 * unix path, so the choice would be meaningless.
 */

const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-700)', textTransform: 'uppercase'
};
const headStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
};
const selectStyle: CSSProperties = {
  width: '100%', padding: '6px 8px 4px', background: 'var(--cth-paper-100)',
  border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
};
const noteStyle: CSSProperties = { fontSize: 11, color: 'var(--cth-ink-500)', lineHeight: '16px' };

export function WslSettings() {
  const [status, setStatus] = useState<WslStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [tools, setTools] = useState<Record<string, string | null> | null>(null);

  const load = useCallback(async (force = false) => {
    try { setStatus(await window.cth.wsl.status(force)); }
    catch { /* status unavailable */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Off Windows there is nothing to choose. Also hides itself when Windows has
  // no usable distro, rather than showing a control that cannot be satisfied.
  if (!status || status.platform !== 'win32') return null;

  const target = status.target;
  const distro = status.distro ?? status.distros.find((d) => d.isDefault)?.name ?? status.distros[0]?.name ?? '';

  const save = async (patch: { target: 'auto' | 'windows' | 'wsl'; distro?: string; user?: string }) => {
    setBusy(true); setNote(''); setTools(null);
    try {
      const res = await window.cth.wsl.setTarget(patch);
      if (!res.ok) { setNote(res.error ?? 'could not save'); return; }
      setNote('saved — new terminals use this target');
      await load(true);
      setTimeout(() => setNote(''), 2500);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const probe = async () => {
    setBusy(true); setNote(''); setTools(null);
    try {
      const res = await window.cth.wsl.probe(distro, status.user ?? undefined);
      if (!res.ok) { setNote(res.error ?? 'probe failed'); return; }
      setTools(res.tools ?? {});
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={headStyle}>Terminal target</div>
      <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
        Where agents run their CLI. If your agent CLI is installed inside WSL2, target it —
        agents run there with a Linux-only PATH, so <code>git</code> and <code>node</code>{' '}
        resolve to their Linux builds rather than Windows ones.
      </div>

      {!status.available && (
        <div style={{ ...noteStyle, padding: 8, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          No WSL2 distro detected. Install one (<code>wsl --install -d Ubuntu</code>) and re-scan.
        </div>
      )}

      <label style={labelStyle}>
        Run agents in
        <select
          style={{ ...selectStyle, marginTop: 4 }}
          value={target === 'auto' ? (status.available ? 'auto' : 'windows') : target}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value as 'auto' | 'windows' | 'wsl';
            void save(v === 'wsl' ? { target: 'wsl', distro } : { target: v });
          }}
        >
          {target === 'auto' && <option value="auto">Not chosen yet</option>}
          <option value="windows">Windows (cmd.exe)</option>
          <option value="wsl" disabled={!status.available}>WSL2{distro ? ` — ${distro}` : ''}</option>
        </select>
      </label>

      {status.distros.length > 1 && (
        <label style={labelStyle}>
          Distro
          <select
            style={{ ...selectStyle, marginTop: 4 }}
            value={distro}
            disabled={busy || target !== 'wsl'}
            onChange={(e) => void save({ target: 'wsl', distro: e.target.value })}
          >
            {status.distros.map((d) => (
              <option key={d.name} value={d.name}>{d.name}{d.isDefault ? ' (default)' : ''}</option>
            ))}
          </select>
        </label>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <PixelButton onClick={() => void load(true)} disabled={busy}>Re-scan distros</PixelButton>
        {status.available && <PixelButton onClick={() => void probe()} disabled={busy}>Check tools</PixelButton>}
      </div>

      {tools && (
        <div style={{ ...noteStyle, padding: 8, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          {Object.entries(tools).map(([tool, path]) => (
            <div key={tool}>
              <strong>{tool}</strong>: {path ?? 'not installed in this distro'}
            </div>
          ))}
        </div>
      )}

      {/* A fallback must never be silent — that is the bug class this feature
          exists to remove, so surface the reason whenever the live decision
          differs from what was asked for. */}
      {target === 'wsl' && status.decision.mode !== 'wsl' && (
        <div style={{ ...noteStyle, color: 'var(--cth-ink-900)' }}>
          Running on Windows instead: {status.decision.reason}.
        </div>
      )}
      {note && <div style={noteStyle}>{note}</div>}
    </div>
  );
}
