import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dedupeReports, summarizeBatch, checkConservation } from "../src/conservation.js";

const reports = JSON.parse(
  await readFile(new URL("../fixtures/leg-reports.json", import.meta.url), "utf8"),
);

test("重复报送按 report_id 去重（R5）", () => {
  assert.equal(reports.length, 5);
  assert.equal(dedupeReports(reports).length, 4);
});

test("同一批煤数量守恒（R4）", () => {
  const summary = summarizeBatch(reports, "B-20260701-001");
  assert.equal(summary["装车"], 3000);
  const result = checkConservation(summary);
  assert.ok(result.ok);
  assert.equal(result.phantom, 0);
  assert.equal(result.inTransit, 0);
});

test("未去重的重复报送会形成虚假库存（R4/R5）", () => {
  const arrived = reports
    .filter((report) => report.leg === "到厂")
    .reduce((sum, report) => sum + report.quantity_tonnes, 0);
  assert.ok(arrived > 3000);
});

test("报送时间均含时区偏移，晚到数据可按发生时间归位（R5）", () => {
  const offset = /(Z|[+-]\d{2}:\d{2})$/;
  for (const report of reports) {
    assert.match(report.occurred_at, offset);
    assert.match(report.reported_at, offset);
  }
  const late = reports.find((report) => report.report_id === "R-1003");
  assert.ok(new Date(late.reported_at) > new Date(late.occurred_at));
});
