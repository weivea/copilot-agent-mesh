import { randomBytes } from 'node:crypto';

import { containsUnsafeDashboardText } from './DashboardRedaction';

export function createDashboardActionHandle(
	isUsed: (candidate: string) => boolean,
	createCandidate: () => string = () => randomBytes(24).toString('base64url'),
): string {
	let candidate: string;
	do {
		candidate = createCandidate();
		// Random aliases can coincidentally resemble a credential prefix.
	} while (!/^[A-Za-z0-9_-]{32}$/u.test(candidate) || isUsed(candidate) || containsUnsafeDashboardText(candidate));
	return candidate;
}
