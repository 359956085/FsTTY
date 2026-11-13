import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// NSIS is a packaging tool, not a prerequisite for ordinary frontend checks.
// FSTTY_NSIS_DIR enables this native fixture with the same NSIS used to package.
const candidates = [
  process.env.FSTTY_NSIS_DIR && join(process.env.FSTTY_NSIS_DIR, 'makensis.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'NSIS', 'makensis.exe'),
];
const compiler = candidates.find(candidate => candidate && existsSync(candidate));

it.skipIf(process.platform !== 'win32' || !compiler)('activates only after the visible welcome page and cancels deferred work in NSIS', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fstty-wizard-focus-'));
  const executable = join(directory, 'fixture.exe');
  const resultFile = join(directory, 'result.ini');
  try {
    for (const native of [false, true]) {
      const compile = spawnSync(compiler, [
        '/V2',
        `/DFIXTURE_EXE=${executable}`,
        `/DFIXTURE_RESULT=${resultFile}`,
        `/DFOCUS_HEADER=${resolve('src-tauri/windows/wizard-focus.nsh')}`,
        ...(native ? ['/DFIXTURE_NATIVE'] : []),
        resolve('scripts/fixtures/windows-wizard-focus.nsi'),
      ], { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: { ...process.env, NSISDIR: dirname(compiler) } });
      expect(compile.error).toBeUndefined();
      expect(compile.status, compile.stdout + compile.stderr).toBe(0);
      const scenarios = native
        ? ['update', 'silent', ...(process.env.FSTTY_FOCUS_NATIVE === '1' ? ['success', 'success', 'success', 'success', 'success', 'back'] : [])]
        : ['active', 'success', 'denied', 'hidden', 'minimized', 'earlyleave', 'closed', 'back', 'silent', 'update'];
      for (const scenario of scenarios) {
        rmSync(resultFile, { force: true });
        const run = spawnSync(executable, [
          ...(scenario === 'silent' ? ['/S'] : []),
          `/CASE=${scenario}`,
        ], { windowsHide: false, timeout: 10_000 });
        expect(run.error, scenario).toBeUndefined();
        expect(run.status, scenario).toBe(0);
        const result = Object.fromEntries(readFileSync(resultFile, 'utf8')
          .split(/\r?\n/).filter(line => line.includes('='))
          .map(line => line.split('=')));
        const blocked = scenario === 'silent' || scenario === 'update';
        const canceled = ['earlyleave', 'closed', 'hidden', 'minimized'].includes(scenario);
        if (native) expect(['0', '1'], scenario).toContain(result.bring);
        else expect(result.bring, scenario).toBe(!blocked && !canceled && scenario !== 'active' ? '1' : '0');
        if (native && !blocked) expect(['0', '1'], scenario).toContain(result.flash);
        else expect(result.flash, scenario).toBe(!native && ['denied', 'back'].includes(scenario) ? '1' : '0');
        expect(result.attempted, scenario).toBe(blocked || canceled ? '' : '1');
        expect(result.pending, scenario).toBe(blocked ? '' : '0');
        expect(result.scheduled, scenario).toBe(blocked ? '' : '1');
        if (!blocked) {
          expect(result.guiVisible, scenario).toBe('0');
          expect(result.welcomeCount, scenario).toBe(['back', 'earlyleave'].includes(scenario) ? '2' : '1');
          if (!canceled && scenario !== 'active') {
            if (result.bring !== '0') expect(result.visibleAtActivation, scenario).toBe('1');
          }
          if (native) {
            if (result.foreground === '1') expect(result.focusWithin, scenario).toBe('1');
            else expect(result.flash, 'Native activation refused: must notify').toBe('1');
            if (process.env.FSTTY_FOCUS_REQUIRE_FOREGROUND === '1') expect(result.foreground, scenario).toBe('1');
            if (process.env.FSTTY_FOCUS_REPORT) {
              appendFileSync(process.env.FSTTY_FOCUS_REPORT, JSON.stringify({ scenario, ...result }) + '\n');
            }
          }
        }
      }
    }

    // Compile the production template and its real hook/include chain with
    // harmless payloads. Never run this compile-only installer.
    const hooks = join(directory, 'hooks.nsh');
    writeFileSync(hooks, [
      `!include "${resolve('src-tauri/windows/broker-hooks.nsh')}"`,
      '!undef FSTTY_BROKER_BINARY',
      `!define FSTTY_BROKER_BINARY "${executable}"`,
    ].join('\n'));
    const values = {
      additional_plugins_path: join(dirname(compiler), 'Plugins', 'x86-unicode'),
      out_file: join(directory, 'compile-only-do-not-install.exe'),
      // Independent fixture version; future project bumps need no test edit.
      version_with_build: '1.2.3.0',
      version: '1.2.3-beta.4',
      installer_icon: resolve('src-tauri/icons/icon.ico'),
      uninstaller_icon: resolve('src-tauri/icons/icon.ico'),
      installer_hooks: hooks,
      main_binary_path: executable,
      webview2_bootstrapper_path: executable,
    };
    const template = readFileSync('src-tauri/windows/installer.nsi', 'utf8')
      .replace(/\{\{(\w+)\}\}/g, (_, name) => {
        if (!(name in values)) throw new Error(`Missing template value: ${name}`);
        return values[name];
      });
    const templateFile = join(directory, 'installer.nsi');
    writeFileSync(templateFile, `\uFEFF${template}`);
    const compile = spawnSync(compiler, ['/V2', templateFile], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
      env: { ...process.env, NSISDIR: dirname(compiler) },
    });
    expect(compile.error).toBeUndefined();
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
