import type { AgentMeshExtensionApi } from '../composition/createApplication';
import {
	runWindowE2eHost,
	runWindowE2eHostWithApi,
} from './WindowE2eHost';

const options = {
	environmentPrefix: 'MESH_MULTI_WINDOW_E2E',
	controller: (api: AgentMeshExtensionApi) => api.multiWindowE2e,
	label: 'multi-window E2E',
} as const;

export function run(): Promise<void> {
	return runWindowE2eHost(options);
}

export function runWithApi(api: AgentMeshExtensionApi): Promise<void> {
	return runWindowE2eHostWithApi(api, options);
}
