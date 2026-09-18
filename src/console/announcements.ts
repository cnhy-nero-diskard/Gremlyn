export type AnnouncementPriority = "polite" | "assertive";

export interface ConsoleAnnouncement {
  readonly channel: string;
  readonly eventKey: string;
  readonly message: string;
  readonly priority: AnnouncementPriority;
}

/** Small bounded deduper for semantic console announcements. */
export class AnnouncementDeduper {
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries = 256) {}

  next(
    channel: string,
    eventKey: string,
    message: string,
    priority: AnnouncementPriority = "polite",
  ): ConsoleAnnouncement | undefined {
    const key = `${channel}\u0000${eventKey}\u0000${message}`;
    if (this.seen.has(key)) return undefined;
    this.seen.add(key);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return { channel, eventKey, message, priority };
  }

  clear(): void {
    this.seen.clear();
  }
}
