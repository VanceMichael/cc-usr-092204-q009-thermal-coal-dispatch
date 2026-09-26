// 对应规则 R4（数量守恒）与 R5（幂等报送）。

export const LEGS = ["装车", "在途", "到厂", "退运"];

// 重复报送按 report_id 去重，首次到达为准（R5）。
export function dedupeReports(reports) {
  const seen = new Map();
  for (const report of reports) {
    if (!seen.has(report.report_id)) {
      seen.set(report.report_id, report);
    }
  }
  return [...seen.values()];
}

// 汇总某批次各环节数量（先按 R5 去重）。
export function summarizeBatch(reports, batchId) {
  const totals = Object.fromEntries(LEGS.map((leg) => [leg, 0]));
  for (const report of dedupeReports(reports)) {
    if (report.batch_id === batchId) {
      totals[report.leg] += report.quantity_tonnes;
    }
  }
  return totals;
}

// 守恒校验（R4）：到厂量 + 退运量不得超过装车量，
// 超出部分即虚假库存；在途未结量 = 装车量 - 到厂量 - 退运量。
export function checkConservation(summary) {
  const accounted = summary["到厂"] + summary["退运"];
  const phantom = Math.max(0, accounted - summary["装车"]);
  return {
    ok: phantom === 0,
    loaded: summary["装车"],
    accounted,
    inTransit: summary["装车"] - accounted,
    phantom,
  };
}
