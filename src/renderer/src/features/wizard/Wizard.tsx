// The first-run wizard (docs/PLAN.md section 7). Route 'wizard': App shows it while
// settings.firstRunComplete is false (?scenario=firstrun in the browser demo), and Settings > About can
// show it again. Four steps with a progress indicator and Back / Skip / Next:
//   1. Welcome and the privacy promise.  2. Detection (getSources(true)): per agent found / not found,
//   on/off, extra folders, Aider project folders.  3. Look & feel: theme, the two fun toggles, reduce
//   motion.  4. Done: saves firstRunComplete and opens the newest run (or explains what to do).
// Every choice is saved as it is made (updateSettings), so leaving half-way loses nothing.

import { useEffect, useRef, useState, type Ref } from 'react';
import { motion } from 'motion/react';
import {
  CheckmarkCircle02Icon,
  ComputerIcon,
  EyeIcon,
  Shield01Icon,
} from '@hugeicons/core-free-icons';
import { type SourceStatus } from '@shared/schema';
import { Icon } from '../../components/Icon';
import { useMotionPolicy } from '../../motion/context';
import { openRunWithDefaultView, updateSettings } from '../../store/actions';
import { useStore } from '../../store/store';
import { FolderList, PathMark, Switch, ThemePicker } from '../settings/controls';
import { detectionSummary, isFound, plural, watchedRunCount } from '../settings/describe';
import { stopAppShortcuts } from '../settings/keys';
import { FakeProgressSwitch, ReduceMotionChoice, SynonymsSwitch } from '../settings/SettingsScreen';
import { ConfidenceBadge, FolderCheck } from '../settings/SourcesSection';
import { addProjectRoot, removeProjectRoot, setSourceEnabled, useAddFolder, useSources } from '../settings/sourceActions';
import { MOD } from '../shortcuts/shortcuts';
import { doneCount, pickLatestRun, stepMotion, WIZARD_STEPS } from './wizardModel';
import './wizard.css';

type HeadingRef = Ref<HTMLHeadingElement>;

function WelcomeStep({ headingRef }: { headingRef: HeadingRef }) {
  return (
    <div className="wizard__welcome">
      <span className="wizard__logo" aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M7.5 12h2.5l1.5-3 2 6 1.5-3h1.5" />
        </svg>
      </span>
      <h1 ref={headingRef} tabIndex={-1}>
        Welcome to Agent Run Monitor
      </h1>
      <p className="wizard__lead">
        See what your coding agents are doing, live, in one window: Claude Code, Codex, Gemini CLI, Copilot, Aider, Cursor and more.
      </p>
      <ul className="promise" aria-label="Our privacy promise">
        <li>
          <Icon icon={EyeIcon} size={18} />
          <span>
            <strong>Read-only.</strong> It only reads the files your agents already write, and never changes them.
          </span>
        </li>
        <li>
          <Icon icon={ComputerIcon} size={18} />
          <span>
            <strong>Nothing leaves your computer.</strong> No account, no uploads, no tracking.
          </span>
        </li>
        <li>
          <Icon icon={Shield01Icon} size={18} />
          <span>
            <strong>Secrets are masked on screen.</strong> Keys and passwords show up as ••••.
          </span>
        </li>
      </ul>
      <p className="wizard__hint">Setup takes about a minute. You can change everything later in Settings.</p>
    </div>
  );
}

