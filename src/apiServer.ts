import { app } from "./app.js";
import { env } from "./config/env.js";
import { getListenOptions } from "./config/listen.js";

export function startApiServer(port = env.PORT) {
  const options = getListenOptions(port, "api");
  return app.listen(options, () => {
    console.log(`Relay API running on ${options.host ?? "unspecified interfaces"} port ${port} (RateLimit: ${env.RATE_LIMIT_MAX_REQUESTS} req / ${env.RATE_LIMIT_WINDOW_SECONDS}s)`);
  });
}
