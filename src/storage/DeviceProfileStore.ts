import { z } from 'zod';

import { MESH_PROTOCOL_VERSION, PROTOCOL_LIMITS, utf8String, uuidSchema } from '../../shared/protocol';
import type { Clock, IdGenerator, StateStore } from '../domain/ports';

const DEVICE_PROFILE_KEY = 'copilotAgentMesh.deviceProfile';

const deviceProfileFields = {
	deviceId: uuidSchema,
	name: utf8String(PROTOCOL_LIMITS.nameBytes, 'device name', 1),
	platform: z.enum(['win32', 'darwin', 'linux']),
	architecture: utf8String(32, 'architecture', 1),
	vscodeVersion: utf8String(64, 'VS Code version', 1),
	extensionVersion: utf8String(64, 'extension version', 1),
	createdAt: z.string().datetime({ offset: true }),
	updatedAt: z.string().datetime({ offset: true }),
};

const deviceProfileV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	...deviceProfileFields,
	protocolVersion: z.literal(1),
});

const deviceProfileSchema = z.strictObject({
	schemaVersion: z.literal(2),
	...deviceProfileFields,
	protocolVersion: z.literal(MESH_PROTOCOL_VERSION),
});

export type DeviceProfile = z.infer<typeof deviceProfileSchema>;

export interface DeviceEnvironment {
	readonly defaultName: string;
	readonly platform: DeviceProfile['platform'];
	readonly architecture: string;
	readonly vscodeVersion: string;
	readonly extensionVersion: string;
}

export class DeviceProfileStore {
	public constructor(
		private readonly state: StateStore,
		private readonly ids: IdGenerator,
		private readonly clock: Clock,
	) {}

	public get(): DeviceProfile | undefined {
		const stored = this.state.get<unknown>(DEVICE_PROFILE_KEY);
		if (stored === undefined) {
			return undefined;
		}
		const parsed = deviceProfileSchema.safeParse(stored);
		if (parsed.success) {
			return parsed.data;
		}
		if (deviceProfileV1Schema.safeParse(stored).success) {
			return undefined;
		}
		throw new TypeError(`Invalid persisted device profile: ${parsed.error.message}`);
	}

	public getReadOnly(_environment: DeviceEnvironment): DeviceProfile {
		const stored = this.get();
		if (stored !== undefined) {
			return stored;
		}
		throw new Error('The Broker owner has not created the shared device profile yet.');
	}

	public async getOrCreate(environment: DeviceEnvironment): Promise<DeviceProfile> {
		const stored = this.state.get<unknown>(DEVICE_PROFILE_KEY);
		if (stored !== undefined) {
			const current = deviceProfileSchema.safeParse(stored);
			let previous: DeviceProfile | z.infer<typeof deviceProfileV1Schema>;
			if (current.success) {
				previous = current.data;
			} else {
				const legacy = deviceProfileV1Schema.safeParse(stored);
				if (!legacy.success) {
					throw new TypeError(`Invalid persisted device profile: ${current.error.message}`);
				}
				previous = legacy.data;
			}
			const refreshed = deviceProfileSchema.parse({
				...previous,
				schemaVersion: 2,
				platform: environment.platform,
				architecture: environment.architecture,
				vscodeVersion: environment.vscodeVersion,
				extensionVersion: environment.extensionVersion,
				protocolVersion: MESH_PROTOCOL_VERSION,
				updatedAt: this.clock.now().toISOString(),
			});
			await this.state.update(DEVICE_PROFILE_KEY, refreshed);
			return refreshed;
		}

		const at = this.clock.now().toISOString();
		const profile = deviceProfileSchema.parse({
			schemaVersion: 2,
			deviceId: this.ids.next(),
			name: environment.defaultName,
			platform: environment.platform,
			architecture: environment.architecture,
			vscodeVersion: environment.vscodeVersion,
			extensionVersion: environment.extensionVersion,
			protocolVersion: MESH_PROTOCOL_VERSION,
			createdAt: at,
			updatedAt: at,
		});
		await this.state.update(DEVICE_PROFILE_KEY, profile);
		return profile;
	}

	public async rename(name: string): Promise<DeviceProfile> {
		const stored = this.state.get<unknown>(DEVICE_PROFILE_KEY);
		const parsed = deviceProfileSchema.safeParse(stored);
		if (!parsed.success) {
			throw new TypeError('Cannot rename a missing or invalid device profile.');
		}
		const profile = deviceProfileSchema.parse({
			...parsed.data,
			name,
			updatedAt: this.clock.now().toISOString(),
		});
		await this.state.update(DEVICE_PROFILE_KEY, profile);
		return profile;
	}
}