export function AgentRow({ s, rescan }: { s: SourceStatus; rescan?: () => Promise<SourceStatus[] | null> }) {
  const sources = useStore((st) => st.settings.sources);
  const folder = useAddFolder(s.agent, s.runCount, rescan);
  const enabled = sources[s.agent]?.enabled ?? s.enabled;
  const custom = sources[s.agent]?.customRoots ?? [];
  const found = isFound(s);
  const where = s.defaultRoots.find((r) => r.exists) ?? s.defaultRoots[0];
  const nameId = `wiz-src-${s.agent}`;
  return (
    <li className="wiz-source" data-agent={s.agent} data-found={found ? 'yes' : 'no'} data-enabled={enabled ? 'yes' : 'no'}>
      <div className="wiz-source__head">
        <span className="wiz-source__name" id={nameId}>
          {s.displayName}
        </span>
        <ConfidenceBadge confidence={s.confidence} />
        <span className="wiz-source__switch">
          <Switch checked={enabled} onChange={(v) => void setSourceEnabled(s.agent, v)} label={`Watch ${s.displayName}`} />
        </span>
      </div>
      {found ? (
        <p className="wiz-source__where">
          <PathMark exists />
          <span className="path mono" title={where?.path}>
            {where?.path}
          </span>
          <span className="wiz-source__count">{plural(s.runCount, 'run')}</span>
        </p>
      ) : (
        <>
          <p className="wiz-source__where">
            <PathMark exists={false} />
            <span>
              It would be at <span className="mono">{where?.path ?? 'its usual folder'}</span>
            </span>
          </p>
          <p className="wiz-source__nothing">Nothing there yet. Leave it on and it shows up when you start using it.</p>
        </>
      )}
      <FolderList
        folders={custom}
        listLabel={`Extra folders for ${s.displayName}`}
        onAdd={() => void folder.onAdd()}
        onRemove={folder.onRemove}
        addLabel="Add a folder"
        addName={`Add a folder for ${s.displayName}`}
      />
      <FolderCheck agent={s.agent} displayName={s.displayName} checking={folder.checking} emptyFolder={folder.emptyFolder} />
    </li>
  );
}

function DetectStep({ headingRef }: { headingRef: HeadingRef }) {
  const { list, scanning, error, rescan } = useSources(true);
  const projectRoots = useStore((s) => s.settings.projectRoots);
  const summary = list ? detectionSummary(list) : null;
  return (
    <div>
      <h1 ref={headingRef} tabIndex={-1}>
        Find your agents
      </h1>
      <p className="wizard__lead">
        We looked in the usual places for every supported agent. Switch off any you don't want to see. If an agent keeps its sessions
        somewhere else, add that folder.
      </p>
      <p className="wizard__summary" role="status" data-testid="wizard-summary">
        {!list || (scanning && !summary) ? 'Looking for your agents…' : summary?.text}
      </p>
      {error ? <p className="source__error">{error}</p> : null}
      {list ? (
        <ul className="wiz-sources" aria-label="Agents">
          {list.map((s) => (
            <AgentRow key={s.agent} s={s} rescan={rescan} />
          ))}
        </ul>
      ) : null}
      <section className="wiz-projects card" aria-labelledby="wiz-projects-h">
        <h2 id="wiz-projects-h">Aider keeps its history inside each project — add your project folders</h2>
        <p className="setting-row__desc">
          Pick the folder that holds your projects (for example your code folder). It is searched a few levels deep for Aider's{' '}
          <code>.aider.chat.history.md</code> files.
        </p>
        <FolderList
          folders={projectRoots}
          listLabel="Project folders"
          onAdd={() => void addProjectRoot()}
          onRemove={(p) => void removeProjectRoot(p)}
          addLabel="Add a project folder"
          empty="No project folders yet (you can skip this if you don't use Aider)."
        />
      </section>
    </div>
  );
}

function LookStep({ headingRef }: { headingRef: HeadingRef }) {
  const s = useStore((st) => st.settings);
  return (
    <div>
      <h1 ref={headingRef} tabIndex={-1}>
        Look & feel
      </h1>
      <p className="wizard__lead">Pick a theme; the whole app changes as you choose. Use the arrow keys to try them one by one.</p>
      <div className="card setting-group">
        <ThemePicker
          value={s.useCustomTheme && s.customTheme ? 'custom' : s.theme}
          onChange={(theme) => void updateSettings({ theme, useCustomTheme: false })}
        />
      </div>
      <div className="card setting-group">
        <SynonymsSwitch checked={s.synonyms} />
        <FakeProgressSwitch checked={s.fakeProgress} />
        <ReduceMotionChoice value={s.reduceMotion} />
      </div>
    </div>
  );
}

