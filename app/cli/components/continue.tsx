import React, { useState } from 'react';
import { Box, Text, useInput, Newline, render } from 'ink';
import { InputPlaceholder } from '@/cli/components/input-placeholder';

interface ContinuePromptProps {
	message: React.ReactNode;
	onResponse: (shouldContinue: boolean) => void;
}

export const ContinuePrompt: React.FC<ContinuePromptProps> = ({ message, onResponse }) => {
	const [responded, setResponded] = useState(false);
	const [inputValue, setInputValue] = useState('');

	useInput((input, key) => {
		if (responded) return;

		if (key.escape) {
			setResponded(true);
			onResponse(false);
			return;
		}

		if (key.return) {
			const trimmedInput = inputValue.toLowerCase().trim();
			if (trimmedInput === 'yes') {
				setResponded(true);
				onResponse(true);
			} else {
				// Default to 'no' if empty or 'no' is typed
				setResponded(true);
				onResponse(false);
			}
			return;
		}

		if (key.backspace || key.delete) {
			setInputValue((prev) => prev.slice(0, -1));
		} else if (input && !key.ctrl && !key.meta) {
			setInputValue((prev) => prev + input);
		}
	});

	return (
		<Box flexDirection="column" marginLeft={2} paddingTop={1} width={60}>
			<Text color="yellow" bold>
				⚠ Warning
			</Text>
			<Newline />
			<Text>
				{message} <Text color="cyan">(yes/NO)</Text>
			</Text>
			<Box>
				<Text>
					Type{' '}
					<Text color="cyan" bold>
						yes
					</Text>{' '}
					to continue
					<Text color="cyan" bold>
						{' '}
						&gt;{' '}
					</Text>
				</Text>
				<Text>{inputValue}</Text>
				<InputPlaceholder show={inputValue.length === 0} />
			</Box>
			{responded && <Text dimColor>Processing...</Text>}
		</Box>
	);
};

/**
 * Prompts the user to continue with a yes/no question
 * @param message The message to display to the user (can be a string or React component)
 * @returns Promise that resolves to true if user confirms, false otherwise
 *
 * @example
 * // Simple string
 * await promptContinue('Do you want to continue?');
 *
 * @example
 * // Multi-line string
 * await promptContinue(
 *   `This operation is not reversible.
 *   A backup will be completed during the upgrade.
 *   Do you wish to continue?`
 * );
 *
 * @example
 * // JSX component for complex formatting
 * await promptContinue(
 *   <>
 *     <Text>This operation is <Text color="red" bold>not reversible</Text>.</Text>
 *     <Text>A backup will be completed during the upgrade.</Text>
 *     <Text>Do you wish to continue?</Text>
 *   </>
 * );
 */
export const promptContinue = async (message: React.ReactNode): Promise<boolean> => {
	return new Promise((resolve) => {
		const { unmount } = render(
			<ContinuePrompt
				message={message}
				onResponse={(shouldContinue) => {
					unmount();
					resolve(shouldContinue);
				}}
			/>,
		);
	});
};
