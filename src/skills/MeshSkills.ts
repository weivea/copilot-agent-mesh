import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TASK_TOOL_LIMITS } from '../../shared/toolProtocol';

export function loadMeshExecutionInstructions(extensionRoot: string): string {
	const markdown = readFileSync(join(extensionRoot, 'skills', 'mesh-execute', 'SKILL.md'), 'utf8');
	return parseMeshExecutionInstructions(markdown);
}

export function parseMeshExecutionInstructions(markdown: string): string {
	const normalized = markdown.replace(/\r\n/gu, '\n');
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(normalized);
	if (match === null || !/^name: mesh-execute$/mu.test(match[1]) || match[2].trim().length === 0) {
		throw new Error('The bundled mesh-execute skill must have valid frontmatter and a non-empty body.');
	}
	const instructions = match[2].trim();
	buildMeshExecutionPrompt('', instructions);
	return instructions;
}

export function buildMeshExecutionPrompt(prompt: string, instructions: string): string {
	if (instructions.trim().length === 0) {
		throw new Error('Mesh execution instructions must not be empty.');
	}
	const combined = `${instructions}\n\n## Delegated task\n\n${prompt}`;
	if (Buffer.byteLength(combined, 'utf8') > TASK_TOOL_LIMITS.promptBytes) {
		throw new Error('The task prompt including bundled mesh-execute guidance exceeds the 128 KiB UTF-8 limit.');
	}
	return combined;
}
