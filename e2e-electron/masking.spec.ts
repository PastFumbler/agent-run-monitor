// Secret masking in the real app: a synthetic Claude Code session with planted fake secrets in the
// user prompt, a tool input and a tool output. With masking on (the default) no secret body may
// reach the window in any view or in the command palette. Then masking is switched off in Settings
// and the same bodies must appear, which proves the check can fail.
//
// The secrets are random and assembled at runtime, so this file contains none (scan-secrets).

import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { baseSettings, launchApp, removeDir, SessionWriter, tempDir, waitForRuns, type Launched } from './helpers';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const B64 = `${ALNUM}+/`;
const rnd = (n: number, abc = ALNUM) => Array.from({ length: n }, () => abc[Math.floor(Math.random() * abc.length)]).join('');

/** Each planted secret: the full text placed in the session, and the body that must never show. */
function makeSecrets() {
  const openai = rnd(48);
  const anthropic = rnd(80);
  const github = rnd(36);
  const aws = rnd(16, UPPER);
  const pgPass = rnd(18);
  const sqlPass = rnd(18);
  const bearer = rnd(40);
  const pemLines = [rnd(64, B64), rnd(64, B64), rnd(40, B64)];
  return {
    openai: { text: 'sk-' + 'proj-' + openai, body: openai },
    anthropic: { text: 'sk-' + 'ant-' + 'api03-' + anthropic, body: anthropic },
    github: { text: 'gh' + 'p_' + github, body: github },
    aws: { text: 'AK' + 'IA' + aws, body: aws },
    postgres: { text: 'postgres://' + 'billing_app:' + pgPass + '@db.example.internal:5432/billing', body: pgPass },
    sqlserver: { text: 'Server=db.example.internal;Database=billing;User Id=billing;' + 'Pass' + 'word=' + sqlPass + ';', body: sqlPass },
    bearer: { text: 'Bear' + 'er ' + bearer, body: bearer },
    pem: {
      text: '-----BEGIN ' + 'RSA PRIVATE ' + 'KEY-----\n' + pemLines.join('\n') + '\n-----END ' + 'RSA PRIVATE ' + 'KEY-----',
      body: pemLines[0],
      more: pemLines.slice(1),
    },
  };
}

type Secrets = ReturnType<typeof makeSecrets>;

/** Every body string (with a few extra PEM lines) that must not be on screen while masking is on. */
function bodies(s: Secrets): [string, string][] {
  const out: [string, string][] = Object.entries(s).map(([k, v]) => [k, v.body]);
  for (const line of s.pem.more) out.push(['pem', line]);
  return out;
}

const VIEWS: [string, string][] = [
  ['Activity', 'view-activity'],
  ['Overview', 'view-overview'],
  ['Tools', 'view-tools'],
  ['Files', 'view-files'],
  ['Timeline', 'view-timeline'],
  ['Code changed', 'view-changes'],
];

/** Expands anything collapsed (details, "show more", tool rows) so hidden text would be visible too. */
async function expandAll(page: Page) {
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('details')) (d as HTMLDetailsElement).open = true;
  });
  const toggles = page.locator('main [aria-expanded="false"]');
  const n = Math.min(await toggles.count(), 40);
  for (let i = 0; i < n; i++) await toggles.nth(i).click({ timeout: 2_000 }).catch(() => {});
}

/** The window's text in every run view plus the palette, one string per place. */
async function collectText(page: Page, search: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, testId] of VIEWS) {
    await page.getByRole('radio', { name, exact: true }).first().click();
    await expect(page.getByTestId(testId)).toBeVisible();
    await page.waitForTimeout(300);
    await expandAll(page);
    out[name] = await page.evaluate(() => document.body.innerText);
  }
  // Command palette: search for a word from the prompt; the run (with its title) is listed.
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+K');
  const input = page.getByRole('combobox', { name: 'Search runs and commands' });
  await expect(input).toBeFocused();
  await input.fill(search);
  await expect(page.locator('[cmdk-item]').first()).toBeVisible();
  await page.waitForTimeout(300);
  out.palette = await page.evaluate(() => document.body.innerText);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return out;
}

let home = '';
let launched: Launched | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  removeDir(home);
});

