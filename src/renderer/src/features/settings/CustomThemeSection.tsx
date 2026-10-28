// Settings > Customisation > Custom theme. "Customise" opens an editor that starts from the theme in
// use: colour pickers for background, surface, text, accent and the seven status colours, a small
// preview, and a live check against WCAG AA (the same pairs and thresholds every preset is held to in
// contrast.test.ts) that names each failing pair and each pair of status colours too alike to tell
// apart. A failing theme can still be saved, with a visible warning. There is one custom theme; it is
// stored in settings (never added to the presets) and picked like a preset in Appearance.

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { RUN_STATUSES, STATUS_LABELS, type RunStatus } from '@shared/schema';
import type { CustomTheme, Settings } from '@shared/settings';
import { Icon } from '../../components/Icon';
import { updateSettings } from '../../store/actions';
import { STATUS_DELTA_E_MIN, type Check, type StatusPair, type TokenKey } from '../../theme/checks';
import { checkCustomTheme, customTokens, pickedColours, problemCount, type ThemeReport } from '../../theme/custom';
import { THEMES, themeToCssVars } from '../../theme/themes';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';

type BaseKey = 'bg' | 'surface' | 'text' | 'accent';

const BASE_FIELDS: { key: BaseKey; label: string }[] = [
  { key: 'bg', label: 'Background' },
  { key: 'surface', label: 'Surface' },
  { key: 'text', label: 'Text' },
  { key: 'accent', label: 'Accent' },
];

const TOKEN_LABELS: Record<string, string> = {
  bg: 'Background',
  surface: 'Surface',
  raised: 'Cards',
  selected: 'Selected rows',
  hover: 'Hover',
  text: 'Text',
  textMuted: 'Muted text',
  borderStrong: 'Control borders',
  focus: 'Focus ring',
  accent: 'Accent',
  accentText: 'Button text',
};

const SHORT_STATUS: Record<RunStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  idle: 'Idle',
  done: 'Done',
  failed: 'Failed',
  stuck: 'Stuck',
  unreadable: 'Unreadable',
};

export function tokenLabel(key: TokenKey): string {
  if (key.startsWith('status.')) return `${SHORT_STATUS[key.slice(7) as RunStatus]} mark`;
  if (key.startsWith('statusText.')) return `${SHORT_STATUS[key.slice(11) as RunStatus]} text`;
  return TOKEN_LABELS[key] ?? key;
}

/** "Muted text on hover: 3.92:1, needs 4.5:1". */
export function checkText(c: Check): string {
  return `${tokenLabel(c.fgToken)} on ${tokenLabel(c.bgToken).toLowerCase()}: ${c.ratio.toFixed(2)}:1, needs ${c.min}:1`;
}

/** "Running and Stuck look too alike: difference 8.1, needs 15". */
export function pairText(p: StatusPair): string {
  return `${SHORT_STATUS[p.a]} and ${SHORT_STATUS[p.b]} look too alike: difference ${p.deltaE.toFixed(1)}, needs ${STATUS_DELTA_E_MIN}`;
}

/** "1 contrast problem" / "3 contrast problems and 1 pair of status colours too alike". */
export function problemSummary(r: ThemeReport): string {
  const parts: string[] = [];
  if (r.failing.length) parts.push(`${r.failing.length} ${r.failing.length === 1 ? 'pair fails' : 'pairs fail'} WCAG AA contrast`);
  if (r.closeStatus.length) parts.push(`${r.closeStatus.length} ${r.closeStatus.length === 1 ? 'pair' : 'pairs'} of status colours too alike`);
  return parts.length ? parts.join(' and ') : 'Every pair passes WCAG AA contrast, and every status colour is distinct.';
}

function ColourField({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }) {
  return (
    <label className="custom-theme__field">
      <input type="color" className="custom-theme__swatch" value={value} aria-label={label} onChange={(e) => onChange(e.target.value.toLowerCase())} />
      <span className="custom-theme__name">{label}</span>
      <span className="custom-theme__hex mono muted" aria-hidden="true">
        {value}
      </span>
    </label>
  );
}

