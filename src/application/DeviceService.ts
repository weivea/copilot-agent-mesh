import type { DeviceInfo } from '../../shared/protocol';
import { deviceInfoSchema } from '../../shared/protocol';
import type { LocalDesktopWorkspaceGuard } from './LocalDesktopWorkspaceGuard';
import type {
	DeviceEnvironment,
	DeviceProfile,
	DeviceProfileStore,
} from '../storage/DeviceProfileStore';
import type { WorkerOwnership } from '../storage/WorkerOwnerLock';

export class DeviceService {
	private profile: DeviceProfile | undefined;

	public constructor(
		private readonly profiles: DeviceProfileStore,
		private readonly environment: DeviceEnvironment,
		private readonly guard: LocalDesktopWorkspaceGuard,
		private readonly ownership?: WorkerOwnership,
	) {}

	public async initialize(): Promise<DeviceProfile> {
		await this.ownership?.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		this.profile = await this.profiles.getOrCreate(this.environment);
		return this.profile;
	}

	public initializeReadOnly(): DeviceProfile {
		this.guard.assertAllowed({ requireWorkspace: false });
		this.profile = this.profiles.getReadOnly(this.environment);
		return this.profile;
	}

	public async getInfo(_authenticatedPeerId: string): Promise<DeviceInfo> {
		this.guard.assertAllowed({ requireWorkspace: false });
		const profile = this.profile ?? await this.initialize();
		return deviceInfoSchema.parse({
			deviceId: profile.deviceId,
			name: profile.name,
			platform: profile.platform,
			architecture: profile.architecture,
			vscodeVersion: profile.vscodeVersion,
			extensionVersion: profile.extensionVersion,
			protocolVersion: profile.protocolVersion,
		});
	}

	public async rename(name: string): Promise<DeviceProfile> {
		await this.ownership?.assertOwner();
		this.guard.assertAllowed({ requireWorkspace: false });
		this.profile = await this.profiles.rename(name);
		return this.profile;
	}

	public current(): DeviceProfile {
		if (this.profile === undefined) {
			throw new Error('Device service has not been initialized.');
		}
		return this.profile;
	}
}
