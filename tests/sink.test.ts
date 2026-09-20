import { describe, it, expect, vi } from 'vitest';
import { supportsFsa, createFsaSink, UnsupportedBrowserError } from '../src/sink';

describe('supportsFsa', () => {
  it('showSaveFilePicker 与 createWritable 同时存在时为 true', () => {
    const stream = { createWritable: vi.fn() };
    expect(supportsFsa({ showSaveFilePicker: vi.fn(), FileSystemFileHandle: { prototype: stream } } as never)).toBe(true);
  });

  it('showSaveFilePicker 缺失时为 false', () => {
    expect(supportsFsa({} as never)).toBe(false);
  });

  it('仅有 showSaveFilePicker 而 createWritable 缺失时为 false（iOS Firefox 的情况）', () => {
    expect(supportsFsa({ showSaveFilePicker: vi.fn() } as never)).toBe(false);
  });

  it('句柄存在但 createWritable 缺失时为 false（约束原名的形状）', () => {
    // 前一条用例传的对象里**根本没有** FileSystemFileHandle，故它区分不出
    // 「检查 createWritable」与「只检查 FileSystemFileHandle 是否存在」——
    // 把实现换成后者也照样通过。这一条才是约束真正要钉的形状。
    expect(
      supportsFsa({ showSaveFilePicker: vi.fn(), FileSystemFileHandle: { prototype: {} } } as never),
    ).toBe(false);
  });

  it('显式传入 null 时返回 false 而非抛错', () => {
    expect(supportsFsa(null)).toBe(false);
  });
});

describe('createFsaSink', () => {
  it('不支持时抛 UnsupportedBrowserError', async () => {
    await expect(createFsaSink('a.bin', {} as never)).rejects.toBeInstanceOf(UnsupportedBrowserError);
  });

  it('调用 showSaveFilePicker 并传入 suggestedName', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close, abort }),
    });
    const win = {
      showSaveFilePicker,
      FileSystemFileHandle: { prototype: { createWritable: vi.fn() } },
    } as never;

    const sink = await createFsaSink('a.bin', win);
    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'a.bin' });

    await sink.write(100, new Uint8Array([1, 2, 3]));
    expect(write).toHaveBeenCalledWith({ type: 'write', position: 100, data: new Uint8Array([1, 2, 3]) });

    await sink.close();
    expect(close).toHaveBeenCalled();
  });

  it('createWritable 不得传 keepExistingData', async () => {
    const createWritable = vi.fn().mockResolvedValue({
      write: vi.fn(), close: vi.fn(), abort: vi.fn(),
    });
    const win = {
      showSaveFilePicker: vi.fn().mockResolvedValue({ createWritable }),
      FileSystemFileHandle: { prototype: { createWritable: vi.fn() } },
    } as never;
    await createFsaSink('a.bin', win);
    expect(createWritable).toHaveBeenCalledWith();
  });

  it('abort 为同步方法时只调 abort，绝不调 close', async () => {
    // 原写法 `abort?.() ?? close()` 在这里会连 close 一起调用——把 abort 刚丢弃的
    // 半成品又重新提交。同步 abort 返回 undefined，`??` 分辨不出这与「方法不存在」。
    const write = vi.fn();
    const close = vi.fn();
    const abort = vi.fn(); // 同步，返回 undefined
    const win = {
      showSaveFilePicker: vi.fn().mockResolvedValue({
        createWritable: vi.fn().mockResolvedValue({ write, close, abort }),
      }),
      FileSystemFileHandle: { prototype: { createWritable: vi.fn() } },
    } as never;
    const sink = await createFsaSink('a.bin', win);
    await sink.abort();
    expect(abort).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('流没有 abort 时也不调 close（不提交半成品），且不抛错', async () => {
    const write = vi.fn();
    const close = vi.fn();
    const win = {
      showSaveFilePicker: vi.fn().mockResolvedValue({
        createWritable: vi.fn().mockResolvedValue({ write, close }), // 无 abort
      }),
      FileSystemFileHandle: { prototype: { createWritable: vi.fn() } },
    } as never;
    const sink = await createFsaSink('a.bin', win);
    await expect(sink.abort()).resolves.toBeUndefined();   // 标题里的「不抛错」显式断言
    expect(close).not.toHaveBeenCalled();
  });
  it('abort 会等待流自身的 abort 完成，不会提前 resolve', async () => {
    // 引擎的失败路径与 UI 切单连接回退都在 await sink.abort() 之后继续；若把 :43 的
    // await 去掉（fire-and-forget），取消尚未完成就会进入下一步，而现有两条 abort 用例
    // 都会照样通过——这条专门钉住那个 await。
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const write = vi.fn();
    const close = vi.fn();
    const abort = vi.fn(() => gate);
    const win = {
      showSaveFilePicker: vi.fn().mockResolvedValue({
        createWritable: vi.fn().mockResolvedValue({ write, close, abort }),
      }),
      FileSystemFileHandle: { prototype: { createWritable: vi.fn() } },
    } as never;
    const sink = await createFsaSink('a.bin', win);
    let settled = false;
    const p = sink.abort().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));   // 让一轮宏任务过去
    expect(settled).toBe(false);                  // 流未放行前不得 resolve
    release();
    await p;
    expect(settled).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });
});
