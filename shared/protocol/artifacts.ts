import { z } from 'zod';

import { PROTOCOL_LIMITS, utf8String } from './limits';
import { timestampSchema, uuidSchema } from './models';

export const ARTIFACT_MEDIA_TYPES = [
	'application/json',
	'application/schema+json',
	'application/vnd.oai.openapi+json',
] as const;

export const artifactMediaTypeSchema = z.enum(ARTIFACT_MEDIA_TYPES);

export const artifactReferenceSchema = z.strictObject({
	artifactId: uuidSchema,
	runId: uuidSchema,
	producerTaskId: uuidSchema,
	label: utf8String(PROTOCOL_LIMITS.artifactLabelBytes, 'artifact label', 1),
	mediaType: artifactMediaTypeSchema,
	contentLength: z.number().int().positive().max(PROTOCOL_LIMITS.artifactContentBytes),
	sha256: z.string().regex(/^[a-f0-9]{64}$/u),
	revision: z.literal(1),
	createdAt: timestampSchema,
});

export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
