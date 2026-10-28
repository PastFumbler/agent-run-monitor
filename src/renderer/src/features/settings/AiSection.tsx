// Settings > AI summary: the optional AI summary at the top of Overview. Off by default. The user
// picks a provider, may change the model, saves their own API key (kept in main only; this screen
// only learns whether one is saved) and turns the feature on after a plain warning that run content
// will be sent to that provider. Changing the provider turns it off until confirmed again.

import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Delete02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { AI_PROVIDERS, DEFAULT_MODELS, MAX_KEY_LENGTH, MAX_MODEL_NAME, PROVIDER_NAMES, cleanApiKey, type AiStatus } from '@shared/ai';
import type { Settings } from '@shared/settings';
import { getBackend } from '../../backend';
import { Icon } from '../../components/Icon';
import { updateSettings } from '../../store/actions';
import { ChoiceGroup, SwitchRow } from './controls';

const set = (patch: Partial<Settings>) => updateSettings(patch);
/** After the warning closes, focus goes back to the switch (the buttons that had it are gone). */
const focusSwitch = () =>
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="ai-summaries"] [role="switch"]')?.focus());

export function AiSection({ s }: { s: Settings }) {
  const uid = useId();
  const name = PROVIDER_NAMES[s.aiProvider];
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(s.aiModel);
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const hasKey = !!status?.keys[s.aiProvider];

  useEffect(() => {
    let live = true;
    getBackend()
      .aiStatus()
      .then((st) => live && setStatus(st))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  // The field follows the saved model (it is cleared when the provider changes).
  useEffect(() => setModel(s.aiModel), [s.aiModel, s.aiProvider]);

  const saveKey = async (e: FormEvent) => {
    e.preventDefault();
    const clean = cleanApiKey(key);
    if (!clean) {
      setMessage('That does not look like an API key: paste the whole key, without spaces.');
      return;
    }
    try {
      const st = await getBackend().setAiKey(s.aiProvider, clean);
      setStatus(st);
      setMessage(st.error ?? `${name} key saved.`);
      if (!st.error) setKey('');
    } catch {
      setMessage("Couldn't save the key. Try again.");
    }
  };
  const removeKey = async () => {
    try {
      const st = await getBackend().setAiKey(s.aiProvider, null);
      setStatus(st);
      setMessage(st.error ?? `${name} key removed.`);
    } catch {
      setMessage("Couldn't remove the key. Try again.");
    }
  };
  const saveModel = async (e: FormEvent) => {
    e.preventDefault();
    let next: Settings;
    try {
      next = await set({ aiModel: model });
    } catch {
      setMessage("Couldn't save the model. Try again.");
      return;
    }
    if (model.trim() && !next.aiModel) setMessage('Model names use letters, numbers and . _ : / @ - only. Using the default.');
    else setMessage(next.aiModel ? `Model set to ${next.aiModel}.` : `Using the default model, ${DEFAULT_MODELS[s.aiProvider]}.`);
  };
  const cancelConfirm = (e: KeyboardEvent) => {
    // Esc cancels here instead of leaving the settings screen.
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    setConfirming(false);
    focusSwitch();
  };

  const keyText = !status
    ? ''
    : hasKey
      ? status.secure
        ? `A key for ${name} is saved, encrypted by your operating system.`
        : `A key for ${name} is kept for this session only: this system has no secure key storage, so it is not written to disk.`
      : `No key for ${name} is saved.`;

  return (
    <div className="card setting-group" data-testid="ai-settings">
      <p className="setting-row__desc">
        Every run's Overview starts with a short summary built on this computer from the run's own data, with no network. You can
        ask an AI provider to write it instead, with your own API key. This is off unless you turn it on.
      </p>
      <ChoiceGroup
        legend="Provider"
        testId="ai-provider"
        description="Changing the provider turns AI summaries off until you confirm again."
        value={s.aiProvider}
        choices={AI_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_NAMES[p] }))}
        onChange={(v) => {
          setConfirming(false);
          setMessage('');
          void set({ aiProvider: v, aiModel: '', aiSummaries: false });
        }}
      />
      <div className="setting-row">
        <div className="setting-row__text">
          <label className="setting-row__label" htmlFor={`${uid}-model`}>
            Model
          </label>
          <p className="setting-row__desc" id={`${uid}-model-d`}>
            Leave empty for the default, {DEFAULT_MODELS[s.aiProvider]}.
          </p>
          <form className="run-folder__form" onSubmit={saveModel}>
            <input
              id={`${uid}-model`}
              className="input"
              aria-describedby={`${uid}-model-d`}
              placeholder={DEFAULT_MODELS[s.aiProvider]}
              maxLength={MAX_MODEL_NAME}
              spellCheck={false}
              autoComplete="off"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <button type="submit" className="btn btn--small" disabled={model.trim() === s.aiModel}>
              <Icon icon={Tick02Icon} size={14} />
              Save model
            </button>
          </form>
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-row__text">
          <label className="setting-row__label" htmlFor={`${uid}-key`}>
            {name} API key
          </label>
          <p className="setting-row__desc" id={`${uid}-key-d`} data-testid="ai-key-state">
            {keyText} The key stays in the app's main process; it is never shown again, logged or sent anywhere except {name}.
          </p>
          <form className="run-folder__form" onSubmit={saveKey}>
            <input
              id={`${uid}-key`}
              className="input"
              type="password"
              aria-describedby={`${uid}-key-d`}
              placeholder={hasKey ? 'Paste a new key to replace it' : 'Paste your API key'}
              maxLength={MAX_KEY_LENGTH}
              spellCheck={false}
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="submit" className="btn btn--small" disabled={!key.trim()}>
              <Icon icon={Tick02Icon} size={14} />
              Save key
            </button>
            {hasKey ? (
              <button type="button" className="btn btn--ghost btn--small" onClick={() => void removeKey()}>
                <Icon icon={Delete02Icon} size={14} />
                Remove key
              </button>
            ) : null}
          </form>
        </div>
      </div>
      <SwitchRow
        label="Use AI summaries"
        testId="ai-summaries"
        description={`Off by default. When on, opening a run's Overview sends that run's content to ${name}.`}
        checked={s.aiSummaries}
        onChange={(v) => {
          setMessage('');
          if (v) setConfirming(true);
          else {
            setConfirming(false);
            void set({ aiSummaries: false });
          }
        }}
      >
        {confirming && !s.aiSummaries ? (
          <div className="effective" role="group" aria-labelledby={`${uid}-warn`} data-testid="ai-confirm" onKeyDown={cancelConfirm}>
            <p id={`${uid}-warn`} className="ai-confirm__text">
              <strong>Run content will be sent to {name}.</strong>
            </p>
            <p className="ai-confirm__text">
              Each time you open a run's Overview, the app sends {name} that run's request, the names of the files it changed and its
              recent messages and tool calls: at most about 8,000 characters. Likely secrets are masked first, even when masking is off
              in Privacy, but masking can miss an unusual secret. {name}'s own terms apply to what it receives. Summaries are saved on
              this computer, so the same run content is never sent twice.
            </p>
            <div className="run-folder__confirm">
              <button
                type="button"
                className="btn btn--small"
                autoFocus
                onClick={() => {
                  setConfirming(false);
                  void set({ aiSummaries: true });
                  focusSwitch();
                }}
              >
                Send run content to {name}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  setConfirming(false);
                  focusSwitch();
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {s.aiSummaries ? (
          <p className="effective" data-testid="ai-on">
            On: opening a run's Overview sends its masked content to {name}
            {hasKey || !status ? '.' : `. Save a key for ${name} above first.`}
          </p>
        ) : null}
      </SwitchRow>
      <p className="folders__empty" role="status" data-testid="ai-message">
        {message}
      </p>
    </div>
  );
}
