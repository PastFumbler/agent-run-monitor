// The settings screen (docs/PLAN.md section 6). Route 'settings': Ctrl/Cmd+, or the palette opens it,
// Esc or "Back to runs" returns. A left section nav jumps between grouped sections; every change is
// saved through updateSettings() (optimistic, then the backend's normalised result) and applies live:
// the look via App's applyLook(), motion via the motion policy, sources via the backend's rescan.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft02Icon, LinkSquare02Icon } from '@hugeicons/core-free-icons';
import type { UpdateInfo } from '@shared/ipc';
import { RELEASES_URL } from '@shared/project';
import { HISTORY_CHOICES, REFRESH_CHOICES, RUN_VIEWS, type RunView, type Settings, type TriState } from '@shared/settings';
import { getBackend } from '../../backend';
import { Icon } from '../../components/Icon';
import { useMotionPolicy } from '../../motion/context';
import { goBack, updateSettings } from '../../store/actions';
import { useStore } from '../../store/store';
import { MOD } from '../shortcuts/shortcuts';
import { ChoiceGroup, SwitchRow, ThemePicker } from './controls';
import { historyLabel, lowGpuStateText, reduceMotionStateText, refreshLabel, updateResultText } from './describe';
import { FoldersSection } from './FoldersSection';
import { stopAppShortcuts } from './keys';
import { SourcesSection } from './SourcesSection';

export const SETTINGS_SECTIONS = [
  { id: 'sources', label: 'Sources' },
  { id: 'runs', label: 'Runs & refresh' },
  { id: 'folders', label: 'Folders' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'motion', label: 'Motion & performance' },
  { id: 'fun', label: 'Fun' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'system', label: 'System' },
  { id: 'about', label: 'About' },
] as const;
type SectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

const VIEW_LABELS: Record<RunView, string> = {
  activity: 'Activity',
  overview: 'Overview',
  files: 'Files',
  tools: 'Tools',
  timeline: 'Timeline',
};

const set = (patch: Partial<Settings>) => void updateSettings(patch);

