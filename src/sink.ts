import type { Sink } from './types';

export class UnsupportedBrowserError extends Error {
  constructor() {
    super('当前浏览器不支持 File System Access API（请使用 Chrome / Edge / Opera）');
    this.name = 'UnsupportedBrowserError';
  }
}

/**
 * 能力检测必须同时检查 createWritable——iOS 上的 Firefox 会暴露
 * showSaveFilePicker 却没有 createWritable。
 */
export function supportsFsa(win: unknown = globalThis): boolean {
  // 显式传入 null 会让 `typeof w.showSaveFilePicker` 抛 TypeError。参数类型是 unknown，
  // 故 null 能通过类型检查——而检测函数应当**总是返回布尔**，不能有抛错路径。
  if (win == null) return false;
  const w = win as Record<string, unknown>;
  if (typeof w.showSaveFilePicker !== 'function') return false;
  const proto = (w.FileSystemFileHandle as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  return typeof proto?.createWritable === 'function';
}

/** 把 FSA 的流包成 Sink。不做任何缓冲——直接透传定位写入。 */
function wrap(stream: {
  write(d: { type: 'write'; position: number; data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void> | void;   // 规范保证存在且返回 Promise；允许 void 以覆盖被包装/被 mock 的流
}): Sink {
  return {
    write: (position, data) => stream.write({ type: 'write', position, data }),
    close: () => stream.close(),
    abort: async () => {
      // **绝不能用 close() 兜底**：FSA 的写入先进临时文件，只有 close() 才提交，
      // 而 abort() 的用途是**丢弃**（引擎在失败路径调它、UI 在切单连接回退前也调它）。
      // 回退到 close() 会把半成品提交成正式文件；若目标已存在，还会覆盖用户的原文件。
      // 而且 `abort?.() ?? close()` 这个写法本身就是错的：`??` 分辨不出「方法不存在」
      // 与「方法存在但返回 undefined」——同步 abort 会让 close 在其后**再跑一次**，
      // 把刚丢弃的文件又提交了。
      // 正确降级：无 abort 时**什么都不做**——不提交即等于丢弃，语义恰好一致。
      // 注意：此处仍会**传播**流自身 abort() 的拒绝（上游 await 得到它才是对的），
      // 只在「没有可调用的 abort」时才什么都不做。
      // 用 typeof 检查而非真值检查：非函数的 abort 属性（如 { abort: 42 }）会走到
      // 这里的调用并抛 TypeError，那样「不抛错」就不成立了。也顺手把这里与上面的检测
      // 统一成同一写法。
      if (typeof stream.abort === 'function') {
        await stream.abort();
      }
    },
  };
}

export async function createFsaSink(suggestedName: string, win: unknown = globalThis): Promise<Sink> {
  if (!supportsFsa(win)) throw new UnsupportedBrowserError();
  const w = win as {
    showSaveFilePicker(o: { suggestedName: string }): Promise<{
      createWritable(): Promise<Parameters<typeof wrap>[0]>;
    }>;
  };
  const handle = await w.showSaveFilePicker({ suggestedName });
  // 刻意不传 keepExistingData：传 true 会先整份复制现有文件，对大文件是一次完整拷贝。
  const stream = await handle.createWritable();
  return wrap(stream);
}
