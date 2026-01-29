import React, { useState, useEffect } from 'react';
import { Text } from 'ink';

interface InputPlaceholderProps {
	show: boolean;
}

export const InputPlaceholder: React.FC<InputPlaceholderProps> = ({ show }) => {
	const [visible, setVisible] = useState(true);

	useEffect(() => {
		if (!show) return;

		const interval = setInterval(() => {
			setVisible((v) => !v);
		}, 500);

		return () => clearInterval(interval);
	}, [show]);

	if (!show) return null;

	return <Text color="gray">{visible ? '█' : ' '}</Text>;
};
