import { existsSync } from 'fs';
import { symlink, appendFile, unlink, lstat, readlink } from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { replaceInFileByLine, searchFileByLine } from '@/server/helpers/file-operations';
import { TRPCError } from '@trpc/server';

const extension = z.object({
	fileName: z.string(),
	path: z.string(),
	extensionName: z.string(),
});

const options = z.object({
	errorIfExists: z.boolean().optional(),
	errorIfNotExists: z.boolean().optional(),
});

export type Extension = z.infer<typeof extension>;
export type Options = z.infer<typeof options>;

const lstatOrNull = (filePath: string) => lstat(filePath).catch(() => null);

/**
 * Whether `destination` is a symlink to `source`, which is how RatOS links extensions.
 * Dangling symlinks count, so that links to removed extension files can be cleaned up.
 */
const isSymlinkTo = async (destination: string, source: string) => {
	const destinationStat = await lstatOrNull(destination);
	if (destinationStat == null || !destinationStat.isSymbolicLink()) {
		return false;
	}
	const target = await readlink(destination).catch(() => null);
	return target != null && path.resolve(path.dirname(destination), target) === source;
};

interface SymlinkExtensionsProps<T extends Extension> {
	extensions: T[];
	options?: Pick<Options, 'errorIfExists'>;
	gitRepoPath: string;
	relativePath: string | ((extension: T) => string);
	saveExtensions: (extensions: T[]) => void;
}

export const symlinkExtensions = async <T extends Extension>(props: SymlinkExtensionsProps<T>) => {
	const currentExtensions = props.extensions.slice();
	let cleanedUpExtensions: T[] = [];
	if (currentExtensions.length === 0) {
		return { report: 'No extensions registered, nothing to do.', cleanedUpExtensions, symlinkResults: [] };
	}
	const gitExcludePath = path.resolve(path.join(props.gitRepoPath, '.git', 'info', 'exclude'));
	const symlinkResults = await Promise.all(
		currentExtensions.map(async (ext): Promise<{ result: 'success' | 'error'; message: string }> => {
			const relativeDestination = path.join(
				typeof props.relativePath === 'function' ? props.relativePath(ext) : props.relativePath,
				ext.fileName,
			);
			const destination = path.resolve(path.join(props.gitRepoPath, relativeDestination));
			const destinationStat = await lstatOrNull(destination);
			const symlinkExists = existsSync(destination);
			if (existsSync(path.resolve(path.join(ext.path, ext.fileName)))) {
				cleanedUpExtensions.push(ext);
				if (destinationStat != null && !destinationStat.isSymbolicLink()) {
					// A regular file means the Klipper repository ships its own module with this name
					// (for example Kalico's gcode_shell_command.py). Never replace or exclude it.
					return {
						result: 'error',
						message: `"${relativeDestination}" is provided by Klipper itself, so "${ext.fileName}" from "${ext.path}" was not linked.`,
					};
				}
				const excludeLine = new RegExp(`^${relativeDestination}$`);
				const isExcluded = await searchFileByLine(gitExcludePath, excludeLine);
				try {
					if (symlinkExists === false) {
						await symlink(path.resolve(path.join(ext.path, ext.fileName)), destination);
					} else if (props.options?.errorIfExists) {
						throw new TRPCError({
							code: 'PRECONDITION_FAILED',
							message: `Symlink for "${ext.fileName}" already exists.`,
						});
					}
					if (isExcluded === false) {
						await appendFile(gitExcludePath, `${relativeDestination}\n`);
					}
					return {
						result: 'success',
						message: symlinkExists
							? `Symlink for "${ext.fileName}" already exists. Skipping.`
							: `Symlink for "${ext.fileName}" created`,
					};
				} catch (e) {
					return {
						result: 'error',
						message: `Failed to create symlink for "${ext.fileName}"${e instanceof Error ? `:\n\t${e.message}` : ''}`,
					};
				}
			} else {
				if (destinationStat?.isSymbolicLink()) {
					const result = await unlinkExtension({
						extension: ext,
						gitRepoPath: props.gitRepoPath,
						relativePath: props.relativePath,
					});
					if (result.result === 'error') {
						// Don't remove extension from the list of registered extensions, we may still have a lingering symlink
						cleanedUpExtensions.push(ext);
						return {
							result: 'error',
							message: `Failed to remove symlink for non-existent extension file "${ext.fileName}" in "${ext.path}"`,
						};
					}
				}
				return {
					result: 'error',
					message: `Extension file "${ext.fileName}" does not exist in "${ext.path}". It has been unlinked and removed from the list of registered extensions`,
				};
			}
		}),
	);
	if (cleanedUpExtensions.length !== currentExtensions.length) {
		props.saveExtensions(cleanedUpExtensions);
	}
	const successCount = symlinkResults.filter((r) => r.result === 'success').length;
	let report = `Symlinked ${successCount}/${symlinkResults.length} extension(s): \n`;
	symlinkResults.forEach((r) => {
		report += `${r.message} \n`;
	});
	return { report, cleanedUpExtensions, symlinkResults };
};

interface UnlinkExtensionProps<T extends Pick<Extension, 'extensionName'>> {
	extension: T;
	options?: Pick<Options, 'errorIfNotExists'>;
	gitRepoPath: string;
	relativePath: string | ((extension: T) => string);
}

export const unlinkExtension = async <T extends Extension>(
	props: UnlinkExtensionProps<T>,
): Promise<{ result: 'success' | 'error'; message: string }> => {
	const ext = props.extension;
	const relativeDestination = path.join(
		typeof props.relativePath === 'function' ? props.relativePath(ext) : props.relativePath,
		ext.fileName,
	);
	const gitExcludePath = path.resolve(props.gitRepoPath, '.git', 'info', 'exclude');
	const destination = path.resolve(path.join(props.gitRepoPath, relativeDestination));
	const source = path.resolve(path.join(ext.path, ext.fileName));
	// Only ever remove RatOS's own symlink, never a file or link that belongs to the Klipper repository.
	const isOwnSymlink = await isSymlinkTo(destination, source);
	if (isOwnSymlink || existsSync(source)) {
		const excludeLine = new RegExp(`^${relativeDestination}$`);
		// Remove extension from git exclude file
		await replaceInFileByLine(gitExcludePath, excludeLine, null);
		const destinationExists = (await lstatOrNull(destination)) != null;
		try {
			if (isOwnSymlink) {
				await unlink(destination);
			} else if (destinationExists) {
				return {
					result: 'success',
					message: `"${relativeDestination}" is not a RatOS symlink for "${ext.fileName}". Leaving it in place.`,
				};
			} else if (props.options?.errorIfNotExists) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Symlink for "${ext.fileName}" doesn't exist.`,
				});
			}
			return {
				result: 'success',
				message: isOwnSymlink
					? `Symlink for "${ext.fileName}" has been removed.`
					: `Symlink for "${ext.fileName}" doesn't exist. Skipping.`,
			};
		} catch (e) {
			return {
				result: 'error',
				message: `Failed to remove symlink for "${ext.fileName}"`,
			};
		}
	} else {
		return {
			result: 'success',
			message: `Extension file "${ext.fileName}" does not exist in ${ext.path}. Nothing to do.`,
		};
	}
};
