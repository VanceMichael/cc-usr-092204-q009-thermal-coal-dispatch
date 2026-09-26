import { readFile } from "node:fs/promises";

export async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function loadContext(path = new URL("../fixtures/context.json", import.meta.url)) {
  return loadJson(path);
}

export function loadPlan(path = new URL("../fixtures/rolling-plan.json", import.meta.url)) {
  return loadJson(path);
}
