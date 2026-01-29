import * as commander from 'commander';
import type { AppRouter } from '@/server/routers/index.js';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import { getBaseUrl } from '@/utils/trpc.js';
import { stat, readFile } from 'node:fs/promises';
import path from 'path';
import React from 'react';
import { Box, Text, Newline, render } from 'ink';
import { Container } from '@/cli/components/container.jsx';
import { Status } from '@/cli/components/status.jsx';
import { readPackageUp } from 'read-package-up';
import { $, echo, which } from 'zx';
import { existsSync } from 'node:fs';
import { ensureSudo, getRealPath, renderApiResults, renderError, errorColor, loadEnvironment } from '@/cli/util';
import { InstallProgressUI, InstallStep } from '@/cli/components/install-progress';
import { promptContinue } from '@/cli/components/continue';
import { createSignal } from '@/app/_helpers/signal';
import { getLogger } from '@/cli/logger';
import { frontend } from '@/cli/commands/frontend';
import { postprocessor } from '@/cli/commands/postprocessor';
import {
	upgradeBackupPaths,
	createBackup,
	upgradeDeletePaths,
	deleteUpgradeDeletePaths,
	createUpgradeSnippetFiles,
} from '@/cli/utils/filesystem';
import { switchBranchFromRemote } from '@/cli/utils/git';
type InstallProgressUIProps = React.ComponentProps<typeof InstallProgressUI>;

/**
 * Helper function to create a rerender function for InstallProgressUI
 * Allows updating props without rewriting the JSX component
 */
const createInstallProgressRerender = (initialProps: InstallProgressUIProps) => {
	const { rerender } = render(<InstallProgressUI {...initialProps} />);
	return (props: Partial<InstallProgressUIProps>) => {
		rerender(<InstallProgressUI {...initialProps} {...props} />);
	};
};

export const program = new commander.Command()
	.name('ratos')
	.version((await readPackageUp())?.packageJson.version ?? 'unknown')
	.description('RatOS CLI for interacting with the RatOS Configurator')
	.option('-cwd, --cwd <path>', 'Set the current working directory')
	.configureOutput({
		outputError: (str, write) => {
			getLogger().error(str);
			write(errorColor(str));
		},
	})
	.showSuggestionAfterError(true);

program
	.command('info')
	.description('Print info about this RatOS installation')
	.action(async () => {
		const client = createTRPCProxyClient<AppRouter>({
			links: [
				httpBatchLink({
					url: `${getBaseUrl()}/api/trpc`,
				}),
			],
		});
		const info = {
			osVersion: await client.osVersion.query(),
			version: await client.version.query(),
			klipperVersion: await client.klipperVersion.query(),
			ip: await client.ipAddress.query(),
		};
		render(
			<Box flexDirection="row" columnGap={5} padding={2} paddingTop={1}>
				<Box flexDirection="column" rowGap={1}>
					<Text color="white" dimColor={true}>
						Machine IP
					</Text>
					<Text color="white" dimColor={true}>
						RatOS Version
					</Text>
					<Text color="white" dimColor={true}>
						Configurator Version
					</Text>
					<Text color="white" dimColor={true}>
						Klipper Version
					</Text>
				</Box>
				<Box flexDirection="column" rowGap={1}>
					<Text>{info.ip}</Text>
					<Text>{info.osVersion}</Text>
					<Text>{info.version}</Text>
					<Text>{info.klipperVersion}</Text>
				</Box>
			</Box>,
		);
	});

const extensions = program
	.command('extensions')
	.description('Register, unregister or symlink extensions managed by the RatOS Configurator');

const registerExtensions = extensions
	.command('register')
	.description('Register an extension to be managed by the RatOS Configurator');

const unregisterExtensions = extensions
	.command('unregister')
	.description('Unregister an extension from the RatOS Configurator');

