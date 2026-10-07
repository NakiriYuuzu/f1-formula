/**
 * Resource tracker: every geometry / material / texture / render target a scene creates is registered
 * here and freed in one call on dispose().
 */

export interface Disposable {
  dispose(): void;
}

export class Disposer {
  private readonly items = new Set<Disposable>();

  /** Register a resource and return it unchanged. */
  add<T extends Disposable>(item: T): T {
    this.items.add(item);
    return item;
  }

  /** Free one tracked resource early (e.g. when replacing a texture). */
  release(item: Disposable | null | undefined): void {
    if (!item) return;
    if (this.items.delete(item)) item.dispose();
  }

  dispose(): void {
    for (const item of this.items) {
      try {
        item.dispose();
      } catch (err) {
        console.error('render: dispose failed', err);
      }
    }
    this.items.clear();
  }
}
