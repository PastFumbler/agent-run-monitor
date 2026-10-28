// Locks the app down: no permissions, no navigation, no pop-ups, a strict CSP, and a network guard
// that cancels every request that is not for the app's own files. The exceptions are the opt-in
// update check and opt-in AI summaries, which main allows one URL at a time while they run.

import { app, session, shell, type Session, type WebContents } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_REPO } from '@shared/project';

export interface SecurityOptions {
  /** The dev server origin (electron-vite dev), e.g. http://localhost:5173. */
  devOrigin?: string;
  log: (msg: string) => void;
}

const LOCAL_SCHEMES = new Set(['file:', 'devtools:', 'data:', 'blob:']);
const allowedOnce = new Map<string, number>();
let blockedCount = 0;

/** Lets main fetch exactly this URL while `fn` runs (the update check, an AI summary). */
export async function withAllowedUrl<T>(url: string, fn: () => Promise<T>): Promise<T> {
  allowedOnce.set(url, (allowedOnce.get(url) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const n = (allowedOnce.get(url) ?? 1) - 1;
    if (n <= 0) allowedOnce.delete(url);
    else allowedOnce.set(url, n);
  }
}

export function blockedRequests(): number {
  return blockedCount;
}

export function contentSecurityPolicy(devOrigin?: string): string {
  const dev = devOrigin ? ` ${devOrigin}` : '';
  const devWs = devOrigin ? ` ${devOrigin.replace(/^http/, 'ws')}` : '';
  return [
    "default-src 'self'",
    // Vite's dev server injects an inline preamble for React refresh; production allows none.
    devOrigin ? `script-src 'self' 'unsafe-inline'${dev}` : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev}${devWs}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

function isDevUrl(url: URL, devOrigin?: string): boolean {
  if (!devOrigin) return false;
  const dev = new URL(devOrigin);
  return (url.protocol === 'http:' || url.protocol === 'ws:') && url.host === dev.host;
}

export function isRequestAllowed(raw: string, devOrigin?: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  if (isDevUrl(url, devOrigin)) return true;
  return allowedOnce.has(raw);
}

/** True for URLs that belong to the app's own pages (the only ones IPC accepts calls from). */
export function isAppUrl(raw: string, devOrigin?: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'file:') return true;
    return isDevUrl(url, devOrigin) && url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The project's GitHub pages: the only links the app opens in the OS browser. */
export function isProjectLink(raw: string): boolean {
  try {
    const url = new URL(raw);
    const base = `/${GITHUB_REPO}`;
    return (
      url.protocol === 'https:' &&
      url.host === 'github.com' &&
      !url.username &&
      !url.password &&
      (url.pathname === base || url.pathname.startsWith(`${base}/`))
    );
  } catch {
    return false;
  }
}

function inside(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(parent), norm(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Serves file: URLs for the app's own pages only, with the CSP attached (webRequest header hooks do
 * not run for file: responses). Any other local file, e.g. <img src="file:///C:/Users/...">, is 404.
 */
export function serveAppFiles(ses: Session, rendererDir: string, csp: string): void {
  ses.protocol.handle('file', async (req) => {
    let file: string;
    try {
      file = fileURLToPath(req.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (!inside(file, rendererDir)) return new Response('Not found', { status: 404 });
    const res = await ses.fetch(req.url, { bypassCustomProtocolHandlers: true });
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  });
}

/**
 * The session for the opt-in update check: separate from the window's, so the window's session can
 * stay on a direct connection with no proxy auto-discovery, while the check honours system proxy
 * settings. Guarded the same way: only the URL being checked may load.
 */
export function updateSession(opts: SecurityOptions): Session {
  return guardedSession('arm-update-check', 'the update session', opts);
}

/** The session for opt-in AI summaries (src/main/ai.ts): its own partition, guarded the same way. */
export function aiSession(opts: SecurityOptions): Session {
  return guardedSession('arm-ai-summary', 'the AI summary session', opts);
}

function guardedSession(partition: string, what: string, opts: SecurityOptions): Session {
  const ses = session.fromPartition(partition, { cache: false });
  if (!guarded.has(ses)) {
    guarded.add(ses);
    void ses.setProxy({ mode: 'system' });
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
      if (allowedOnce.has(details.url)) return cb({});
      blockedCount++;
      opts.log(`network guard: blocked a request from ${what}`);
      cb({ cancel: true });
    });
  }
  return ses;
}
const guarded = new WeakSet<Session>();

export function hardenSession(ses: Session, opts: SecurityOptions): void {
  // No proxy auto-discovery: on Windows, "automatically detect settings" makes Chromium look up
  // WPAD over DHCP and DNS on the local network. The window only ever loads local files.
  void ses.setProxy({ mode: 'direct' });

  // Writing text to the clipboard on a click ("copy path") is the one capability allowed; it
  // cannot read anything. Every other permission (camera, notifications from web, etc.) is denied.
  const harmless = new Set(['clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(harmless.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => harmless.has(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, cb) => cb({}));

  // The spellchecker would download dictionaries: off, and pointed at a dead local address.
  ses.setSpellCheckerEnabled(false);
  ses.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/');

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    if (isRequestAllowed(details.url, opts.devOrigin)) return cb({});
    blockedCount++;
    let where = 'an invalid URL';
    try {
      const u = new URL(details.url);
      where = `${u.protocol}//${u.host}`;
    } catch {
      /* keep the generic text */
    }
    opts.log(`network guard: blocked a request to ${where}`);
    cb({ cancel: true });
  });

  const csp = contentSecurityPolicy(opts.devOrigin);
  ses.webRequest.onHeadersReceived((details, cb) => {
    const headers = { ...(details.responseHeaders ?? {}) };
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-security-policy') delete headers[k];
    headers['Content-Security-Policy'] = [csp];
    cb({ responseHeaders: headers });
  });
}

/** Applied to every web contents the app creates. */
export function hardenContents(contents: WebContents, opts: SecurityOptions): void {
  const openIfProjectLink = (url: string) => {
    if (isProjectLink(url)) void shell.openExternal(url);
    else opts.log('blocked opening a link that is not the project page');
  };
  contents.on('will-navigate', (event, url) => {
    try {
      if (isDevUrl(new URL(url), opts.devOrigin)) return;
    } catch {
      /* fall through */
    }
    event.preventDefault();
    openIfProjectLink(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (!isRequestAllowed(url, opts.devOrigin)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openIfProjectLink(url);
    return { action: 'deny' };
  });
}

export function installGlobalGuards(opts: SecurityOptions): void {
  app.on('web-contents-created', (_event, contents) => hardenContents(contents, opts));
}