extensions
	.command('list')
	.option('-k, --klipper', 'Only show Klipper extensions')
	.option('-m, --moonraker', 'Only show Moonraker extensions')
	.option('--non-interactive', 'Output in non-interactive format')
	.description('List all registered extensions')
	.action(async (options) => {
		const client = createTRPCProxyClient<AppRouter>({
			links: [
				httpBatchLink({
					url: `${getBaseUrl()}/api/trpc`,
				}),
			],
		});
		if (options.klipper && options.moonraker) {
			if (options.nonInteractive) {
				echo('Cannot specify both --klipper and --moonraker');
				process.exit(2);
			}
			return renderError('Cannot specify both --klipper and --moonraker', { exitCode: 2 });
		}
		const klippyExtensions = await client['klippy-extensions'].list.query();
		const moonrakerExtensions = await client['moonraker-extensions'].list.query();
		if (options.nonInteractive) {
			if (klippyExtensions.length > 0 && !options.moonraker) {
				echo(`${klippyExtensions.length} Registered Klipper Extensions:`);
				for (const ext of klippyExtensions) {
					echo(`${ext.extensionName} -> ${ext.path + ext.fileName}`);
				}
			}
			if (moonrakerExtensions.length > 0 && !options.klipper) {
				echo(`${moonrakerExtensions.length} Registered Moonraker Extensions:`);
				for (const ext of moonrakerExtensions) {
					echo(`${ext.extensionName} -> ${ext.path + ext.fileName}`);
				}
			}
			return;
		}
		render(
			<Container>
				{klippyExtensions.length > 0 && !options.moonraker && (
					<Box flexDirection="column" marginBottom={1}>
						<Text>
							{klippyExtensions.length} Registered Klipper {klippyExtensions.length === 1 ? 'Extension' : 'Extensions'}
							{klippyExtensions.length ? ':' : ''}
						</Text>
						{klippyExtensions.map((ext) => (
							<Box key={ext.extensionName} flexDirection="row" columnGap={2}>
								<Text color={existsSync(ext.path + ext.fileName) ? 'green' : 'red'}>
									{ext.extensionName} {'->'} {ext.path + ext.fileName}{' '}
								</Text>
							</Box>
						))}
					</Box>
				)}
				{moonrakerExtensions.length > 0 && !options.klipper && (
					<Box flexDirection="column">
						<Text>
							{moonrakerExtensions.length} Registered Moonraker{' '}
							{moonrakerExtensions.length === 1 ? 'Extension' : 'Extensions'}
							{moonrakerExtensions.length ? ':' : ''}
						</Text>
						{moonrakerExtensions.map((ext) => (
							<Box key={ext.extensionName} flexDirection="row" columnGap={2}>
								<Text color={existsSync(ext.path + ext.fileName) ? 'green' : 'red'}>
									{ext.extensionName} {'->'} {ext.path + ext.fileName}{' '}
								</Text>
							</Box>
						))}
					</Box>
				)}
			</Container>,
		);
	});

registerExtensions
	.command('klipper')
	.description('Register a Klipper extension to be managed by the RatOS Configurator')
	.option('-k, --kinematics', 'Register as a kinematics extension')
	.option('-e, --error-if-exists', 'Throw error if the extension already exists')
	.argument('<name>', 'Name of the extension')
	.argument('<file>', 'The path to the extension itself')
	.showHelpAfterError()
	.action(async (extName, extFile, options) => {
		const client = createTRPCProxyClient<AppRouter>({
			links: [
				httpBatchLink({
					url: `${getBaseUrl()}/api/trpc`,
				}),
			],
		});
		let realPath = '';
		try {
			realPath = await getRealPath(program, extFile);
			if (!(await stat(realPath)).isFile() || !realPath.endsWith('.py')) {
				return renderError(`${realPath} is not a python file`, { exitCode: 2 });
			}
		} catch (e) {
			return renderError(`Failed to get file name from ${extFile}`, { exitCode: 2 });
		}
		const fileName = realPath.split(path.sep).pop();
		if (fileName == null) {
			return renderError(`Failed to get file name from ${realPath}`, { exitCode: 2 });
		}
		try {
			await client['klippy-extensions'].register.mutate({
				json: {
					extensionName: extName,
					path: realPath.lastIndexOf(fileName) === -1 ? realPath : realPath.slice(0, realPath.lastIndexOf(fileName)),
					fileName: fileName,
					isKinematics: options.kinematics,
					errorIfExists: options.errorIfExists,
				},
			});
		} catch (e) {
			if (e instanceof Error) {
				return renderError(e.message, { exitCode: 2 });
			}
			return renderError('Failed to register extension', { exitCode: 2 });
		}

		render(
			<Container>
				<Status
					results={{
						message: `Successfully registered ${options.kinematics ? 'kinematics ' : ''}extension "${extName}"`,
						result: 'success',
					}}
				/>
			</Container>,
		);
	});

