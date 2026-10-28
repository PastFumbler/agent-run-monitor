// Accessible form controls shared by the settings screen and the first-run wizard:
// - SwitchRow: a role="switch" button with aria-checked, labelled and described by visible text, and
//   an "On"/"Off" word inside so the state never depends on colour.
// - ChoiceGroup: a fieldset/legend radio group of native radios (arrow keys work as usual).
// - ThemePicker: the six themes as radio cards, each previewing its own token set (plus the saved
//   custom theme and a Customise button on the settings screen).
// - FolderList: a list of folders with Remove buttons and an "Add folder" button.
// Every transition uses var(--motion-duration), which the motion policy sets (0 when motion is
// reduced or the window is hidden, short in low-GPU mode).

import { useId, type ReactNode } from 'react';
import { CheckmarkCircle02Icon, Delete02Icon, FolderAddIcon, Moon02Icon, Sun03Icon } from '@hugeicons/core-free-icons';
import type { CustomTheme, ThemeId } from '@shared/settings';
import { schemeOf } from '../../theme/checks';
import { customTokens } from '../../theme/custom';
import { Icon } from '../../components/Icon';
import { THEME_LIST, themeToCssVars, type ThemeTokens } from '../../theme/themes';
import StatusMark from '../../vendor/react-bits/StatusMark/StatusMark';
import './settings.css';

export function Switch({
  checked,
  onChange,
  labelledBy,
  describedBy,
  label,
  disabled,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  labelledBy?: string;
  describedBy?: string;
  /** Used when there is no visible label to point at. */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      <span className="switch__state" aria-hidden="true">
        {checked ? 'On' : 'Off'}
      </span>
    </button>
  );
}

export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  children,
  testId,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  children?: ReactNode;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="setting-row" data-testid={testId}>
      <div className="setting-row__text">
        <span className="setting-row__label" id={`${id}-l`}>
          {label}
        </span>
        {description ? (
          <p className="setting-row__desc" id={`${id}-d`}>
            {description}
          </p>
        ) : null}
        {children}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        labelledBy={`${id}-l`}
        describedBy={description ? `${id}-d` : undefined}
        disabled={disabled}
      />
    </div>
  );
}

export interface Choice<T extends string | number> {
  value: T;
  label: ReactNode;
  /** Accessible name when the label is not plain text. */
  name?: string;
}

export function ChoiceGroup<T extends string | number>({
  legend,
  description,
  value,
  choices,
  onChange,
  footer,
  testId,
}: {
  legend: string;
  description?: ReactNode;
  value: T;
  choices: Choice<T>[];
  onChange(v: T): void;
  footer?: ReactNode;
  testId?: string;
}) {
  const id = useId();
  return (
    <fieldset className="choice" data-testid={testId} aria-describedby={description ? `${id}-d` : undefined}>
      <legend className="setting-row__label">{legend}</legend>
      {description ? (
        <p className="setting-row__desc" id={`${id}-d`}>
          {description}
        </p>
      ) : null}
      <div className="choice__options">
        {choices.map((c) => (
          <label key={String(c.value)} className="choice__opt">
            <input
              type="radio"
              className="choice__input"
              name={`${id}-r`}
              value={String(c.value)}
              checked={c.value === value}
              aria-label={c.name}
              onChange={() => onChange(c.value)}
            />
            <span className="choice__face">{c.label}</span>
          </label>
        ))}
      </div>
      {footer}
    </fieldset>
  );
}

/** The preview inside a theme card; it carries the theme's tokens as scoped CSS variables. */
function ThemePreview({ tokens }: { tokens: ThemeTokens }) {
  return (
    <span className="theme-card__preview" style={themeToCssVars(tokens) as React.CSSProperties} aria-hidden="true">
      <span className="theme-card__side">
        <span className="theme-card__line theme-card__line--strong" />
        <span className="theme-card__line" />
        <span className="theme-card__line" />
      </span>
      <span className="theme-card__main">
        <span className="theme-card__marks">
          <StatusMark status="done" size={11} decorative />
          <StatusMark status="waiting" size={11} decorative />
          <StatusMark status="failed" size={11} decorative />
        </span>
        <span className="theme-card__line theme-card__line--strong" />
        <span className="theme-card__line" />
        <span className="theme-card__accent" />
      </span>
    </span>
  );
}

