/**
 * 性能工具：零依赖 TTL 缓存 + 并发限制器
 *
 * 设计目标：
 *   - 不引入外部依赖（避免 ESM/CJS 互操作问题）
 *   - 轻量、足够小项目使用
 */

interface CacheEntry<V> {
  value: V;
  expireAt: number;
}

/**
 * 简单 TTL 缓存（内存）
 * - 按 key 过期，过期即删除
 * - 容量上限保护：超过 maxSize 时丢弃最早插入项（近似 LRU）
 */
export class TTLCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs: number, maxSize = 100) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expireAt) {
      this.store.delete(key);
      return undefined;
    }
    // 访问即刷新插入顺序（近似 LRU）
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      // 丢弃最早一项
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, { value, expireAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * 并发限制执行：对一批任务按 concurrency 并发执行，保持结果顺序
 * @param items       任务输入列表
 * @param concurrency 同时运行的最大任务数
 * @param worker      处理单个任务的异步函数
 * @returns           与输入同顺序的结果数组
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = new Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) break;
        results[i] = await worker(items[i], i);
      }
    });

  await Promise.all(runners);
  return results;
}