test('masking on hides every planted secret in all views and the palette; masking off shows them', async () => {
  const s = makeSecrets();
  home = tempDir('home');
  const cwd = 'C:\\Users\\demo\\code\\billing-service';
  const session = new SessionWriter(cwd, Date.now() - 10 * 60_000)
    .user(
      `Billing deploy check. Use ${s.openai.text} and ${s.anthropic.text}, push with ${s.github.text}, ` +
        `AWS key ${s.aws.text}. DB is ${s.postgres.text} and the old one is "${s.sqlserver.text}".`,
    )
    .assistantText('I will run the deploy script with those settings.')
    .toolUse('Bash', {
      command: `curl -H "Authorization: ${s.bearer.text}" https://api.example.internal/deploy && DATABASE_URL=${s.postgres.text} ./deploy.sh`,
      description: `Deploy with ${s.openai.text}`,
    })
    .toolResult(`deploy ok\nconnected to ${s.postgres.text}\nkey file:\n${s.pem.text}\ntoken ${s.github.text} accepted (aws ${s.aws.text})`)
    .toolUse('Write', { file_path: `${cwd}\\deploy.env`, content: `OPENAI_KEY=${s.openai.text}\nANTHROPIC_KEY=${s.anthropic.text}\n${s.sqlserver.text}` })
    .toolResult(`File created successfully at: ${cwd}\\deploy.env`)
    .assistantText(`Deployed. Used the bearer ${s.bearer.text} once.`, 'end_turn');
  const file = session.write(path.join(home, '.claude'));
  expect(file.startsWith(home)).toBe(true);

  launched = await launchApp({ home, settings: baseSettings({ maskSecrets: true, historyDays: 0 }) });
  const { page } = launched;
  await waitForRuns(page, 1);
  const row = page.getByTestId('run-list').getByRole('option', { name: /Billing deploy check/ }).first();
  await row.click();
  await expect(page.getByTestId('run-title')).toContainText('Billing deploy check');

  // ---- masking on ----
  const masked = await collectText(page, 'billing');
  const leaks: string[] = [];
  for (const [where, text] of Object.entries(masked)) {
    for (const [kind, body] of bodies(s)) if (text.includes(body)) leaks.push(`${kind} in ${where}`);
  }
  expect(leaks, 'secret bodies visible with masking on').toEqual([]);
  // The masks themselves are visible, so the secret-bearing text really was rendered.
  const all = Object.values(masked).join('\n');
  expect(all).toContain('••••');
  for (const label of ['[OpenAI key]', '[Anthropic key]', '[GitHub token]', '[AWS access key]', '[private key]']) expect(all).toContain(label);
  // Also nothing in the window's state the renderer holds: the IPC payload itself is masked.
  const detailJson = await page.evaluate(async () => {
    const b = (window as unknown as { armBackend: { listRuns(): Promise<{ id: string }[]>; getRun(id: string): Promise<unknown> } }).armBackend;
    const runs = await b.listRuns();
    return JSON.stringify(await Promise.all(runs.map((r) => b.getRun(r.id))));
  });
  for (const [kind, body] of bodies(s)) expect(detailJson.includes(body), `${kind} in IPC detail`).toBe(false);

  // ---- masking off (Settings) ----
  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('settings-screen')).toBeVisible();
  const sw = page.getByRole('switch', { name: 'Mask likely secrets' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-screen')).toHaveCount(0);
  await expect(page.getByTestId('run-title')).toBeVisible();

  // The app re-sends the open run unmasked; wait until the title shows a raw key.
  await expect(page.getByTestId('run-title')).toContainText(s.openai.body.slice(0, 12), { timeout: 20_000 }).catch(() => {});
  let unmasked: Record<string, string> = {};
  await expect(async () => {
    unmasked = await collectText(page, 'billing');
    const allText = Object.values(unmasked).join('\n');
    const missing = bodies(s)
      .filter(([, body]) => !allText.includes(body))
      .map(([kind]) => kind);
    expect(missing, 'secret bodies NOT visible with masking off').toEqual([]);
  }).toPass({ timeout: 60_000 });

  // Per-place visibility with masking off, for the report.
  const shown: Record<string, string[]> = {};
  for (const [where, text] of Object.entries(unmasked)) shown[where] = bodies(s).filter(([, b]) => text.includes(b)).map(([k]) => k);
  test.info().annotations.push({ type: 'unmasked-visible-per-place', description: JSON.stringify(shown) });
  test.info().annotations.push({ type: 'secret-kinds', description: String(Object.keys(s).length) });

  expect(launched.errors, 'errors in the window').toEqual([]);
});