function DoneStep({ headingRef }: { headingRef: HeadingRef }) {
  const total = useStore((s) => s.order.length);
  const loaded = useStore((s) => s.runsLoaded);
  const progress = useStore((s) => s.loadProgress);
  const settingsSources = useStore((s) => s.settings.sources);
  // The cached detection from step 2 (a fresh one when setup was skipped): the list may still be
  // reading, so "Watching N runs" uses what was detected, not what has been read so far.
  const { list } = useSources(false);
  const detected = list ? watchedRunCount(list, settingsSources) : null;
  const count = doneCount({ detected, listed: total, listLoaded: loaded, progress });
  if (count.empty) {
    return (
      <div className="wizard__done" data-testid="wizard-done-empty">
        <h1 ref={headingRef} tabIndex={-1}>
          You're all set
        </h1>
        <p className="wizard__lead">There are no runs to show yet, and that's fine.</p>
        <div className="card wizard__empty">
          <p>
            <strong>Start a session in any supported agent and it appears here within seconds.</strong>
          </p>
          <p className="setting-row__desc">
            Still nothing after that? The agent may keep its sessions somewhere unusual: go Back and add its folder, or use Settings
            ({MOD}+,) &gt; Sources later.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="wizard__done" data-testid="wizard-done">
      <h1 ref={headingRef} tabIndex={-1}>
        You're all set
      </h1>
      <p className="wizard__lead">
        <span data-testid="wizard-done-count">
          Watching {plural(count.runs, 'run')}
          {count.reading ? ' (still reading…)' : ''}.
        </span>{' '}
        New sessions appear on their own, within seconds of starting.
      </p>
      <ul className="wizard__tips">
        <li>
          <span className="kbd">{MOD}</span> <span className="kbd">K</span> finds any run: try "failed yesterday".
        </li>
        <li>
          <span className="kbd">←</span> <span className="kbd">→</span> step through runs; <span className="kbd">?</span> lists every
          shortcut.
        </li>
        <li>
          <span className="kbd">{MOD}</span> <span className="kbd">,</span> opens Settings, where everything you chose here can be
          changed.
        </li>
      </ul>
    </div>
  );
}

export function Wizard() {
  const policy = useMotionPolicy();
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [busy, setBusy] = useState(false);
  const total = useStore((s) => s.order.length);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  // Each step starts with focus on its heading, so keyboard and screen-reader users begin at the top.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const go = (n: number) => {
    const next = Math.max(0, Math.min(WIZARD_STEPS.length - 1, n));
    moved.current = true;
    setDir(next >= step ? 1 : -1);
    setStep(next);
  };

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await updateSettings({ firstRunComplete: true });
    } catch (e) {
      console.error('Could not save settings', e);
    }
    const st = useStore.getState();
    const id = pickLatestRun(st.order, st.runs, st.settings.sources);
    st.setView(st.settings.defaultView);
    if (id) openRunWithDefaultView(id);
    else st.setRoute('dashboard');
    requestAnimationFrame(() => document.getElementById('main')?.focus());
  };

  const last = step === WIZARD_STEPS.length - 1;
  const m = stepMotion(policy, dir);
  const Step = [WelcomeStep, DetectStep, LookStep, DoneStep][step];

  return (
    <div className="wizard" data-testid="wizard" onKeyDown={stopAppShortcuts}>
      <div className="wizard__frame">
        <header className="wizard__header">
          <ol className="wizard__progress" aria-label="Setup steps">
            {WIZARD_STEPS.map((s, i) => {
              const state = i < step ? 'done' : i === step ? 'current' : 'todo';
              return (
                <li key={s.id} data-state={state} aria-current={i === step ? 'step' : undefined}>
                  <span className="wizard__dot" aria-hidden="true">
                    {i < step ? <Icon icon={CheckmarkCircle02Icon} size={14} /> : i + 1}
                  </span>
                  <span className="wizard__steplabel">{s.label}</span>
                  {i < step ? <span className="sr-only"> (done)</span> : null}
                </li>
              );
            })}
          </ol>
          <p className="wizard__count" data-testid="wizard-step">
            Step {step + 1} of {WIZARD_STEPS.length}
          </p>
        </header>
        <div className="wizard__body">
          <motion.div
            key={step}
            className="wizard__step"
            data-step={WIZARD_STEPS[step].id}
            initial={moved.current ? m.initial : false}
            animate={m.animate}
            transition={m.transition}
          >
            <Step headingRef={headingRef} />
          </motion.div>
        </div>
        <footer className="wizard__nav">
          {step > 0 ? (
            <button type="button" className="btn" onClick={() => go(step - 1)}>
              Back
            </button>
          ) : null}
          <span className="wizard__spacer" />
          {!last ? (
            <button type="button" className="btn btn--ghost" onClick={() => go(WIZARD_STEPS.length - 1)}>
              Skip setup
            </button>
          ) : null}
          {!last ? (
            <button type="button" className="btn btn--primary" onClick={() => go(step + 1)}>
              Next
            </button>
          ) : (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void finish()}>
              {total > 0 ? 'Open my latest run' : 'Start watching'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
