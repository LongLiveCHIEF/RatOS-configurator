import { echo } from 'zx/build/goods';
import { Shell } from 'zx/core';

export async function switchBranchFromRemote(
	repoDir: string,
	branch: string,
	remote: string,
	shell: Shell,
	dryRun = false,
) {
	const $$ = shell;

	const isOrigin = remote === 'origin';
	// if remote is not origin, and is not already added, add it
	if (!isOrigin) {
		const remotesResult = await $$`git -C ${repoDir} remote`;
		const remotes = remotesResult.stdout
			.split('\n')
			.map((r) => r.trim())
			.filter((r) => r.length > 0);
		if (!remotes.includes(remote)) {
			// add remote
			await $$`git -C ${repoDir} remote add ${remote} https://github.com/${remote}/RatOS-configurator.git`;
		}
	}

	// fetch the branch from the remote
	await $$`git -C ${repoDir} fetch ${remote} ${branch}`;

	// checkout the branch
	if (dryRun) {
		return await $$`echo "Dry run enabled - skipping git switch to ${branch} in ${repoDir}" && sleep 2`;
	} else {
		if (!isOrigin) {
            const localBranch = (await $$`git -C ${repoDir} branch --list ${branch}`).stdout.trim();
            if (localBranch === '') {
                return await $$`git -C ${repoDir} switch -c ${branch} --track ${remote}/${branch}`;
            }
        }
		return await $$`git -C ${repoDir} switch ${branch}`;
	}
}
