import type Database from "better-sqlite3";
import type { GitHubClient } from "../github/client.js";
import { IngestionStore } from "../store/ingestion.js";
import type { NormalizedEvent } from "../types.js";
import type { EventSource, EventSourceRepository } from "./event-source.js";
import { normalizeReviewComment } from "./normalize.js";

export class PollingEventSource implements EventSource {
  private readonly checkpoints: IngestionStore;

  constructor(
    private readonly github: GitHubClient,
    db: Database.Database,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    this.checkpoints = new IngestionStore(db);
  }

  async poll(repository: EventSourceRepository): Promise<NormalizedEvent[]> {
    const prior = this.checkpoints.get(repository.id);
    const result = await this.github.pollReviewComments(repository.owner, repository.repo, {
      ...(prior?.since ? { since: prior.since } : {}),
      ...(prior?.etag ? { etag: prior.etag } : {}),
    });
    const events = result.comments.map((comment) =>
      normalizeReviewComment(repository.owner, repository.repo, comment),
    );
    const latest = events.reduce<string | null>(
      (value, event) => (value === null || event.observedAt > value ? event.observedAt : value),
      prior?.since ?? null,
    );
    this.checkpoints.save({
      repoId: repository.id,
      etag: result.etag,
      since: latest,
      lastPolledAt: this.clock(),
    });
    return events;
  }
}
