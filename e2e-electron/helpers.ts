// Shared helpers for the end-to-end tests against the REAL Electron app (out/, built by
// `npm run build`). Every launch gets a fresh settings folder (ARM_USER_DATA) and, unless a test
// asks for the real home, a fake home (ARM_HOME) that only holds synthetic sessions.
//
// ELECTRON_RUN_AS_NODE is removed from the environment: when an editor's terminal sets it,
// Electron starts as plain Node and never opens a window.

import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '..');

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `arm-e2e-${prefix}-`));
}

export function removeDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may still hold a file for a moment; the OS cleans its temp folder eventually. */
  }
}

export interface LaunchOptions {
  /** Fake home for the adapters (ARM_HOME). `null` = the real home (local-only tests). */
  home: string | null;
  /** Settings written to settings.json before launch. Omit to start with no file (wizard runs). */
  settings?: Record<string, unknown>;
  /** Extra Chromium/Electron command line arguments, appended after '.'. */
  args?: string[];
  env?: Record<string, string>;
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
  /** console.error lines and uncaught exceptions seen in the window. */
  errors: string[];
  close(): Promise<void>;
}

/** Settings that skip the wizard; merge test-specific values on top. */
export function baseSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, firstRunComplete: true, notifyOnFinish: false, notifyOnFailure: false, ...extra };
}

export async function launchApp(opts: LaunchOptions): Promise<Launched> {
  const userData = tempDir('userdata');
  if (opts.settings) writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(opts.settings, null, 2));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  // Never point the app at a dev server.
  delete env.ELECTRON_RENDERER_URL;
  delete env.ARM_HOME;
  delete env.ARM_OPEN_LAYOUT;
  Object.assign(env, { ARM_USER_DATA: userData, ARM_E2E: '1' }, opts.env ?? {});
  if (opts.home) env.ARM_HOME = opts.home;

  const app = await _electron.launch({ args: ['.', ...(opts.args ?? [])], cwd: REPO, env, timeout: 60_000 });
  const page = await app.firstWindow({ timeout: 60_000 });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
  await page.waitForLoadState('domcontentloaded');
  let closed = false;
  return {
    app,
    page,
    userData,
    errors,
    async close() {
      if (closed) return;
      closed = true;
      await app.close().catch(() => {});
      removeDir(userData);
    },
  };
}

/** Waits for the run list to have at least `n` rows. */
export async function waitForRuns(page: Page, n = 1, timeout = 45_000): Promise<void> {
  await expect(page.getByTestId('run-list').getByRole('option').nth(n - 1)).toBeVisible({ timeout });
}

/** Number of runs in the status bar ("<b>N</b> runs"). */
export async function statusBarRunCount(page: Page): Promise<number> {
  const text = (await page.getByRole('contentinfo', { name: 'Status bar' }).textContent()) ?? '';
  const m = /(\d[\d,]*)\s*runs/.exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : -1;
}

// ---- synthetic Claude Code sessions (2.1.x record shape, made-up values) ---------------------------

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

let counter = 0;
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
export const fakeUuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;

/** Builds Claude Code transcript records for one session. */
export class SessionWriter {
  readonly id = fakeUuid();
  private parent: string | null = null;
  private t: number;
  readonly lines: string[] = [];
  private lastToolId = '';

  constructor(
    readonly cwd: string,
    start = Date.now() - 60_000,
  ) {
    this.t = start;
  }

  private envelope(type: string, extra: Record<string, unknown>): Record<string, unknown> {
    const uuid = fakeUuid();
    this.t += 700;
    const rec = {
      parentUuid: this.parent,
      isSidechain: false,
      userType: 'external',
      cwd: this.cwd,
      sessionId: this.id,
      version: '2.1.309',
      gitBranch: 'main',
      type,
      ...extra,
      uuid,
      timestamp: new Date(this.t).toISOString(),
    };
    this.parent = uuid;
    return rec;
  }

  private push(rec: Record<string, unknown>): this {
    this.lines.push(JSON.stringify(rec));
    return this;
  }

  user(text: string): this {
    return this.push(this.envelope('user', { message: { role: 'user', content: [{ type: 'text', text }] }, permissionMode: 'default' }));
  }

  title(text: string): this {
    return this.push({ type: 'ai-title', aiTitle: text, sessionId: this.id });
  }

  assistantText(text: string, stop: string | null = null): this {
    return this.push(
      this.envelope('assistant', {
        message: {
          model: 'claude-sonnet-4-5',
          id: `msg_01${hex(22)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text }],
          stop_reason: stop,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 40 },
        },
        requestId: `req_01${hex(22)}`,
      }),
    );
  }

  toolUse(name: string, input: Record<string, unknown>): this {
    this.lastToolId = `toolu_01${hex(22)}${++counter}`;
    return this.push(
      this.envelope('assistant', {
        message: {
          model: 'claude-sonnet-4-5',
          id: `msg_01${hex(22)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: this.lastToolId, name, input }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 40 },
        },
        requestId: `req_01${hex(22)}`,
      }),
    );
  }

  toolResult(content: string, isError = false): this {
    return this.push(
      this.envelope('user', {
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: this.lastToolId, content, is_error: isError }] },
        toolUseResult: { stdout: content, stderr: '', interrupted: false, isImage: false },
      }),
    );
  }

  private written = 0;
  private file = '';

  /** Writes <claudeDir>/projects/<encoded cwd>/<id>.jsonl and returns the path. */
  write(claudeDir: string): string {
    const dir = path.join(claudeDir, 'projects', encodeCwd(this.cwd));
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${this.id}.jsonl`);
    writeFileSync(this.file, `${this.lines.join('\n')}\n`);
    this.written = this.lines.length;
    return this.file;
  }

  /** Appends the records added since the last write (a live, growing session). */
  appendNew(): void {
    if (!this.file) throw new Error('write() first');
    const fresh = this.lines.slice(this.written);
    this.written = this.lines.length;
    if (fresh.length) appendFileSync(this.file, `${fresh.join('\n')}\n`);
  }

  /** Moves the record clock to now (live sessions append with current timestamps). */
  clockNow(): this {
    this.t = Date.now() - 700;
    return this;
  }
}

/** Opens a run through the app's own "open run" channel (what a notification click uses). */
export async function openRunById(app: ElectronApplication, page: Page, id: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, runId) => BrowserWindow.getAllWindows()[0].webContents.send('arm:ev:openRun', runId), id);
  await expect.poll(async () => (await page.locator('.runview').getAttribute('data-run-id')) === id).toBe(true);
}

/** Entries under the "Part of" and "Sub-runs" headings of the open run's Overview. */
export async function relatedRunCounts(page: Page): Promise<{ partOf: number; subRuns: number }> {
  await page.getByRole('radio', { name: 'Overview', exact: true }).first().click();
  const ov = page.getByTestId('view-overview');
  await expect(ov).toBeVisible();
  await page.waitForTimeout(300);
  const section = (name: string) => ov.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const count = async (name: string) => ((await section(name).count()) ? section(name).locator('li').count() : 0);
  return { partOf: await count('Part of'), subRuns: await count('Sub-runs') };
}
