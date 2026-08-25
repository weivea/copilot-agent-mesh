import { timingSafeEqual } from 'node:crypto';

export type E2eRole = 'worker' | 'coordinator';
export type ExtensionRuntimeMode = 'production' | 'development' | 'test';

export interface E2eCapabilityInput {
	readonly mode: ExtensionRuntimeMode;
	readonly environmentEnabled: boolean;
	readonly environmentNonce?: string;
	readonly environmentRole?: string;
	readonly profileNonce?: string;
	readonly profileRole?: string;
}

const enabledCapabilities = new WeakSet<E2eCapability>();
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class E2eCapability {
	private constructor(
		readonly role: E2eRole | undefined,
		private readonly nonce: string | undefined,
	) {
		Object.freeze(this);
	}

	static create(input: E2eCapabilityInput): E2eCapability {
		const role = parseRole(input.environmentRole);
		const profileRole = parseRole(input.profileRole);
		const nonce = input.environmentNonce;
		const enabled = input.mode !== 'production'
			&& input.environmentEnabled
			&& role !== undefined
			&& role === profileRole
			&& nonce !== undefined
			&& noncePattern.test(nonce)
			&& secureEqual(nonce, input.profileNonce);
		const capability = new E2eCapability(enabled ? role : undefined, enabled ? nonce : undefined);
		if (enabled) {
			enabledCapabilities.add(capability);
		}
		return capability;
	}

	assertRequest(nonce: string, role: string): void {
		if (
			!enabledCapabilities.has(this)
			|| this.role === undefined
			|| role !== this.role
			|| !secureEqual(this.nonce, nonce)
		) {
			throw new Error('The two-device E2E capability request was rejected.');
		}
	}
}

export const disabledE2eCapability = E2eCapability.create({
	mode: 'production',
	environmentEnabled: false,
});

export function isE2eCapabilityEnabled(capability: E2eCapability): boolean {
	return enabledCapabilities.has(capability);
}

function parseRole(value: string | undefined): E2eRole | undefined {
	return value === 'worker' || value === 'coordinator' ? value : undefined;
}

function secureEqual(left: string | undefined, right: string | undefined): boolean {
	if (left === undefined || right === undefined) {
		return false;
	}
	const leftBytes = Buffer.from(left, 'utf8');
	const rightBytes = Buffer.from(right, 'utf8');
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
