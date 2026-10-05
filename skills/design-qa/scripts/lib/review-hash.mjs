import { createHash } from 'node:crypto';
export const evidenceHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const reviewDigest = record => evidenceHash(JSON.stringify({ sources: record.sources, images: record.images }));
