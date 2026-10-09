import { handleRequest } from "./app.ts";

export default {
  fetch(request) {
    return handleRequest(request);
  },
} satisfies ExportedHandler<Env>;
