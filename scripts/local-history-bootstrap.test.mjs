import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';

const gitPaths = process.platform === 'win32'
  ? (spawnSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
  : [];
const bash = [join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe'), ...gitPaths.flatMap(path => [join(dirname(path), '../bin/bash.exe'), join(dirname(path), '../../bin/bash.exe')])].find(existsSync);

describe.skipIf(process.platform !== 'win32')('native history bootstrap', () => {
  for (const engine of ['powershell.exe', 'pwsh.exe']) {
    it(`${engine}: native history options, highlight off, editor/filter preservation and fallback`, () => {
      const fixture = readFileSync('scripts/test-local-history-bootstrap.ps1', 'utf8');
      const bootstrap = resolve('src-tauri/src/services/local_terminal_service/highlight/powershell.ps1');
      const command = `& {${fixture}} -Bootstrap '${bootstrap.replaceAll("'", "''")}'`;
      const result = spawnSync(engine, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      if (engine === 'pwsh.exe' && result.error?.code === 'ENOENT') return;
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      for (const name of ['modern', 'legacy', 'highlight-off', 'runtime-failure', 'storage-failure', 'module-missing', 'custom-editor']) expect(result.stdout).toContain(`PASS ${name}`);
      expect(result.stdout).toContain('fstty-history:e6b4ea51-2f6b-4449-9550-f4b20082a620:failed\x07');
    }, 30_000);
  }

  for (const scenario of ['string-prompt', 'missing-path', 'readonly-prompt', 'readonly-history']) {
    it.skipIf(!bash)(`Git Bash ${scenario}: preserves native customization and does not import external history`, () => {
      const root = mkdtempSync(join(tmpdir(), 'fstty-history-fallback-'));
      try {
        const unix = path => path.replaceAll('\\', '/').replaceAll("'", "'\\''");
        const external = join(root, 'external-history');
        const managed = join(root, 'managed-history');
        writeFileSync(external, 'echo EXTERNAL_HISTORY_SENTINEL\n');
        writeFileSync(managed, 'echo MANAGED_HISTORY_SENTINEL\n');
        writeFileSync(join(root, '.bash_profile'), `HISTFILE='${unix(external)}'\n${scenario === 'readonly-history' ? 'readonly HISTFILE\n' : ''}HISTSIZE=5\nHISTFILESIZE=10\nHISTIGNORE='echo ignored-*'\nPROMPT_COMMAND='printf "CUSTOM_PROMPT\\n"'\n${scenario === 'readonly-prompt' ? 'readonly PROMPT_COMMAND\n' : ''}PS1='READY> '\n`);
        const script = readFileSync('src-tauri/src/services/local_terminal_service/highlight/bash.sh', 'utf8')
          .replaceAll('__COMMAND_TOKEN__', '')
          .replaceAll('__HISTORY_TOKEN__', 'e6b4ea51-2f6b-4449-9550-f4b20082a620')
          .replaceAll('__HISTORY_PATH__', scenario === 'missing-path' ? "''" : `'${unix(managed)}'`);
        const rc = join(root, 'history.sh');
        writeFileSync(rc, script);
        const result = spawnSync(bash, ['--noprofile', '--rcfile', unix(rc), '-i'], { input: "echo ignored-private\nprintf '%s\\n' \\\n '中文 multi-line'\nhistory\nexit\n", env: { ...process.env, HOME: unix(root), CHERE_INVOKING: '1' }, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toContain('EXTERNAL_HISTORY_SENTINEL');
        expect(readFileSync(external, 'utf8')).toBe('echo EXTERNAL_HISTORY_SENTINEL\n');
        if (scenario !== 'readonly-history') expect(`${result.stdout}${result.stderr}`).toContain('CUSTOM_PROMPT');
        if (scenario === 'string-prompt') {
          expect(result.stdout).toContain('MANAGED_HISTORY_SENTINEL');
          expect(readFileSync(managed, 'utf8')).toContain('中文 multi-line');
          expect(readFileSync(managed, 'utf8')).not.toContain('ignored-private');
        } else {
          expect(`${result.stdout}${result.stderr}`.match(/fstty-history:[^:]+:failed/g)).toHaveLength(1);
          expect(readFileSync(managed, 'utf8')).toBe('echo MANAGED_HISTORY_SENTINEL\n');
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }, 15_000);
  }

  it.skipIf(!bash)('Git Bash restores private history and persists before force-stop; preserves prompt, filtering and concurrent additions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fstty-bash-history-'));
    const home = join(root, 'home');
    mkdirSync(home);
    const history = join(root, 'history');
    writeFileSync(history, 'echo restored-fixture\n');
    writeFileSync(join(home, '.bash_profile'), `HISTCONTROL=ignorespace\nPROMPT_COMMAND=('printf "USER_PROMPT\\n"')\nPS1='FSTTY_PROMPT> '\n`);
    const script = readFileSync('src-tauri/src/services/local_terminal_service/highlight/bash.sh', 'utf8')
      .replaceAll('__COMMAND_TOKEN__', '')
          .replaceAll('__HISTORY_TOKEN__', 'e6b4ea51-2f6b-4449-9550-f4b20082a620')
      .replaceAll('__HISTORY_PATH__', `'${history.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`);
    const rc = join(root, 'history.sh');
    writeFileSync(rc, script);
    const children = [];
    function start() {
      const child = spawn(bash, ['--noprofile', '--rcfile', rc.replaceAll('\\', '/'), '-i'], { env: { ...process.env, HOME: home.replaceAll('\\', '/'), CHERE_INVOKING: '1' }, windowsHide: true });
      children.push(child);
      let output = '';
      child.stdout.on('data', data => { output += data.toString(); });
      child.stderr.on('data', data => { output += data.toString(); });
      return { child, output: () => output, clear: () => { output = ''; } };
    }
    async function prompt(shell, command) {
      shell.clear();
      if (command) shell.child.stdin.write(`${command}\n`);
      await expect.poll(shell.output, { timeout: 10_000 }).toContain('FSTTY_PROMPT> ');
      expect(shell.output()).not.toContain('fstty-history:');
    }
    try {
      const first = start();
      await prompt(first);
      await prompt(first, 'echo accepted-中文');
      await prompt(first, ' echo filtered-private');
      const second = start();
      await prompt(second);
      await prompt(second, 'echo second-tab');
      await prompt(first, 'history');
      // Other tabs' additions are loaded at the prompt following the command.
      await prompt(first, 'history');
      expect(first.output()).toContain('restored-fixture');
      expect(first.output()).toContain('second-tab');
      expect(first.output()).not.toContain('filtered-private');
      expect(first.output()).toContain('USER_PROMPT');
      first.child.kill();
      second.child.kill();
      const saved = readFileSync(history, 'utf8');
      expect(saved).toContain('accepted-中文');
      expect(saved).toContain('second-tab');
      expect(saved).not.toContain('filtered-private');
      expect(saved.match(/echo accepted-中文/g)).toHaveLength(1);
      const reopened = start();
      await prompt(reopened);
      await prompt(reopened, 'history');
      expect(reopened.output()).toContain('accepted-中文');
      expect(reopened.output()).toContain('second-tab');
    } finally {
      await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; } child.once('close', resolve); child.kill(); })));
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
