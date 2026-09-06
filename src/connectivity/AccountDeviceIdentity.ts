import {
	createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync,
	type KeyObject,
} from 'node:crypto';
import { z } from 'zod';

import { uuidSchema } from '../../shared/protocol';
import type { SecretStore } from '../gateway/SecretStore';
import type { AtomicFileStore } from '../storage/AtomicFileStore';
import { assertDocumentFence, FencedDocumentStore, type DocumentFence } from '../storage/FencedDocumentStore';
import {
	accountDeviceIdentitySchema, ConnectivityError, type AccountBinding, type AccountDeviceIdentity,
} from './ConnectivitySchemas';

const identitiesSchema = z.strictObject({
	schemaVersion: z.literal(1),
	revision: z.number().int().nonnegative(),
	identities: z.array(z.strictObject({
		accountRef: uuidSchema,
		publicKey: accountDeviceIdentitySchema.shape.publicKey,
	})).max(32),
});

export interface AccountPeerCredential {
	readonly peerId: string;
	readonly root: string;
	readonly transcriptHash: string;
}

export class AccountDeviceIdentityStore {
	private readonly document: FencedDocumentStore<z.infer<typeof identitiesSchema>>;
	private loaded: { accountRef: string; identity: AccountDeviceIdentity; privateKey: KeyObject } | undefined;

	public constructor(
		files: AtomicFileStore,
		private readonly fence: DocumentFence,
		private readonly secrets: SecretStore,
		private readonly deviceId: string,
	) {
		this.document = new FencedDocumentStore(files, 'connectivity/identities.json', identitiesSchema, {
			schemaVersion: 1, revision: 0, identities: [],
		}, fence);
	}

	public initialize(): Promise<void> { return this.document.initialize(); }

	public current(accountRef: string | undefined): AccountDeviceIdentity | undefined {
		return this.loaded?.accountRef === accountRef ? this.loaded?.identity : undefined;
	}

	public async load(account: AccountBinding): Promise<AccountDeviceIdentity> {
		await assertDocumentFence(this.fence);
		const pinned = this.document.snapshot().identities.find((entry) => entry.accountRef === account.accountRef);
		const keyRef = `mesh.accountIdentity.${account.accountRef}`;
		let encoded = await this.secrets.get(keyRef);
		if (encoded === undefined) {
			if (pinned !== undefined) { throw new ConnectivityError('BINDING_CHANGED'); }
			const pair = generateKeyPairSync('x25519');
			encoded = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
			await assertDocumentFence(this.fence);
			await this.secrets.store(keyRef, encoded);
		}
		const privateKey = readPrivateKey(encoded);
		const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url');
		if (pinned !== undefined && pinned.publicKey !== publicKey) {
			throw new ConnectivityError('BINDING_CHANGED');
		}
		const identity = accountDeviceIdentitySchema.parse({ deviceId: this.deviceId, publicKey });
		if (pinned === undefined) {
			await this.document.update((value) => ({
				...value, identities: [...value.identities, { accountRef: account.accountRef, publicKey }],
			}));
		}
		await assertDocumentFence(this.fence);
		this.loaded = { accountRef: account.accountRef, identity, privateKey };
		return identity;
	}

	/** Public keys must come from the authenticated caller-owned tunnel directory, never a peer request. */
	public derive(account: AccountBinding, remote: AccountDeviceIdentity, incoming: boolean): AccountPeerCredential {
		if (this.loaded?.accountRef !== account.accountRef || remote.deviceId === this.deviceId) {
			throw new ConnectivityError('BINDING_CHANGED');
		}
		const remoteKey = readAccountPublicKey(remote.publicKey);
		const coordinator = incoming ? remote : this.loaded.identity;
		const worker = incoming ? this.loaded.identity : remote;
		const transcript = JSON.stringify([
			'mesh/account-peer/v1', account.providerId, account.accountId,
			coordinator.deviceId, coordinator.publicKey, worker.deviceId, worker.publicKey,
		]);
		const hash = createHash('sha256').update(transcript).digest();
		let shared: Buffer;
		try {
			shared = diffieHellman({ privateKey: this.loaded.privateKey, publicKey: remoteKey });
		} catch {
			throw new ConnectivityError('INVALID_ENDPOINT');
		}
		const root = Buffer.from(hkdfSync('sha256', shared, hash, 'mesh/account-root/v1', 32)).toString('base64url');
		shared.fill(0);
		const id = Buffer.from(hash.subarray(0, 16));
		id[6] = (id[6] & 0x0f) | 0x40;
		id[8] = (id[8] & 0x3f) | 0x80;
		const hex = id.toString('hex');
		return {
			peerId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
			root, transcriptHash: hash.toString('base64url'),
		};
	}
}

export function readAccountPublicKey(encoded: string): KeyObject {
	try {
		accountDeviceIdentitySchema.shape.publicKey.parse(encoded);
		const key = createPublicKey({ key: Buffer.from(encoded, 'base64url'), type: 'spki', format: 'der' });
		if (key.asymmetricKeyType !== 'x25519'
			|| key.export({ type: 'spki', format: 'der' }).toString('base64url') !== encoded) {
			throw new ConnectivityError('INVALID_ENDPOINT');
		}
		return key;
	} catch {
		throw new ConnectivityError('INVALID_ENDPOINT');
	}
}

function readPrivateKey(encoded: string): KeyObject {
	try {
		if (!/^[A-Za-z0-9_-]{64}$/u.test(encoded)) { throw new ConnectivityError('BINDING_CHANGED'); }
		const key = createPrivateKey({ key: Buffer.from(encoded, 'base64url'), type: 'pkcs8', format: 'der' });
		if (key.asymmetricKeyType !== 'x25519') { throw new ConnectivityError('BINDING_CHANGED'); }
		return key;
	} catch {
		throw new ConnectivityError('BINDING_CHANGED');
	}
}
