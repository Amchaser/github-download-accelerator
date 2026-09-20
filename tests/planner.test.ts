import { describe, it, expect } from 'vitest';
import { plan, splitChunk, DEFAULT_CHUNK_SIZE, MIN_CHUNK_SIZE } from '../src/planner';

describe('plan', () => {
  it('总长为 0 时返回空数组', () => {
    expect(plan(0)).toEqual([]);
  });

  it('整除时块数与区间正确', () => {
    expect(plan(8, 4)).toEqual([
      { index: 0, start: 0, end: 3 },
      { index: 1, start: 4, end: 7 },
    ]);
  });

  it('不整除时最后一块被截断到 total-1', () => {
    expect(plan(10, 4)).toEqual([
      { index: 0, start: 0, end: 3 },
      { index: 1, start: 4, end: 7 },
      { index: 2, start: 8, end: 9 },
    ]);
  });

  it('total 小于块大小时只有一块', () => {
    expect(plan(3, 100)).toEqual([{ index: 0, start: 0, end: 2 }]);
  });

  it('覆盖全部字节且无缝隙无重叠', () => {
    const chunks = plan(499558899, DEFAULT_CHUNK_SIZE);
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(499558899 - 1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBe(chunks[i - 1].end + 1);
    }
  });

  it('拒绝负数与非整数', () => {
    expect(() => plan(-1)).toThrow();
    expect(() => plan(1.5)).toThrow();
    expect(() => plan(10, 0)).toThrow();
  });
});

describe('splitChunk', () => {
  // 凡是要走到「拆分」分支的用例都必须显式传 minChunkSize。默认下限 1 MiB，
  // 而测试块只有几十字节，`len < minChunkSize * 2` 恒成立，会直接返回 null。
  it('把一块均分为两块', () => {
    expect(splitChunk({ index: 0, start: 0, end: 9 }, 5)).toEqual([
      { index: 0, start: 0, end: 4 },
      { index: 1, start: 5, end: 9 },
    ]);
  });

  it('奇数长度时前半段较短', () => {
    expect(splitChunk({ index: 0, start: 0, end: 8 }, 4)).toEqual([
      { index: 0, start: 0, end: 3 },
      { index: 1, start: 4, end: 8 },
    ]);
  });

  it('单字节块无法再分，返回 null', () => {
    expect(splitChunk({ index: 0, start: 5, end: 5 })).toBeNull();
  });

  it('已到 MIN_CHUNK_SIZE 的块返回 null', () => {
    expect(splitChunk({ index: 0, start: 0, end: MIN_CHUNK_SIZE - 1 })).toBeNull();
  });

  it('可用 minChunkSize 覆盖默认下限（测试与小文件场景需要）', () => {
    expect(splitChunk({ index: 0, start: 0, end: 1023 }, 256)).toEqual([
      { index: 0, start: 0, end: 511 },
      { index: 1, start: 512, end: 1023 },
    ]);
    // len === minChunkSize * 2 必须仍可拆成两个「恰好等于下限」的块——这是
    // 「降到下限 1 MB 仍失败才转单连接」的必要条件。若把实现里的 `<` 改成 `<=`，
    // 下限会实际退化为 2 倍，永远拆不到 1 MB。
    expect(splitChunk({ index: 0, start: 0, end: 511 }, 256)).toEqual([
      { index: 0, start: 0, end: 255 },
      { index: 1, start: 256, end: 511 },
    ]);
    // len === minChunkSize * 2 - 1 时才无法对半分成两个 ≥ 下限的块
    expect(splitChunk({ index: 0, start: 0, end: 510 }, 256)).toBeNull();
  });
});
