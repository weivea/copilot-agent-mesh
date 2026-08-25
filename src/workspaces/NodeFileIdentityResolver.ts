import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
	FileIdentityResolver,
	ResolvedFileIdentity,
} from './WorkspaceRegistry';

export interface FileIdentityFileSystem {
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<{
		readonly dev: number | bigint;
		readonly ino: number | bigint;
	}>;
}

const nodeFileIdentityFileSystem: FileIdentityFileSystem = {
	realpath,
	stat,
};

export class NodeFileIdentityResolver implements FileIdentityResolver {
	public constructor(
		private readonly fileSystem: FileIdentityFileSystem = nodeFileIdentityFileSystem,
	) {}

	public async resolve(localUri: string): Promise<ResolvedFileIdentity> {
		const canonicalPath = await this.fileSystem.realpath(fileURLToPath(localUri));
		const canonicalUri = pathToFileURL(canonicalPath).href;
		const fileStat = await this.fileSystem.stat(canonicalPath);
		const identity = fileStat.ino === 0 || fileStat.ino === 0n
			? `path:${canonicalUri}`
			: `file:${String(fileStat.dev)}:${String(fileStat.ino)}`;
		return { canonicalUri, identity };
	}
}