registerExtensions
	.command('moonraker')
	.description('Register a Moonraker extension to be managed by the RatOS Configurator')
	.argument('<name>', 'Name of the extension')
	.argument('<file>', 'The extension itself')
	.showHelpAfterError()
	.option('-e, --error-if-exists', 'Throw error if the extension already exists')
	.action(async (extName, extFile, options) => {
		const client = createTRPCProxyClient<AppRouter>({
			links: [
				httpBatchLink({
					url: `${getBaseUrl()}/api/trpc`,
				}),
			],
		});
		let realPath = '';
		try {
			realPath = await getRealPath(program, extFile);
			if (!(await stat(realPath)).isFile() || !realPath.endsWith('.py')) {
				return renderError(`${realPath} is not a python file`, { exitCode: 2 });
			}
		} catch (e) {
			return renderError(`Failed to get file name from ${extFile}`, { exitCode: 2 });
		}
		const fileName = realPath.split(path.sep).pop();
		if (fileName == null) {
			return renderError(`Failed to get file name from ${realPath}`, { exitCode: 2 });
		}
		try {
			await client['moonraker-extensions'].register.mutate({
				json: {
					extensionName: extName,
					path: realPath.lastIndexOf(fileName) === -1 ? realPath : realPath.slice(0, realPath.lastIndexOf(fileName)),
					fileName: fileName,
					errorIfExists: options.errorIfExists,
				},
			});
			render(
				<Container>
					<Status
						results={{
							message: `Successfully registered extension "${extName}"`,
							result: 'success',
						}}
					/>
				</Container>,
			);
		} catch (e) {
			if (e instanceof Error) {
				return renderError(e.message, { exitCode: 2 });
			}
			return renderError('Failed to register extension', { exitCode: 2 });
		}
	});

unregisterExtensions
	.command('klipper')
	.description('Unlink and unregister a Klipper extension managed by the RatOS Configurator')
	.argument('<name>', 'Name of the extension')
	.showHelpAfterError()
	.option('-e, --error-if-not-exists', "Throw error if the extension doesn't exist")
	.action(async (extName, options) => {
		const client = createTRPCProxyClient<AppRouter>({
			links: [
				httpBatchLink({
					url: `${getBaseUrl()}/api/trpc`,
				}),
			],
		});
		try {
			const result = await client['klippy-extensions'].unregister.mutate({
				extensionName: extName,
				errorIfNotExists: options.errorIfExists,
			});
			renderApiResults(result);
		} catch (e) {
			if (e instanceof Error) {
				return renderError(e.message, { exitCode: 2 });
			}
			return renderError('Failed to unregister extension', { exitCode: 2 });
		}
	});

unregisterExtensions
	.command('moonraker')
	.description('Unlink and unregister a Moonraker extension managed by the RatOS Configurator')
	.argument('<name>', 'Name of the extension')
	.showHelpAfterError()
	.option('-e, --error-if-not-exists', "Throw error if the extension doesn't exist")
	.action(async (extName, options) => {
		const client = createTRPCProxyClient<AppRouter>({
			links: [
				httpBatchLink({
					url: `${getBaseUrl()}/api/trpc`,
				}),
			],
		});
		try {
			const result = await client['moonraker-extensions'].unregister.mutate({
				extensionName: extName,
				errorIfNotExists: options.errorIfNotExists,
			});
			renderApiResults(result);
		} catch (e) {
			if (e instanceof Error) {
				return renderError(e.message, { exitCode: 2 });
			}
			return renderError('Failed to unregister extension', { exitCode: 2 });
		}
	});

extensions
	.command('symlink')
	.addArgument(
		new commander.Argument('[type]', 'Type of the extension').default('all').choices(['all', 'klipper', 'moonraker']),
	)
	.option('-e, --error-if-exists', 'Throw error and abort if an extension already exist')
	.description('Symlink all registered extensions')
	.action(async (type, options) => {
		const client = createTRPCProxyClient<AppRouter>({
			links: [
				httpBatchLink({
					url: `${getBaseUrl()}/api/trpc`,
				}),
			],
		});
		try {
			const results = [];
			if (type === 'klipper' || type === 'all') {
				const klipperExtensions = await client['klippy-extensions'].symlink.mutate({
					errorIfExists: options.errorIfExists,
				});
				results.push(...klipperExtensions.symlinkResults);
			}
			if (type === 'moonraker' || type === 'all') {
				const moonrakerExtensions = await client['moonraker-extensions'].symlink.mutate({
					errorIfExists: options.errorIfExists,
				});
				results.push(...moonrakerExtensions.symlinkResults);
			}
			renderApiResults(results);
		} catch (e) {
			if (e instanceof Error) {
				return renderError(e.message, { exitCode: 2 });
			}
			return renderError('Failed to symlink extensions', { exitCode: 2 });
		}
	});