function ThemeCard({
  groupId,
  cardId,
  name,
  scheme,
  blurb,
  tokens,
  selected,
  onSelect,
}: {
  groupId: string;
  cardId: string;
  name: string;
  scheme: 'light' | 'dark';
  blurb: ReactNode;
  tokens: ThemeTokens;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <label className="theme-card" data-selected={selected ? '' : undefined} data-theme-id={cardId}>
      <input
        type="radio"
        className="choice__input"
        name={`${groupId}-theme`}
        value={cardId}
        checked={selected}
        aria-label={`${name}, ${scheme}`}
        aria-describedby={`${groupId}-${cardId}-b`}
        onChange={onSelect}
      />
      <ThemePreview tokens={tokens} />
      <span className="theme-card__head">
        <span className="theme-card__name">{name}</span>
        <span className="theme-card__scheme">
          <Icon icon={scheme === 'light' ? Sun03Icon : Moon02Icon} size={12} />
          {scheme === 'light' ? 'Light' : 'Dark'}
        </span>
        {selected ? (
          <span className="theme-card__check" title="In use">
            <Icon icon={CheckmarkCircle02Icon} size={14} />
          </span>
        ) : null}
      </span>
      <span className="theme-card__blurb" id={`${groupId}-${cardId}-b`}>
        {blurb}
      </span>
    </label>
  );
}

/**
 * The six presets as radio cards, each previewing its own token set. With `custom`, a saved custom
 * theme is one more card (it is never one of the presets) and "Customise…" opens the editor.
 */
export function ThemePicker({
  value,
  onChange,
  legend = 'Theme',
  custom,
}: {
  /** The preset in use, or 'custom' when the custom theme is. */
  value: ThemeId | 'custom';
  onChange(id: ThemeId): void;
  legend?: string;
  custom?: { colours: CustomTheme | null; problems: number; onUse(): void; onCustomise(): void };
}) {
  const id = useId();
  const saved = custom?.colours ?? null;
  return (
    <fieldset className="choice themes" data-testid="theme-picker">
      <legend className="setting-row__label">{legend}</legend>
      <p className="setting-row__desc">
        Three light and three dark themes{custom ? ', or your own' : ''}. Picking one changes the whole app straight away.
      </p>
      <div className="themes__grid">
        {THEME_LIST.map((t) => (
          <ThemeCard
            key={t.id}
            groupId={id}
            cardId={t.id}
            name={t.name}
            scheme={t.scheme}
            blurb={t.blurb}
            tokens={t.tokens}
            selected={t.id === value}
            onSelect={() => onChange(t.id)}
          />
        ))}
        {custom && saved ? (
          <ThemeCard
            groupId={id}
            cardId="custom"
            name="Custom"
            scheme={schemeOf(saved.bg)}
            blurb={custom.problems ? `Your colours · ${custom.problems} contrast ${custom.problems === 1 ? 'warning' : 'warnings'}` : 'Your colours'}
            tokens={customTokens(saved)}
            selected={value === 'custom'}
            onSelect={custom.onUse}
          />
        ) : null}
      </div>
      {custom ? (
        <div className="themes__custom">
          <button type="button" className="btn" onClick={custom.onCustomise} data-testid="theme-customise">
            Customise…
          </button>
          <span className="setting-row__desc">Pick your own colours, starting from the theme in use.</span>
        </div>
      ) : null}
    </fieldset>
  );
}

export function FolderList({
  folders,
  onAdd,
  onRemove,
  addLabel = 'Add folder',
  addName,
  empty,
  listLabel,
  exists,
  busy,
}: {
  folders: string[];
  onAdd(): void;
  onRemove(path: string): void;
  addLabel?: string;
  /** Accessible name for the add button when several share the same visible label. */
  addName?: string;
  empty?: ReactNode;
  listLabel: string;
  /** Optional exists marks (custom roots from getSources). */
  exists?: (path: string) => boolean | undefined;
  busy?: boolean;
}) {
  return (
    <div className="folders">
      {folders.length ? (
        <ul className="folders__list" aria-label={listLabel}>
          {folders.map((f) => {
            const ok = exists?.(f);
            return (
              <li key={f} className="folders__item">
                <span className="path mono" title={f}>
                  {f}
                </span>
                {ok === false ? <PathMark exists={false} /> : null}
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  aria-label={`Remove ${f}`}
                  onClick={() => onRemove(f)}
                >
                  <Icon icon={Delete02Icon} size={14} />
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : empty ? (
        <p className="folders__empty">{empty}</p>
      ) : null}
      <button type="button" className="btn btn--small" onClick={onAdd} aria-label={addName} disabled={busy}>
        <Icon icon={FolderAddIcon} size={14} />
        {addLabel}
      </button>
    </div>
  );
}

/** "Found" / "Not there" with a shape, not just a colour. */
export function PathMark({ exists }: { exists: boolean }) {
  return (
    <span className="pathmark" data-exists={exists ? 'yes' : 'no'}>
      <StatusMark status={exists ? 'done' : 'idle'} size={12} decorative />
      {exists ? 'Found' : 'Not there'}
    </span>
  );
}
