import { describe, expect, it } from 'vitest';
import { makeEnv } from './env';
import { createRegistry } from './registry';
import type { SourceAdapter } from './adapter';

describe('makeEnv', () => {
  it('uses the real home and env without ARM_HOME', () => {
    const env = makeEnv({ platform: 'linux', homedir: '/home/alex', env: { CODEX_HOME: '/home/alex/.codex', X: '1' } });
    expect(env.home).toBe('/home/alex');
    expect(env.vars.CODEX_HOME).toBe('/home/alex/.codex');
  });

  it('redirects home-like variables and drops paths into the real profile under ARM_HOME', () => {
    const env = makeEnv({
      platform: 'win32',
      homedir: 'C:\\Users\\alex',
      env: {
        ARM_HOME: 'D:\\tmp\\clean',
        USERPROFILE: 'C:\\Users\\alex',
        APPDATA: 'C:\\Users\\alex\\AppData\\Roaming',
        CLAUDE_CONFIG_DIR: 'C:\\Users\\alex\\.claude-work',
        CODEX_HOME: 'D:\\tmp\\clean\\.codex',
        PATH: 'C:\\Windows;C:\\Users\\alex\\bin',
        SystemRoot: 'C:\\Windows',
      },
    });
    expect(env.home).toBe('D:\\tmp\\clean');
    expect(env.vars.USERPROFILE).toBe('D:\\tmp\\clean');
    expect(env.vars.APPDATA).toBe('D:\\tmp\\clean\\AppData\\Roaming');
    expect(env.vars.LOCALAPPDATA).toBe('D:\\tmp\\clean\\AppData\\Local');
    expect(env.vars.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.vars.CODEX_HOME).toBe('D:\\tmp\\clean\\.codex');
    expect(env.vars.PATH).toBe('C:\\Windows;C:\\Users\\alex\\bin');
    expect(env.vars.SystemRoot).toBe('C:\\Windows');
  });

  it('points XDG folders into ARM_HOME on Linux and macOS', () => {
    const env = makeEnv({
      platform: 'linux',
      homedir: '/home/alex',
      env: { ARM_HOME: '/tmp/clean', XDG_CONFIG_HOME: '/home/alex/.config', GEMINI_DIR: '/home/alex/.gemini' },
    });
    expect(env.vars.HOME).toBe('/tmp/clean');
    expect(env.vars.XDG_CONFIG_HOME).toBe('/tmp/clean/.config');
    expect(env.vars.GEMINI_DIR).toBeUndefined();
  });
});

describe('createRegistry', () => {
  const fake = (id: string) =>
    ({ id, displayName: id, confidence: 'best-effort', note: '', defaultRoots: () => [], discover: async () => [], parse: async () => { throw new Error('x'); } }) as unknown as SourceAdapter;

  it('keeps the first adapter per id and skips malformed entries', () => {
    const warnings: string[] = [];
    const a = fake('codex');
    const reg = createRegistry([a, fake('codex'), { id: 'aider' }, null, fake('aider')], (m) => warnings.push(m));
    expect(reg.ids()).toEqual(['codex', 'aider']);
    expect(reg.get('codex')).toBe(a);
    expect(warnings).toHaveLength(3);
  });
});
