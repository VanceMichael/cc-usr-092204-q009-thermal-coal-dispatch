import { createServer } from "node:http";
import { loadContext, loadPlan } from "./catalog.js";
import { dutyView } from "./dispatch.js";

const routes = new Map([
  ["/health", async () => ({ body: { status: "ok" } })],
  ["/context", async () => ({ body: await loadContext() })],
  ["/plan", async () => ({ body: await loadPlan() })],
  // 值班员视图：未来缺口、可行替代、被挤占订单（需求 §8）。
  ["/duty-view", async () => ({ body: dutyView(await loadPlan()) })],
]);

export const server = createServer(async (request, response) => {
  const route = routes.get(request.url.split("?")[0]);
  if (!route) {
    response.writeHead(404);
    response.end();
    return;
  }
  const { body, status = 200 } = await route();
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
});

if (process.argv[1] === new URL(import.meta.url).pathname) {
  server.listen(8000, "127.0.0.1");
}
