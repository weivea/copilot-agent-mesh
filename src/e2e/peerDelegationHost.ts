import type { AgentMeshExtensionApi } from '../composition/createApplication';
import {
	runWindowE2eHost,
	runWindowE2eHostWithApi,
} from './WindowE2eHost';

const options = {
	environmentPrefix: 'MESH_PEER_DELEGATION_E2E',
	controller: (api: AgentMeshExtensionApi) => api.peerDelegationE2e,
	label: 'peer-delegation E2E',
} as const;

export function run(): Promise<void> {
	return runWindowE2eHost(options);
}

export function runWithApi(api: AgentMeshExtensionApi): Promise<void> {
	return runWindowE2eHostWithApi(api, options);
}
