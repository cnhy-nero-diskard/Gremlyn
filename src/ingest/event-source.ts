import type { NormalizedEvent } from "../types.js";

export interface EventSourceRepository {
  id: number;
  owner: string;
  repo: string;
}

/** Transport seam: downstream code receives normalized events only. */
export interface EventSource {
  poll(repository: EventSourceRepository): Promise<NormalizedEvent[]>;
}
