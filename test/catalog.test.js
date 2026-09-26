import test from "node:test";
import assert from "node:assert/strict";
import { loadContext } from "../src/catalog.js";

test("领域资料可以载入", async () => {
  const context = await loadContext();
  assert.ok(context.project);
  assert.ok(context.facts.length >= 3);
  assert.ok(context.actors.length >= 3);
});

test("领域术语覆盖调度关键概念", async () => {
  const context = await loadContext();
  for (const term of ["滚动计划", "紧急倾斜", "数量守恒", "幂等报送", "双人批准", "指令恢复"]) {
    assert.ok(context.terms[term], `缺少术语：${term}`);
  }
});
