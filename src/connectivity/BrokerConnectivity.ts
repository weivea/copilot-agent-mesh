import type {
	ConnectivityActionParams, ConnectivitySnapshot, NodeIdentityParams,
} from '../../shared/protocol';
import type { LocalIpcSession } from '../ipc';

export interface BrokerConnectivity {
	snapshot(caller: NodeIdentityParams, session: LocalIpcSession): Promise<ConnectivitySnapshot>;
	act(caller: NodeIdentityParams, input: ConnectivityActionParams, session: LocalIpcSession): Promise<void>;
}
