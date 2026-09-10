import type {
	ConnectivityActionParams, ConnectivitySnapshot, NodeIdentityParams,
	RemotePolicyActionParams, RemotePolicyDashboard,
	DashboardManagement, DashboardManagementActionParams,
} from '../../shared/protocol';
import type { LocalIpcSession } from '../ipc';

export interface BrokerConnectivity {
	snapshot(caller: NodeIdentityParams, session: LocalIpcSession): Promise<ConnectivitySnapshot>;
	act(caller: NodeIdentityParams, input: ConnectivityActionParams, session: LocalIpcSession): Promise<void>;
	policySnapshot?(caller: NodeIdentityParams, session: LocalIpcSession): Promise<RemotePolicyDashboard>;
	policyAction?(caller: NodeIdentityParams, input: RemotePolicyActionParams, session: LocalIpcSession): Promise<void>;
	managementSnapshot?(caller: NodeIdentityParams, session: LocalIpcSession): Promise<DashboardManagement>;
	managementAction?(caller: NodeIdentityParams, input: DashboardManagementActionParams, session: LocalIpcSession): Promise<void>;
}
