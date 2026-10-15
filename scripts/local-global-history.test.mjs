import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';

const token = 'e6b4ea51-2f6b-4449-9550-f4b20082a620';
const bootstrap = resolve('src-tauri/src/services/local_terminal_service/highlight/powershell.ps1');
function commands(output) {
  const records = [];
  let continuation = false;
  for (const match of output.matchAll(new RegExp(`\\x1b\\]777;fstty-global:${token}:([^\\x07]*)\\x07`, 'g'))) {
    const value = match[1];
    if (value === 'continuation') continuation = true;
    if (value.startsWith('input:')) continuation = false;
    const command = /^command:(\d+):([A-Za-z0-9+/=]+)$/.exec(value);
    if (command) {
      const text = Buffer.from(command[2], 'base64').toString('utf8');
      if (!continuation && !Array.from(text).some(c => c.codePointAt(0) <= 31 || (c.codePointAt(0) >= 127 && c.codePointAt(0) <= 159))) records.push({ sequence: Number(command[1]), text });
      continuation = false;
    }
  }
  return records;
}

describe.skipIf(process.platform !== 'win32')('local global history native observers', () => {
  it('Clink: observes accepted callbacks, preserves filtering and never overrides an occupied insertion key', () => {
    const root = mkdtempSync(join(tmpdir(), 'fstty-clink-global-'));
    try {
      const source = readFileSync('src-tauri/src/services/local_terminal_service/highlight/clink.lua', 'utf8')
        .replaceAll('__COMMAND_TOKEN__', token).replaceAll('__HISTORY_TOKEN__', '').replaceAll('__TOKEN__', '');
      for (const occupied of [false, true, 'keymap']) {
        const fixture = `
local callbacks = {}
local binding = ${occupied === 'keymap' ? "'incomplete'" : occupied ? "'user-custom-action'" : 'nil'}
settings = { get=function(key) return key == 'history.ignore_space' end, set=function() end }
rl = { getbinding=function() if binding=='incomplete' then return nil, 'keymap' end; return binding end, setbinding=function(_, value) assert(not binding); binding=value end }
clink = {
  onhistory=function(fn) callbacks.history=fn end,
  onbeginedit=function(fn) callbacks.begin=fn end,
  onendedit=function(fn) callbacks.finish=fn end,
  promptfilter=function() callbacks.prompt={}; return callbacks.prompt end,
  classifier=function() return {} end,
}
` + source + `
callbacks.begin()
callbacks.prompt:filter('')
assert(callbacks.history('echo accepted-中文') == nil)
assert(callbacks.history('echo accepted-中文') == nil)
callbacks.history(' echo hidden-private')
callbacks.history('echo multi\\nprivate')
callbacks.history('')
callbacks.history('echo caret^')
callbacks.history('if 1==1 (')
local buffer = { value='draft in middle', cursor=4 }
function buffer:beginundogroup() end
function buffer:endundogroup() end
function buffer:getlength() return #self.value end
function buffer:remove(start, finish) assert(start==1 and finish==#self.value+1); self.value='' end
function buffer:setcursor(value) self.cursor=value end
__fstty_clear_input(buffer)
assert(buffer.value=='' and buffer.cursor==1)
callbacks.finish()
`;
        const script = join(root, 'fixture.lua'); writeFileSync(script, fixture);
        const result = spawnSync(resolve('src-tauri/vendor/clink-1.9.34/bin/clink_x64.exe'), ['lua', '-E', script], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(commands(result.stdout)).toEqual([{ sequence: 1, text: 'echo accepted-中文' }, { sequence: 2, text: 'echo accepted-中文' }]);
        expect(result.stdout).toContain(`:input:${occupied ? 'copy' : 'clear'}\x07`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  for (const engine of ['powershell.exe', 'pwsh.exe']) {
    it(`${engine}: preserves filter results, observes accepted single lines and ignores file reload`, () => {
      const fixture = readFileSync('scripts/test-local-global-history.ps1', 'utf8');
      const code = `& {${fixture}} -Bootstrap '${bootstrap.replaceAll("'", "''")}'`;
      const result = spawnSync(engine, ['-NoProfile', '-NoLogo', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      if (engine === 'pwsh.exe' && result.error?.code === 'ENOENT') return;
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      for (const scenario of ['allow', 'memory', 'skip', 'false', 'multiline', 'cancel', 'custom', 'binding']) expect(result.stdout).toContain(`PASS ${scenario}`);
      for (const section of result.stdout.split('BEGIN ').slice(1)) {
        const scenario = section.split(/\s/)[0];
        const recorded = commands(section);
        if (scenario === 'allow') expect(recorded).toEqual([{ sequence: 1, text: 'echo 中文 & quoted' }, { sequence: 2, text: 'echo 中文 & quoted' }]);
        else if (scenario === 'binding') expect(recorded).toEqual([{ sequence: 1, text: 'echo 中文 & quoted' }]);
        else expect(recorded).toEqual([]);
      }
      expect(result.stdout).toContain(':input:clear\x07');
      expect(result.stdout).toContain(':input:copy\x07');
      expect(result.stdout).toContain(':unavailable\x07');
    }, 30_000);
  }

  it.skipIf(!existsSync('C:/Program Files/Git/bin/bash.exe'))('Git Bash: observes before execution; rejects native filters/multiline and does not import old history', () => {
    const root = mkdtempSync(join(tmpdir(), 'fstty-global-history-'));
    const unix = value => value.replaceAll('\\', '/').replaceAll("'", "'\\''");
    try {
      const history = join(root, 'history');
      writeFileSync(history, 'echo OLD_FILE_COMMAND\n');
      writeFileSync(join(root, '.bash_profile'), `exec 2>&1\nHISTCONTROL=ignorespace\nHISTIGNORE='echo ignored-*'\nPROMPT_COMMAND='printf "USER_PROMPT\\n"'\nPS0='USER_PREEXEC\\n'\nPS1='READY> '\n`);
      const source = readFileSync('src-tauri/src/services/local_terminal_service/highlight/bash.sh', 'utf8').replaceAll('__COMMAND_TOKEN__', token).replaceAll('__HISTORY_TOKEN__', token).replaceAll('__HISTORY_PATH__', `'${unix(history)}'`);
      const rc = join(root, 'history.sh'); writeFileSync(rc, source);
      const result = spawnSync('C:/Program Files/Git/bin/bash.exe', ['--noprofile', '--rcfile', unix(rc), '-i'], { input: "echo accepted-中文\n echo hidden-private\necho ignored-private\nprintf '%s\\n' \\\n 'multi-private'\necho repeated\necho repeated\nexit\n", encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, HOME: unix(root), CHERE_INVOKING: '1' } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const recorded = commands(result.stdout);
      expect(recorded.map(v => v.text), result.stdout + result.stderr).toEqual(['echo accepted-中文', 'echo repeated', 'echo repeated', 'exit']);
      expect(new Set(recorded.map(v => v.sequence)).size).toBe(recorded.length);
      expect(result.stdout).toContain('USER_PROMPT');
      expect(result.stdout).toContain('USER_PREEXEC');
      expect(result.stdout).toContain(':input:clear\x07');
      expect(readFileSync(history, 'utf8')).toContain('accepted-中文');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
});
