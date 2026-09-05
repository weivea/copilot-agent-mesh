import type {
	ConnectivityActionParams, ConnectivitySnapshot, NodeIdentityParams,
	RemotePolicyActionParams, RemotePolicyDashboard,
} from '../../shared/protocol';
import type { LocalIpcSession } from '../ipc';

export interface BrokerConnectivity {
	snapshot(caller: NodeIdentityParams, session: LocalIpcSession): Promise<ConnectivitySnapshot>;
	act(caller: NodeIdentityParams, input: ConnectivityActionParams, session: LocalIpcSession): Promise<void>;
	policySnapshot?(caller: NodeIdentityParams, session: LocalIpcSession): Promise<RemotePolicyDashboard>;
	policyAction?(caller: NodeIdentityParams, input: RemotePolicyActionParams, session: LocalIpcSession): Promise<void>;
}
