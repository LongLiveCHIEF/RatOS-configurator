import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync } from 'fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { Extension, symlinkExtensions, unlinkExtension } from '@/server/helpers/extensions';

describe('klippy extension symlinks', () => {
	let root: string;
	let klipperDir: string;
	let extensionDir: string;
	let extrasDir: string;
	let excludeFile: string;

	const extension = (fileName: string): Extension => ({
		fileName,
		path: extensionDir,
		extensionName: fileName.replace('.py', ''),
	});

	const link = async (ext: Extension) => {
		let saved: Extension[] | null = null;
		const result = await symlinkExtensions({
			extensions: [ext],
			gitRepoPath: klipperDir,
			relativePath: 'klippy/extras',
			saveExtensions: (extensions) => {
				saved = extensions;
			},
		});
		return { result, saved };
	};

	const unlinkExt = (ext: Extension) =>
		unlinkExtension({ extension: ext, gitRepoPath: klipperDir, relativePath: 'klippy/extras' });

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'ratos-extensions-'));
		klipperDir = path.join(root, 'klipper');
		extensionDir = path.join(root, 'ratos-klippy');
		extrasDir = path.join(klipperDir, 'klippy', 'extras');
		excludeFile = path.join(klipperDir, '.git', 'info', 'exclude');
		await mkdir(extrasDir, { recursive: true });
		await mkdir(path.dirname(excludeFile), { recursive: true });
		await mkdir(extensionDir, { recursive: true });
		await writeFile(excludeFile, '');
		await writeFile(path.join(extensionDir, 'ratos.py'), '# ratos\n');
		await writeFile(path.join(extensionDir, 'gcode_shell_command.py'), '# ratos copy\n');
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('links an extension and excludes it from git', async () => {
		const { result } = await link(extension('ratos.py'));
		expect(result.symlinkResults[0].result).toBe('success');
		expect(await readlink(path.join(extrasDir, 'ratos.py'))).toBe(path.join(extensionDir, 'ratos.py'));
		expect(await readFile(excludeFile, 'utf8')).toContain('klippy/extras/ratos.py');
	});

	test('does not replace or exclude a module that Klipper ships', async () => {
		const klipperFile = path.join(extrasDir, 'gcode_shell_command.py');
		await writeFile(klipperFile, '# kalico built-in\n');
		const { result } = await link(extension('gcode_shell_command.py'));
		expect(result.symlinkResults[0].result).toBe('error');
		expect(result.symlinkResults[0].message).toContain('provided by Klipper itself');
		expect((await lstat(klipperFile)).isSymbolicLink()).toBe(false);
		expect(await readFile(klipperFile, 'utf8')).toBe('# kalico built-in\n');
		expect(await readFile(excludeFile, 'utf8')).not.toContain('gcode_shell_command.py');
	});

	test('unlinking removes the RatOS symlink', async () => {
		await link(extension('ratos.py'));
		const result = await unlinkExt(extension('ratos.py'));
		expect(result.result).toBe('success');
		expect(existsSync(path.join(extrasDir, 'ratos.py'))).toBe(false);
		expect(await readFile(excludeFile, 'utf8')).not.toContain('klippy/extras/ratos.py');
	});

	test('unlinking never deletes a module that Klipper ships', async () => {
		const klipperFile = path.join(extrasDir, 'gcode_shell_command.py');
		await writeFile(klipperFile, '# kalico built-in\n');
		const result = await unlinkExt(extension('gcode_shell_command.py'));
		expect(result.result).toBe('success');
		expect(await readFile(klipperFile, 'utf8')).toBe('# kalico built-in\n');
	});

	test('unlinking leaves symlinks to other files in place', async () => {
		const other = path.join(root, 'other.py');
		await writeFile(other, '# someone else\n');
		await symlink(other, path.join(extrasDir, 'ratos.py'));
		await unlinkExt(extension('ratos.py'));
		expect(await readlink(path.join(extrasDir, 'ratos.py'))).toBe(other);
	});

	test('removes the dangling symlink of an extension whose file was deleted', async () => {
		await link(extension('ratos.py'));
		await rm(path.join(extensionDir, 'ratos.py'));
		const { result, saved } = await link(extension('ratos.py'));
		expect(result.symlinkResults[0].result).toBe('error');
		expect(saved).toEqual([]);
		expect(await lstat(path.join(extrasDir, 'ratos.py')).catch(() => null)).toBeNull();
	});
});
