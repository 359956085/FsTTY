import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const bootstrap = resolve('src-tauri/src/services/local_terminal_service/highlight/powershell.ps1');
const fixture = readFileSync('scripts/test-psreadline-bootstrap.ps1', 'utf8');
const command = `& {${fixture}} -Bootstrap '${bootstrap.replaceAll("'", "''")}'`;
const encoded = Buffer.from(command, 'utf16le').toString('base64');

describe.skipIf(process.platform !== 'win32')('PowerShell bootstrap new/legacy interfaces', () => {
  for (const engine of ['powershell.exe', 'pwsh.exe']) {
    it(`${engine}: ANSI/legacy, module failure, custom editor and phase markers`, () => {
      const result = spawnSync(engine, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      if (engine === 'pwsh.exe' && result.error?.code === 'ENOENT') return;
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      for (const scenario of ['modern', 'legacy', 'missing', 'custom', 'elevated-owner', 'elevated-write', 'elevated-trusted', 'elevated-sid-read', 'elevated-acl-error', 'elevated-candidate-error']) expect(result.stdout).toContain(`PASS ${scenario}`);
      for (const phase of ['ready', 'input', 'execute', 'prompt', 'failed:psreadline-import', 'failed:custom-line-editor', 'failed:psreadline-security']) expect(result.stdout).toContain(`:${phase}\x07`);
      expect(result.stdout).not.toContain('private-command-not-logged');
    });
  }
});

it('Clink provenance supplies source, patch, license and pinned embedded binaries', () => {
  const root = 'src-tauri/vendor/clink-1.9.34';
  const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, 'utf8'));
  expect(manifest.version).toBe('1.9.34');
  for (const name of ['source.zip', 'isolation.patch', 'LICENSE', 'build.ps1']) expect(existsSync(`${root}/${name}`)).toBe(true);
  expect(readFileSync(`${root}/isolation.patch`, 'utf8')).toContain('never load user/registry extensions');
});
