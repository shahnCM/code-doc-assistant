import { createHash } from 'node:crypto';

export function contentHash(
  chunkerKind: string,
  filePath: string,
  symbolName: string | null,
  partIndex: number,
  content: string,
): string {
  return createHash('sha256')
    .update(chunkerKind)
    .update('\0')
    .update(filePath)
    .update('\0')
    .update(symbolName ?? '')
    .update('\0')
    .update(String(partIndex))
    .update('\0')
    .update(content)
    .digest('hex');
}