program
	.command('config')
	.description('Commands for managing the RatOS configuration')
	.command('regenerate')
	.option('-o, --overwrite-all', "Overwrite all existing files, even if they haven't been modified")
	.option('-p, --overwrite-printer-cfg', "Overwrite the printer.cfg file, even if it hasn't been modified")
	.action(async (options) => {
		try {
			const client = createTRPCProxyClient<AppRouter>({
				links: [
					httpBatchLink({
						url: `${getBaseUrl()}/api/trpc`,
					}),
				],
			});
			const overwriteFiles = [];
			if (options.overwriteAll) {
				overwriteFiles.push('*');
			}
			if (options.overwritePrinterCfg) {
				overwriteFiles.push('printer.cfg');
			}
			const result = await client['printer'].regenerateConfiguration.mutate({ overwriteFiles: overwriteFiles });
			renderApiResults(
				result.map((file) => {
					let action =
						file.action === 'created'
							? 'Created'
							: file.action === 'skipped'
								? 'Skipped'
								: file.action === 'overwritten'
									? 'Updated'
									: 'Failed to write';
					return {
						result:
							file.action === 'skipped'
								? 'skip'
								: file.action === 'created'
									? 'success'
									: file.action === 'overwritten'
										? 'warning'
										: 'error',
						message:
							file.action === 'error'
								? `Error during processing of ${file.fileName}${
										file.err instanceof Error ? `: ${file.err.message}` : ''
									}`
								: `${action} config file ${file.fileName}`,
					};
				}),
			);
		} catch (e) {
			if (e instanceof Error) {
				return renderError(e.message, { exitCode: 2 });
			}
			return renderError('Failed to regenerate config', { exitCode: 2 });
		}
	});

program
	.command('flash')
	.description(`Flash all connected boards`)
	.action(async () => {
		try {
			const client = createTRPCProxyClient<AppRouter>({
				links: [
					httpBatchLink({
						url: `${getBaseUrl()}/api/trpc`,
					}),
				],
			});
			const res = await client['mcu'].flashAllConnected.mutate();
			renderApiResults(res.flashResults);
		} catch (e) {
			if (e instanceof Error) {
				return renderError(e.message, { exitCode: 2 });
			}
			return renderError("Failed to flash mcu's", { exitCode: 2 });
		}
	});

frontend(program);
postprocessor(program);

const log = program.command('logs').description('Commands for managing the RatOS log');

log
	.command('tail')
	.option('-f, --follow', 'Follow the log')
	.option('-n, --lines <lines>', 'Number of lines to show')
	.description('Tail the RatOS log')
	.action(async (options) => {
		const $$ = $({ verbose: true });
		const flags = [];
		if (options.follow) {
			flags.push('-f');
		}
		if (options.lines) {
			flags.push(`-n${options.lines}`);
		}
		const logFile = loadEnvironment().LOG_FILE;
		const whichPretty = await which('pino-pretty');
		if (whichPretty.trim() === '') {
			echo('pino-pretty not found, installing (requires sudo permissions)...');
			await $$`sudo npm install -g pino-pretty`;
		}
		$$`tail ${flags} ${logFile} | pino-pretty --colorize`;
	});

log
	.command('rotate')
	.description('force rotate the RatOS configurator log')
	.action(async () => {
		const log = '/etc/logrotate.d/ratos-configurator';
		$({ verbose: true })`logrotate -f ${log}`;
	});

