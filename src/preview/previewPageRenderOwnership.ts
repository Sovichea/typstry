export type CleanablePdfPage = {
  cleanup(): void;
};

export class PreviewPageRenderOwnership<T extends CleanablePdfPage> {
  private readonly owners = new Map<T, number>();

  public retain(page: T): void {
    this.owners.set(page, (this.owners.get(page) ?? 0) + 1);
  }

  public release(page: T): void {
    const ownerCount = this.owners.get(page);
    if (ownerCount === undefined) return;
    const remaining = ownerCount - 1;
    if (remaining > 0) {
      this.owners.set(page, remaining);
      return;
    }
    this.owners.delete(page);
    page.cleanup();
  }

  public count(page: T): number {
    return this.owners.get(page) ?? 0;
  }
}
