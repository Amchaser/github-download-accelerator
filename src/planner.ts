import type { Chunk } from './types';

/** 默认块大小 8 MiB。取保守值以规避「大 Range 被 403」的上游限制（参见 aria2 issue #1627）。 */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

/** 块大小下限。小于此值仍失败则判定为硬失败，不再继续拆分。 */
export const MIN_CHUNK_SIZE = 1024 * 1024;

export function plan(total: number, chunkSize: number = DEFAULT_CHUNK_SIZE): Chunk[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`total 必须是非负整数，收到 ${total}`);
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkSize 必须是正整数，收到 ${chunkSize}`);
  }
  if (total === 0) return [];

  const chunks: Chunk[] = [];
  let index = 0;
  for (let start = 0; start < total; start += chunkSize) {
    chunks.push({ index: index++, start, end: Math.min(start + chunkSize, total) - 1 });
  }
  return chunks;
}

/**
 * 把一块均分为两块。用于「大 Range 被 403」时的本地递归降级。
 * 块长度不足 minChunkSize * 2 时返回 null，表示已达拆分下限。
 * minChunkSize 可覆盖是为了让测试能用小体积数据驱动拆分逻辑。
 */
export function splitChunk(chunk: Chunk, minChunkSize: number = MIN_CHUNK_SIZE): [Chunk, Chunk] | null {
  const len = chunk.end - chunk.start + 1;
  if (len < minChunkSize * 2) return null;
  const mid = chunk.start + Math.floor(len / 2);
  return [
    { index: 0, start: chunk.start, end: mid - 1 },
    { index: 1, start: mid, end: chunk.end },
  ];
}
