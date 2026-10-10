import { request } from "node:http";

/** Read changing fragments on ONE authenticated SSE connection, without reload. */
export function watchJobFragments(input: {
  port: number;
  jobId: number;
  token: string;
  onFragment: (html: string) => void;
}): { ready: Promise<void>; close: () => void; errors: Error[] } {
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const errors: Error[] = [];
  let closing = false;
  const req = request({
    hostname: "127.0.0.1",
    port: input.port,
    path: `/jobs/${String(input.jobId)}/stream`,
    headers: { authorization: `Bearer ${input.token}` },
  });
  req.on("error", (error) => {
    if (closing) return;
    errors.push(error);
    rejectReady(error);
  });
  req.on("response", (response) => {
    if (response.statusCode !== 200) {
      const error = new Error(`acceptance SSE returned ${String(response.statusCode)}`);
      errors.push(error);
      rejectReady(error);
      response.destroy();
      return;
    }
    response.setEncoding("utf8");
    response.on("error", (error) => {
      if (closing) return;
      errors.push(error);
      rejectReady(error);
    });
    let pending = "";
    response.on("data", (chunk: string) => {
      if (closing) return;
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (!frame.startsWith("event: job-update\n")) continue;
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data === undefined) continue;
        try {
          const payload = JSON.parse(data.slice(6)) as {
            fragments?: Record<string, unknown>;
          };
          const html = payload.fragments?.["job-detail-region"];
          if (typeof html === "string") {
            input.onFragment(html);
            resolveReady();
          }
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error("invalid acceptance SSE frame");
          errors.push(error);
          rejectReady(error);
        }
      }
    });
  });
  req.end();
  return {
    ready,
    close: () => {
      closing = true;
      req.destroy();
    },
    errors,
  };
}