function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }) {
  return (
    <section className="settings__section" id={`settings-${id}`} data-section={id} aria-labelledby={`settings-${id}-h`}>
      <h2 id={`settings-${id}-h`} tabIndex={-1}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function triChoices(autoLabel: string) {
  return [
    { value: 'auto' as TriState, label: autoLabel, name: 'Auto' },
    { value: 'on' as TriState, label: 'On' },
    { value: 'off' as TriState, label: 'Off' },
  ];
}

export function ReduceMotionChoice({ value }: { value: TriState }) {
  const policy = useMotionPolicy();
  return (
    <ChoiceGroup
      legend="Reduce motion"
      testId="reduce-motion"
      description="Accessibility: stops movement such as spinning marks, sliding panels and rotating words. Changes happen instantly instead."
      value={value}
      choices={triChoices('Auto - follows your system')}
      onChange={(v) => set({ reduceMotion: v })}
      footer={
        <p className="effective" data-testid="reduce-motion-state">
          {reduceMotionStateText(value, policy.reduce)}
        </p>
      }
    />
  );
}

function MotionSection({ s }: { s: Settings }) {
  const policy = useMotionPolicy();
  const power = useStore((st) => st.power);
  return (
    <Section id="motion" title="Motion & performance">
      <p className="setting-row__desc">
        Two separate settings: <strong>Reduce motion</strong> is for comfort and accessibility; <strong>Low GPU usage mode</strong> is
        for speed and battery life. You can use either, both or neither.
      </p>
      <div className="card setting-group">
        <ReduceMotionChoice value={s.reduceMotion} />
      </div>
      <div className="card setting-group">
        <ChoiceGroup
          legend="Low GPU usage mode"
          testId="low-gpu"
          description="Performance: keeps animations short and simple, turns off shadows and blur, never loops an animation, and refreshes live views less often. What you see stays the same; it just takes less work."
          value={s.lowGpu}
          choices={triChoices('Auto - turns on when running on battery')}
          onChange={(v) => set({ lowGpu: v })}
          footer={
            <>
              <p className="effective" data-testid="low-gpu-state">
                {lowGpuStateText(s.lowGpu, power, policy.lowGpu)}
              </p>
              <p className="setting-row__desc">Auto looks at battery power only: energy-saver mode detection isn't available.</p>
            </>
          }
        />
      </div>
    </Section>
  );
}

function PrivacySection({ s }: { s: Settings }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string>('');
  const [latest, setLatest] = useState<UpdateInfo | null>(null);
  const check = async () => {
    setChecking(true);
    setResult('');
    try {
      const info = await getBackend().checkForUpdate();
      setLatest(info);
      setResult(updateResultText(info));
    } catch (e) {
      setResult(`Couldn't check: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setChecking(false);
    }
  };
  return (
    <Section id="privacy" title="Privacy">
      <div className="privacy-promise card" data-testid="privacy-statement">
        <p>
          <strong>Read-only.</strong> Agent Run Monitor only reads your agents' session files. It never changes, moves or deletes them.
        </p>
        <p>
          <strong>Local-only.</strong> Everything stays on this computer. Nothing is uploaded.
        </p>
        <p>
          <strong>No telemetry.</strong> No analytics, no tracking, no crash reports.
        </p>
      </div>
      <div className="card setting-group">
        <SwitchRow
          label="Mask likely secrets"
          description="Hides anything that looks like an API key, token or password before it's shown, for example sk-…••••[OpenAI key]. Your files are not changed; this only affects the screen."
          checked={s.maskSecrets}
          onChange={(v) => set({ maskSecrets: v })}
        />
        <SwitchRow
          label="Check for updates"
          description="Off unless you turn it on. When on, the app asks GitHub Releases whether a newer version exists. That single GET request is the only network request the app ever makes."
          checked={s.checkForUpdates}
          onChange={(v) => set({ checkForUpdates: v })}
        >
          <div className="update-check">
            <button type="button" className="btn btn--small" disabled={!s.checkForUpdates || checking} onClick={() => void check()}>
              {checking ? 'Checking…' : 'Check now'}
            </button>
            {!s.checkForUpdates ? <span className="setting-row__desc">Turn on "Check for updates" to use this.</span> : null}
            <span role="status" className="update-check__result" data-testid="update-result">
              {result}
              {latest?.url && latest.latest && latest.latest !== latest.current ? (
                <>
                  {' '}
                  <a href={latest.url} target="_blank" rel="noreferrer">
                    Download
                  </a>
                </>
              ) : null}
            </span>
          </div>
        </SwitchRow>
      </div>
    </Section>
  );
}

function AboutSection() {
  const appInfo = useStore((s) => s.appInfo);
  const setAppInfo = useStore((s) => s.setAppInfo);
  const setRoute = useStore((s) => s.setRoute);
  useEffect(() => {
    if (appInfo) return;
    getBackend()
      .appInfo()
      .then(setAppInfo)
      .catch(() => {});
  }, [appInfo, setAppInfo]);
  return (
    <Section id="about" title="About">
      <div className="card setting-group">
        <dl className="about">
          <dt>Version</dt>
          <dd data-testid="about-version">{appInfo?.version ?? '…'}</dd>
          <dt>Settings file</dt>
          <dd className="mono path-wrap" data-testid="about-settings-path">
            {appInfo?.settingsPath ?? '…'}
          </dd>
          <dt>Project</dt>
          <dd>
            <a href={RELEASES_URL} target="_blank" rel="noreferrer" data-testid="about-releases">
              Releases and source code on GitHub
              <Icon icon={LinkSquare02Icon} size={13} />
            </a>
          </dd>
          <dt>Licences</dt>
          <dd>
            Agent Run Monitor is open source under the MIT licence. It includes components adapted from React Bits (MIT + Commons Clause)
            and other open-source packages; their licences are in <span className="mono">THIRD_PARTY_NOTICES.md</span>, which ships with
            the app.
          </dd>
        </dl>
        <div className="setting-row">
          <div className="setting-row__text">
            <span className="setting-row__label">First-run guide</span>
            <p className="setting-row__desc">Walk through finding your agents and picking a look again. Nothing is reset.</p>
          </div>
          <button type="button" className="btn" onClick={() => setRoute('wizard')}>
            Show first-run guide again
          </button>
        </div>
      </div>
    </Section>
  );
}

export function SettingsScreen() {
  const s = useStore((st) => st.settings);
  const setView = useStore((st) => st.setView);
  const [active, setActive] = useState<SectionId>('sources');
  const contentRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    // Leaving (Esc, Back): focus was inside this screen and would fall to <body>; put it on the main
    // area instead so the keyboard carries on from the run that is shown.
    return () => {
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) document.getElementById('main')?.focus();
      });
    };
  }, []);

  // The nav follows scrolling: the active section is the last one whose top has passed the top edge.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return undefined;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = el.getBoundingClientRect().top + 24;
        let cur: SectionId = SETTINGS_SECTIONS[0].id;
        for (const sec of el.querySelectorAll<HTMLElement>('[data-section]')) {
          if (sec.getBoundingClientRect().top <= top) cur = sec.dataset.section as SectionId;
        }
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) cur = SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].id;
        setActive(cur);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const jump = (id: SectionId) => {
    const sec = document.getElementById(`settings-${id}`);
    if (!sec) return;
    // An instant jump: smooth scrolling would be motion outside the motion policy.
    sec.scrollIntoView({ block: 'start', behavior: 'auto' });
    sec.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    setActive(id);
  };

  return (
    <div className="settings" data-testid="settings-screen" onKeyDown={stopAppShortcuts}>
      <header className="settings__header">
        <button type="button" className="btn btn--ghost" onClick={goBack} title="Back to runs (Esc)">
          <Icon icon={ArrowLeft02Icon} size={16} />
          Back to runs
        </button>
        <h1 ref={titleRef} tabIndex={-1}>
          Settings
        </h1>
        <span className="settings__saved">
          Changes save and apply straight away. <span className="kbd">Esc</span> goes back, <span className="kbd">{MOD}</span>
          <span className="kbd">,</span> opens this screen.
        </span>
      </header>
      <div className="settings__body">
        <nav className="settings__nav" aria-label="Settings sections">
          <ul>
            {SETTINGS_SECTIONS.map((sec) => (
              <li key={sec.id}>
                <button
                  type="button"
                  className="settings__navbtn"
                  aria-current={active === sec.id ? 'true' : undefined}
                  onClick={() => jump(sec.id)}
                >
                  {sec.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings__content" ref={contentRef}>
          <Section id="sources" title="Sources">
            <SourcesSection />
          </Section>

          <Section id="runs" title="Runs & refresh">
            <div className="card setting-group">
              <ChoiceGroup
                legend="Refresh rate"
                testId="refresh-rate"
                description="How often live runs are checked for news. Faster feels more live; slower uses less power."
                value={s.refreshMs}
                choices={REFRESH_CHOICES.map((ms) => ({ value: ms as number, label: refreshLabel(ms), name: `Every ${refreshLabel(ms)}` }))}
                onChange={(v) => set({ refreshMs: v })}
              />
              <ChoiceGroup
                legend="How far back to show runs"
                testId="history"
                description="Older runs are left out of the list (their files stay where they are)."
                value={s.historyDays}
                choices={HISTORY_CHOICES.map((d) => ({ value: d as number, label: historyLabel(d) }))}
                onChange={(v) => set({ historyDays: v })}
              />
              <ChoiceGroup
                legend="Default run view"
                testId="default-view"
                description="Which tab a run opens on."
                value={s.defaultView}
                choices={RUN_VIEWS.map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
                onChange={(v) => {
                  setView(v);
                  set({ defaultView: v });
                }}
              />
              <div className="setting-row">
                <div className="setting-row__text">
                  <label className="setting-row__label" htmlFor="settings-grid-limit">
                    Tiles per page in the multiviewer
                  </label>
                  <p className="setting-row__desc" id="settings-grid-limit-d">
                    Up to 12 runs side by side. More selected runs go on further pages.
                  </p>
                </div>
                <select
                  id="settings-grid-limit"
                  className="input settings__select"
                  aria-describedby="settings-grid-limit-d"
                  value={s.gridTileLimit}
                  onChange={(e) => set({ gridTileLimit: Number(e.target.value) })}
                >
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <SwitchRow
                label="Move updated runs to top"
                description="In Recent, runs with new activity move up. When off, Recent keeps its order and a newly opened run appears at the top. Opening a run never moves it."
                checked={s.moveUpdatedToTop}
                onChange={(v) => set({ moveUpdatedToTop: v })}
                testId="move-updated-to-top"
              />
            </div>
          </Section>

          <Section id="folders" title="Folders">
            <FoldersSection />
          </Section>

          <Section id="notifications" title="Notifications">
            <div className="card setting-group">
              <SwitchRow
                label="When a run finishes"
                description="A desktop notification when a run is done."
                checked={s.notifyOnFinish}
                onChange={(v) => set({ notifyOnFinish: v })}
              />
              <SwitchRow
                label="When a run fails"
                description="A desktop notification when a run fails or gets stuck."
                checked={s.notifyOnFailure}
                onChange={(v) => set({ notifyOnFailure: v })}
              />
            </div>
          </Section>

          <Section id="appearance" title="Appearance">
            <div className="card setting-group">
              <ThemePicker value={s.theme} onChange={(theme) => set({ theme })} />
            </div>
            <div className="card setting-group">
              <ChoiceGroup
                legend="Text size"
                testId="text-size"
                value={s.textSize}
                choices={[
                  { value: 'small', label: 'Small' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'large', label: 'Large' },
                ]}
                onChange={(v) => set({ textSize: v })}
              />
              <ChoiceGroup
                legend="Density"
                testId="density"
                description="Compact fits more runs on screen; comfortable gives them more room."
                value={s.density}
                choices={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'comfortable', label: 'Comfortable' },
                ]}
                onChange={(v) => set({ density: v })}
              />
              <ChoiceGroup
                legend="Time format"
                testId="time-format"
                value={s.timeFormat}
                choices={[
                  { value: '24h', label: '24-hour (15:30)', name: '24-hour' },
                  { value: '12h', label: '12-hour (3:30 PM)', name: '12-hour' },
                  { value: 'relative', label: 'Relative (5 min ago)', name: 'Relative' },
                ]}
                onChange={(v) => set({ timeFormat: v })}
              />
            </div>
          </Section>

          <MotionSection s={s} />

          <Section id="fun" title="Fun">
            <div className="card setting-group">
              <SynonymsSwitch checked={s.synonyms} />
              <FakeProgressSwitch checked={s.fakeProgress} />
            </div>
          </Section>

          <PrivacySection s={s} />

          <Section id="system" title="System">
            <div className="card setting-group">
              <SwitchRow
                label="Start with the operating system"
                description="Opens Agent Run Monitor when you sign in to this computer."
                checked={s.startWithOs}
                onChange={(v) => set({ startWithOs: v })}
              />
            </div>
          </Section>

          <AboutSection />
        </div>
      </div>
    </div>
  );
}

export function SynonymsSwitch({ checked }: { checked: boolean }) {
  return (
    <SwitchRow
      label={'Synonyms instead of "Working"'}
      description="A running run's label cycles through words like Cogitating, Percolating and Noodling. Screen readers always hear the real status."
      checked={checked}
      onChange={(v) => set({ synonyms: v })}
    />
  );
}

export function FakeProgressSwitch({ checked }: { checked: boolean }) {
  return (
    <SwitchRow
      label="Totally fake progress bar"
      description="Running runs get a progress bar with a wildly precise, completely made-up ETA. It says it's fake, right underneath."
      checked={checked}
      onChange={(v) => set({ fakeProgress: v })}
    />
  );
}
