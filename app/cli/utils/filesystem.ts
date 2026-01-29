import { glob, Shell } from 'zx';

/**
 *
 * @returns list of relative file paths from printer_data directory
 */
export const upgradeBackupPaths = ['database', 'data', 'logs', 'config', 'gcodes', 'systemd'];

/**
 * @returns list of relative paths from printer_data that should be deleted during upgrade
 */
export const upgradeDeletePaths = [
	'config/ratos_generated',
	'config/ratos-variables.cfg',
	'config/RatOS.cfg',
	'config/printer-*.cfg',
	'config/RatOS-*.cfg',
	'database/*',
	'ratos',
	'systemd/*',
];

export async function createBackup(
	contextPath: string,
	files: string[],
	outputDir: string,
	shell: Shell,
	dryRun = false,
) {
	const $$ = shell;
	await $$`mkdir -p ${outputDir}`;
	const filesToProcess: string[] = [];
	for (const file of files) {
		const fullPath = `${contextPath}/${file}`;
		// Check if file or directory exists
		const pathExists = await $$`[ -e ${fullPath} ] && echo "true" || echo "false"`;
		if (pathExists.stdout.trim() === 'true') {
			filesToProcess.push(file);
		}
	}

	if (filesToProcess.length === 0) {
		throw new Error('No files found to backup');
	}

	// Use -C to change to contextPath and use relative paths to avoid absolute path warnings
	return await $$`tar -czhf ${outputDir}/backup.tar.gz -C ${contextPath} ${filesToProcess}`;
}

export async function deleteUpgradeDeletePaths(contextPath: string, files: string[], shell: Shell, dryRun = false) {
	const $$ = shell;
	if (dryRun) {
		return await $$`echo "Dry run enabled, skipping deletion of files" && sleep 2`;
	} else {
		const expandedPaths = (await Promise.all(files.map((file) => glob(`${contextPath}/${file}`)))).flat();
		return await $$`rm -rf ${expandedPaths}`;
	}
}

export const createUpgradeSnippetFiles = async (
	templateDir: string,
	outputDir: string,
	shell: Shell,
	dryRun = false,
) => {
	const $$ = shell;
	if (process.env.NODE_ENV != 'development') {
		await $$`[[ -d ${templateDir} ]] || echo "Template directory ${templateDir} does not exist"`;
	}
	if (dryRun) {
		return await $$`echo "Dry run enabled, skipping creation of upgrade snippet files" && sleep 2`;
	} else {
		return await $$`cp -r ${templateDir}/* ${outputDir}/`;
	}
};
