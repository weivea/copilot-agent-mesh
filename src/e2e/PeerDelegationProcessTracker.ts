import {
	selectOwnedProcesses,
	type OwnedProcessSelection,
	type ProcessTableEntry,
} from './MultiWindowE2eSupport';

export class PeerDelegationProcessTracker {
	public constructor(private readonly selection: OwnedProcessSelection) {}

	public select(entries: readonly ProcessTableEntry[]): readonly ProcessTableEntry[] {
		return selectOwnedProcesses(entries, this.selection);
	}
}