const doctor = program
	.command('doctor')
	.description('Diagnose and fix common issues on a RatOS installation')
	.action(async () => {
		await ensureSudo();

		const cmdSignal = createSignal<string | null>();
		const $$ = $({
			quiet: true,
			log(entry) {
				if (entry.kind === 'cmd') {
					cmdSignal(entry.cmd);
					getLogger().info('Running command: ' + entry.cmd);
				}
			},
		});

		const steps: InstallStep[] = [];
		let { rerender } = render(
			<InstallProgressUI
				status="Fixing potential RatOS issues..."
				stepText="Repairing RatOS configurator..."
				isLoading={true}
				cmdSignal={cmdSignal}
				steps={steps}
			/>,
		);

		await $$`sudo ${loadEnvironment().RATOS_SCRIPT_DIR}/update.sh`;
		steps.push({ name: 'Repaired RatOS configurator', status: 'success' });
		rerender(
			<InstallProgressUI
				status="Fixing potential RatOS issues..."
				stepText="Restarting RatOS configurator..."
				cmdSignal={cmdSignal}
				isLoading={true}
				steps={steps}
			/>,
		);
		await $$`sudo systemctl restart ratos-configurator`;
		await $$`sleep 1 && curl -s -o /dev/null --retry 20 --retry-all-errors --retry-delay 1 --retry-max-time 60 "http://localhost:3000/configure" &> /dev/null`;
		steps.push({ name: 'Restarted RatOS configurator', status: 'success' });
		rerender(
			<InstallProgressUI
				status="Fixing potential RatOS issues..."
				stepText="Repairing RatOS configuration..."
				isLoading={true}
				cmdSignal={cmdSignal}
				steps={steps}
			/>,
		);
		await $$`sudo ${loadEnvironment().RATOS_CONFIGURATION_PATH}/scripts/ratos-update.sh`;
		steps.push({ name: 'Repaired RatOS configuration', status: 'success' });
		rerender(
			<InstallProgressUI
				status="Fixing potential RatOS issues..."
				stepText="Restarting Klipper..."
				isLoading={true}
				cmdSignal={cmdSignal}
				steps={steps}
			/>,
		);
		await $$`sudo systemctl restart klipper`;
		steps.push({ name: 'Restarted Klipper', status: 'success' });
		rerender(
			<InstallProgressUI
				status="Fixing potential RatOS issues..."
				stepText="Restarting Moonraker..."
				isLoading={true}
				cmdSignal={cmdSignal}
				steps={steps}
			/>,
		);
		await $$`sudo systemctl restart moonraker`;
		steps.push({ name: 'Restarted Moonraker', status: 'success' });
		rerender(
			<InstallProgressUI
				status="Fixing potential RatOS issues..."
				stepText="Done!"
				statusColor="greenBright"
				cmdSignal={cmdSignal}
				steps={steps}
			/>,
		);
	});

/**
 * Upgrade the RatOS Configurator to a specified version or the latest version
 * steps:
 * - Backup current configurator files
 * - Stop moonraker service
 * - Reset core files for fresh upgrade
 * - Switch to specified branch
 * - restore snippet files
 * - ensure update ran
 * - Restart services
 */
