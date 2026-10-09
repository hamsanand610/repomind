import { handleRequest } from "./app.ts";
import { nextBackgroundVersion, runStep } from "./ingest.ts";
import type { AppEnv } from "./platform.ts";
import { createServices } from "./services.ts";

export default {
  fetch(request, env) {
    return handleRequest(request, env as unknown as AppEnv);
  },

  // Once a minute, advance one unfinished job (indexing, embedding or cleanup)
  // so work continues when nobody has the page open.
  async scheduled(_controller, env) {
    const services = createServices(env as unknown as AppEnv);
    try {
      const versionId = await nextBackgroundVersion(services.db, services.now());
      if (versionId) await runStep(services, versionId);
    } catch (error) {
      console.error(JSON.stringify({ event: "background_step_failed", errorName: error instanceof Error ? error.name : typeof error }));
    }
  },
} satisfies ExportedHandler<Env>;