function Preview({ colours }: { colours: CustomTheme }) {
  const vars = useMemo(() => themeToCssVars(customTokens(colours)) as CSSProperties, [colours]);
  return (
    <div className="custom-theme__preview" style={vars} aria-hidden="true">
      <div className="custom-theme__panel">
        <span className="custom-theme__sample">Add a --due flag</span>
        <span className="custom-theme__sample custom-theme__sample--muted">Claude Code · todo-cli · 2 min ago</span>
        <span className="custom-theme__marks">
          {RUN_STATUSES.map((st) => (
            <span key={st} className="status-text" data-status={st}>
              <StatusMark status={st} size={12} decorative still />
              {SHORT_STATUS[st]}
            </span>
          ))}
        </span>
        <span className="custom-theme__row">
          <span className="custom-theme__selected">Selected row</span>
          <span className="btn btn--primary btn--small">Accent</span>
        </span>
      </div>
    </div>
  );
}

function Editor({ start, base, onDone }: { start: CustomTheme; base: Settings['theme']; onDone(msg: string): void }) {
  const id = useId();
  const [draft, setDraft] = useState<CustomTheme>(start);
  const [saving, setSaving] = useState(false);
  const report = useMemo(() => checkCustomTheme(draft), [draft]);
  const problems = problemCount(report);
  const setBase = (k: BaseKey, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const setStatus = (st: RunStatus, v: string) => setDraft((d) => ({ ...d, status: { ...d.status, [st]: v } }));

  const save = async () => {
    setSaving(true);
    try {
      await updateSettings({ customTheme: draft, useCustomTheme: true });
      onDone(problems ? 'Saved and in use, with contrast warnings.' : 'Saved and in use.');
    } catch {
      setSaving(false);
      onDone("Couldn't save the custom theme. Try again.");
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Esc cancels the editor here instead of leaving the settings screen (and losing the draft unseen).
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    onDone('');
  };

  return (
    <div className="custom-theme" data-testid="custom-theme-editor" role="group" aria-label="Custom theme editor" onKeyDown={onKeyDown}>
      <div className="custom-theme__grid">
        <fieldset className="custom-theme__fields">
          <legend className="setting-row__label">Colours</legend>
          {BASE_FIELDS.map((f) => (
            <ColourField key={f.key} label={f.label} value={draft[f.key]} onChange={(v) => setBase(f.key, v)} />
          ))}
        </fieldset>
        <fieldset className="custom-theme__fields">
          <legend className="setting-row__label">Status colours</legend>
          {RUN_STATUSES.map((st) => (
            <ColourField key={st} label={STATUS_LABELS[st]} value={draft.status[st]} onChange={(v) => setStatus(st, v)} />
          ))}
        </fieldset>
        <Preview colours={draft} />
      </div>
      <p className="setting-row__desc">
        Cards, hover, muted text, borders, the focus ring and status text are worked out from these colours, and nudged toward
        more contrast where they need it. It's a {report.scheme} theme.
      </p>
      <div className={problems ? 'effective custom-theme__warning' : 'effective'} data-testid="custom-theme-checks" data-problems={problems}>
        <p className="custom-theme__summary" role="status" id={`${id}-sum`}>
          {problems ? <Icon icon={Alert02Icon} size={14} /> : null}
          {problems ? <strong>Contrast check: </strong> : <strong>Contrast check passes. </strong>}
          {problemSummary(report)}
        </p>
        {problems ? (
          <ul className="custom-theme__problems" aria-labelledby={`${id}-sum`} data-testid="custom-theme-problems">
            {report.failing.map((c) => (
              <li key={c.what}>{checkText(c)}</li>
            ))}
            {report.closeStatus.map((p) => (
              <li key={`${p.a}/${p.b}`}>{pairText(p)}</li>
            ))}
          </ul>
        ) : null}
        {problems ? (
          <p className="custom-theme__note">You can still save it, but some text or marks may be hard to read.</p>
        ) : null}
      </div>
      <div className="custom-theme__actions">
        <button type="button" className="btn btn--primary" disabled={saving} onClick={() => void save()} data-testid="custom-theme-save">
          {problems ? 'Save anyway and use' : 'Save and use'}
        </button>
        <button type="button" className="btn" onClick={() => onDone('')}>
          Cancel
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setDraft(pickedColours(THEMES[base].tokens))}>
          Start again from {THEMES[base].name}
        </button>
      </div>
    </div>
  );
}

export function CustomThemeSection({ s, editing, setEditing }: { s: Settings; editing: boolean; setEditing(on: boolean): void }) {
  const id = useId();
  const [message, setMessage] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(editing);
  // When the editor closes (saved, cancelled or Esc), focus goes back to "Customise…" instead of the page.
  useEffect(() => {
    if (wasEditing.current && !editing) openRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const saved = s.customTheme;
  const savedProblems = useMemo(() => (saved ? problemCount(checkCustomTheme(saved)) : 0), [saved]);
  // Start from the theme in use: the custom theme when it is on, otherwise the preset.
  const start = s.useCustomTheme && saved ? saved : pickedColours(THEMES[s.theme].tokens);
  const state = saved ? (s.useCustomTheme ? 'Your custom theme is in use.' : 'Your custom theme is saved but not in use.') : 'No custom theme yet.';

  const remove = async () => {
    setConfirmRemove(false);
    try {
      await updateSettings({ customTheme: null, useCustomTheme: false });
      setMessage(`Removed. Back to ${THEMES[s.theme].name}.`);
      openRef.current?.focus();
    } catch {
      setMessage("Couldn't remove it. Try again.");
    }
  };

  return (
    <div className="card setting-group" data-testid="custom-theme">
      <div className="setting-row">
        <div className="setting-row__text">
          <span className="setting-row__label" id={`${id}-l`}>
            Custom theme
          </span>
          <p className="setting-row__desc">
            Pick your own background, surface, text, accent and status colours, starting from the theme in use. It's saved as your
            custom theme, never as a preset; pick it or a preset in Appearance.
          </p>
          <p className="setting-row__desc" data-testid="custom-theme-state">
            {state}
          </p>
        </div>
        {!editing ? (
          <div className="run-folder__confirm">
            <button
              ref={openRef}
              type="button"
              className="btn"
              aria-describedby={`${id}-l`}
              onClick={() => {
                setMessage('');
                setEditing(true);
              }}
              data-testid="custom-theme-open"
            >
              Customise…
            </button>
            {saved && !s.useCustomTheme ? (
              <button type="button" className="btn" onClick={() => void updateSettings({ useCustomTheme: true })}>
                Use it
              </button>
            ) : null}
            {saved && !confirmRemove ? (
              <button type="button" className="btn btn--ghost" onClick={() => setConfirmRemove(true)}>
                Remove
              </button>
            ) : null}
            {saved && confirmRemove ? (
              <>
                <span className="run-folder__question">Remove your custom theme?</span>
                <button type="button" className="btn btn--small" onClick={() => void remove()}>
                  Remove
                </button>
                <button type="button" className="btn btn--ghost btn--small" onClick={() => setConfirmRemove(false)}>
                  Keep it
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {saved && savedProblems > 0 && !editing ? (
        <p className="effective custom-theme__warning custom-theme__summary" data-testid="custom-theme-warning">
          <Icon icon={Alert02Icon} size={14} />
          <span>
            <strong>Contrast warning: </strong>your custom theme has {savedProblems} contrast {savedProblems === 1 ? 'problem' : 'problems'}, so some
            text or marks may be hard to read. Choose Customise… to see which.
          </span>
        </p>
      ) : null}
      {editing ? (
        <Editor
          start={start}
          base={s.theme}
          onDone={(msg) => {
            setMessage(msg);
            setEditing(false);
          }}
        />
      ) : null}
      <p className="folders__empty" role="status" data-testid="custom-theme-message">
        {message}
      </p>
    </div>
  );
}