const upgrade = program
	.command('upgrade')
	.description('Upgrade the RatOS Configurator to specified version, defaults to latest if not specified')
	.option('-r, --remote <remote>', 'GitHub remote to use for the upgrade', 'origin')
	.option('-d, --dry-run', 'Perform a dry run of the upgrade procedure without making any changes')
	.option('-b, --branch <branch>', 'Git branch to use for the upgrade', 'v2.1.x-deployment-2')
	.option('-y, --yes', 'Automatically confirm the upgrade without prompting')
	.action(async ({ remote, dryRun, branch, yes }) => {
		try {
			await ensureSudo();

			const { RATOS_CONFIGURATION_PATH, NODE_ENV, RATOS_SCRIPT_DIR, RATOS_DATA_DIR } = loadEnvironment();

			// Prompt user for confirmation before proceeding
			if (!yes || NODE_ENV === 'development') {
				const shouldContinue = await promptContinue(
					<>
						<Text>This operation is not reversible.</Text>
						<Newline />
						<Text>A backup will be completed during the upgrade.</Text>
						<Newline />
						<Text>Do you wish to continue?</Text>
					</>,
				);
				if (!shouldContinue) {
					return renderError('Upgrade aborted by user', { exitCode: 3 });
				}
			}

			const configuratorPath = path.dirname(RATOS_CONFIGURATION_PATH);
			// validate that configuratorPath exists and is a git repository
			if (!existsSync(configuratorPath)) {
				if (!existsSync(path.join(configuratorPath, '.git'))) {
					return renderError(`Unable to upgrade: RatOS Configurator git repository not found at ${configuratorPath}`, {
						exitCode: 2,
					});
				} else {
					return renderError(`Unable to upgrade: RatOS Configurator path ${configuratorPath} is not a git repository`, {
						exitCode: 2,
					});
				}
			}

			const cmdSignal = createSignal<string | null>();
			const $$ = $({
				verbose: true,
				log(entry) {
					if (entry.kind === 'cmd') {
						cmdSignal(entry.cmd);
						getLogger().info('Running command: ' + entry.cmd);
					}
				},
			});

			const status = 'Upgrading RatOS Configurator...';
			let steps: InstallStep[] = [];
			const rerender = createInstallProgressRerender({
				status,
				stepText: 'Backing up current configurator...',
				isLoading: true,
				cmdSignal,
				steps,
			});
			steps.push({ name: 'Stopped moonraker', status: 'success' });
			if (NODE_ENV !== 'development' && !dryRun) {
				await $$`sudo systemctl stop moonraker`;
			} else {
				getLogger().info('Skipping moonraker stop in --dry-run mode');
			}
			rerender({
				stepText: steps[steps.length - 1].name,
				isLoading: false,
				steps,
			});
			steps.push({ name: 'Stopped ratos-configurator', status: 'success' });
			if (NODE_ENV !== 'development' && !dryRun) {
				await $$`sudo systemctl stop ratos-configurator`;
			} else {
				getLogger().info('Skipping ratos-configurator shutdown due to --dry-run mode');
			}
			rerender({
				stepText: steps[steps.length - 1].name,
				steps,
			});

			// Backup current configurator files
			const backupContextPath = path.dirname(RATOS_DATA_DIR);
			steps.push({ name: `Backing up ratos files found in ${backupContextPath}`, status: 'running' });
			rerender({
				isLoading: true,
				stepText: steps[steps.length - 1].name,
				steps,
			});
			await createBackup(backupContextPath, upgradeBackupPaths, `${backupContextPath}/backups`, $$, dryRun);
			steps[steps.length - 1].status = 'success';
			rerender({
				isLoading: false,
				stepText: steps[steps.length - 1].name,
				steps,
			});
			steps.push({ name: 'Removing files marked for deletion during upgrade', status: 'running' });
			rerender({
				isLoading: true,
				stepText: steps[steps.length - 1].name,
				steps,
			});
			await deleteUpgradeDeletePaths(backupContextPath, upgradeDeletePaths, $$, dryRun);
			steps[steps.length - 1].status = 'success';
			rerender({
				isLoading: false,
				stepText: steps[steps.length - 1].name,
				steps,
			});

			steps.push({ name: 'Resetting core files for fresh upgrade...', status: 'running' });
			rerender({
				isLoading: true,
				stepText: steps[steps.length - 1].name,
				steps,
			});
			await createUpgradeSnippetFiles(`${configuratorPath}/app/cli/templates`, backupContextPath, $$, dryRun);
			steps[steps.length - 1].status = 'success';
			rerender({
				isLoading: false,
				stepText: steps[steps.length - 1].name,
				steps,
			});

			const isOrigin = remote === 'origin';
			const branchName = isOrigin ? branch : `${remote}/${branch}`;
			steps.push({ name: `Switching to branch ${branchName}`, status: 'running' });
			rerender({
				isLoading: true,
				stepText: steps[steps.length - 1].name,
				steps,
			});
			await switchBranchFromRemote(configuratorPath, branch, remote, $$, dryRun);
			steps[steps.length - 1].status = 'success';
			rerender({
				isLoading: false,
				stepText: steps[steps.length - 1].name,
				steps,
			});
			steps.push({ name: 'Running upgrade script...', status: 'running' });
			rerender({
				isLoading: true,
				stepText: steps[steps.length - 1].name,
				steps,
			});
			if (!dryRun) {
				await $$`${RATOS_SCRIPT_DIR}/post-merge.sh`;
			} else {
				getLogger().info('Skipping upgrade script due to --dry-run mode');
			}
			steps[steps.length - 1].status = 'success';
			rerender({
				stepText: steps[steps.length - 1].name,
				isLoading: false,
				steps,
			});
			rerender({
				stepText: 'Done!',
				isLoading: false,
				stepTextColor: 'greenBright',
				steps,
			});
		} catch (e) {
			if (e instanceof Error) {
				return renderError(e.message, { exitCode: 2 });
			}
			return renderError('Failed to upgrade RatOS Configurator', { exitCode: 2 });
		}
	});
