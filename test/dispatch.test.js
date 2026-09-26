import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BatchLedger,
  STAGES,
  assertConfirmer,
  assertReSequencingApproval,
  applyLateStockReport,
  businessDate,
  dutyView,
  explainPriority,
  feasibleAlternatives,
  firstGap,
  heatFactorForTemp,
  projectInventory,
  recordPriorityDecision,
  revisePlan,
} from "../src/dispatch.js";
import { InstructionStore } from "../src/instruction-store.js";
import { loadPlan } from "../src/catalog.js";

// §3 高温折算与库存投影
test("高温系数按温度区间取值", () => {
  const bands = [
    { above: 40, factor: 1.25 },
    { above: 38, factor: 1.15 },
    { above: 35, factor: 1.05 },
  ];
  assert.equal(heatFactorForTemp(41, bands), 1.25);
  assert.equal(heatFactorForTemp(39, bands), 1.15);
  assert.equal(heatFactorForTemp(30, bands), 1);
});

test("库存投影逐日扣减并定位首个缺口", async () => {
  const plan = await loadPlan();
  const plantA = plan.plants[0];
  const projection = projectInventory(plantA);
  // 首日：42000 - 6000*1.15 + 5000 = 40100
  assert.equal(projection[0].stockAfterTons, 40100);
  const gap = firstGap(plantA);
  assert.ok(gap, "连续高温叠加到货下滑应当出现缺口");
  assert.equal(gap.plantId, "PLT-A");
  assert.ok(gap.gapTons > 0);
  // 库存充裕的 PLT-B 不应报缺口
  assert.equal(firstGap(plan.plants[1]), null);
});

// §2/§3 三重能力约束下的可行替代
test("可行替代取煤矿/线路/车底三重最小值并扣除已承诺", () => {
  const [a, b] = feasibleAlternatives([
    { region: "A", date: "2026-07-18", mineLoadableTons: 20000, lineCapacityTons: 15000, railcarTurnoverTons: 18000, committedTons: 9000 },
    { region: "B", date: "2026-07-18", mineLoadableTons: 5000, lineCapacityTons: 14000, railcarTurnoverTons: 13000, committedTons: 10000 },
  ]);
  assert.equal(a.reallocatableTons, 6000);
  assert.equal(b.reallocatableTons, 0, "可再安排量不得为负");
});

// §2 修订只能影响未执行区间
test("冻结区间内的修订被拒绝，区间外允许", async () => {
  const plan = await loadPlan();
  assert.throws(
    () => revisePlan(plan, { "2026-07-16": { "PLT-A": { arrivalTons: 9999 } } }),
    /REVISION_FROZEN/,
  );
  const next = revisePlan(plan, { "2026-07-19": { "PLT-A": { arrivalTons: 12000 } } });
  assert.equal(next.version, plan.version + 1);
  const day = next.plants[0].daily.find((d) => d.date === "2026-07-19");
  assert.equal(day.arrivalTons, 12000);
  // 原计划不被修改
  assert.equal(plan.plants[0].daily.find((d) => d.date === "2026-07-19").arrivalTons, 3000);
});

// §4 紧急倾斜
test("无缺口或阈值未满足时不得发起倾斜", async () => {
  const plan = await loadPlan();
  assert.throws(
    () =>
      recordPriorityDecision(plan, {
        date: "2026-07-18",
        plantId: "PLT-B",
        emergencyOrderId: "ORD-2203",
        preemptedOrderIds: [],
        thresholdDays: 7,
        reason: "B厂告急",
        seq: 1,
      }),
    /PRIORITY_WITHOUT_GAP/,
  );

  const tooHighThreshold = 3; // PLT-A 当前 42000/6900≈6.09 天，高于 3
  assert.throws(
    () =>
      recordPriorityDecision(plan, {
        date: "2026-07-18",
        plantId: "PLT-A",
        emergencyOrderId: "ORD-2204",
        preemptedOrderIds: ["ORD-2202"],
        thresholdDays: tooHighThreshold,
        reason: "高温保民生",
        seq: 1,
      }),
    /THRESHOLD_NOT_MET/,
  );
});

test("倾斜记录阈值证据并把被挤占订单置位，审计可解释", async () => {
  const plan = await loadPlan();
  const { plan: next, decision } = recordPriorityDecision(plan, {
    date: "2026-07-18",
    plantId: "PLT-A",
    emergencyOrderId: "ORD-2204",
    preemptedOrderIds: ["ORD-2202"],
    thresholdDays: 7,
    reason: "连续高温、A区民生供电优先",
    seq: 1,
  });
  assert.equal(decision.decisionId, "PD-20260718-001");
  assert.equal(decision.trigger.currentSafetyDays, Number((42000 / 6900).toFixed(3)));
  assert.deepEqual(decision.preemptedOrders, [{ orderId: "ORD-2202", tons: 3000 }]);
  assert.equal(next.orders.find((o) => o.orderId === "ORD-2202").status, "preempted");
  assert.equal(next.orders.find((o) => o.orderId === "ORD-2204").status, "prioritized");
  // 未参与的合同订单不受影响
  assert.equal(next.orders.find((o) => o.orderId === "ORD-2201").status, "committed");

  const explanation = explainPriority(next, decision.decisionId);
  assert.match(explanation.justification, /低于触发阈值/);
  assert.match(explanation.justification, /ORD-2202/);
});

// §1 环节确认角色
test("事件须由所属环节一方确认", () => {
  assert.doesNotThrow(() => assertConfirmer(STAGES.LOAD, "矿区"));
  assert.throws(() => assertConfirmer(STAGES.LOAD, "电厂"), /CONFIRMER_ROLE_MISMATCH/);
  assert.throws(() => assertConfirmer(STAGES.IN_TRANSIT, "矿区"), /CONFIRMER_ROLE_MISMATCH/);
  assert.doesNotThrow(() => assertConfirmer(STAGES.RETURN, "电厂", "plant"));
});

// §5 数量守恒
test("批次在装车/在途/到厂/退运间守恒", () => {
  const ledger = new BatchLedger();
  const ev = (eventId, stage, tons, confirmerRole, extra = {}) =>
    ledger.record({
      eventId,
      batchId: "B-001",
      stage,
      tons,
      occurredAt: "2026-07-18T08:00:00Z",
      confirmerRole,
      ...extra,
    });

  ev("E1", STAGES.LOAD, 5000, "矿区");
  ev("E2", STAGES.IN_TRANSIT, 3000, "铁路");
  ev("E3", STAGES.ARRIVE, 2000, "电厂");
  ev("E4", STAGES.RETURN, 500, "电厂", { fromStage: "plant" });

  const state = ledger.checkBatchConservation("B-001");
  assert.equal(state.loadedTons, 5000);
  assert.equal(state.mineTons, 2000);
  assert.equal(state.inTransitTons, 1000);
  assert.equal(state.arrivedTons, 1500);
  assert.equal(state.returnedTons, 500);
  assert.ok(state.ok, "在途+到厂+退运+待发 = 装车量");

  // 未装车不得流转、超量不得流转
  const ledger2 = new BatchLedger();
  assert.throws(
    () => ledger2.record({ eventId: "X1", batchId: "B-X", stage: STAGES.ARRIVE, tons: 1, occurredAt: "2026-07-18T08:00:00Z", confirmerRole: "电厂" }),
    /CONSERVATION_VIOLATION/,
  );
});

// §6 幂等
test("同一事件重复报送只入账一次", () => {
  const ledger = new BatchLedger();
  const payload = {
    eventId: "DUP-1",
    batchId: "B-DUP",
    stage: STAGES.LOAD,
    tons: 1000,
    occurredAt: "2026-07-18T08:00:00Z",
    confirmerRole: "矿区",
  };
  assert.equal(ledger.record(payload).duplicate, false);
  const again = ledger.record({ ...payload, occurredAt: "2026-07-18T09:00:00Z" });
  assert.equal(again.duplicate, true);
  assert.equal(ledger.checkBatchConservation("B-DUP").loadedTons, 1000);
});

// §6 跨时区晚到数据
test("业务日期按源时区换算到 UTC 日历日", () => {
  // 东八区 7/18 凌晨 02:00 == UTC 7/17 18:00，业务日为 7/17
  assert.equal(businessDate("2026-07-17T18:00:00Z", "+08:00"), "2026-07-18");
  // 西五区 7/18 凌晨 04:00 的源时钟 == UTC 7/18 09:00，业务日为 7/18
  assert.equal(businessDate("2026-07-18T09:00:00Z", "-05:00"), "2026-07-18");
  assert.throws(() => businessDate("not-a-date", "+08:00"), /BAD_INSTANT/);
});

test("迟到数据不得回溯冻结区间，只调整业务日之后", async () => {
  const plan = await loadPlan();
  assert.throws(
    () =>
      applyLateStockReport(plan, {
        plantId: "PLT-A",
        occurredAt: "2026-07-15T17:00:00Z",
        sourceTimeZone: "+08:00", // 东八区 7/16 01:00，业务日落入冻结区间
        stockTons: 1,
      }),
    /LATE_DATA_IN_FROZEN_ZONE/,
  );
  const result = applyLateStockReport(plan, {
    plantId: "PLT-A",
    occurredAt: "2026-07-18T01:30:00Z",
    sourceTimeZone: "+08:00", // UTC 7/18 01:30 → 东八区 7/18 09:30，业务日 7/18
    stockTons: 33000,
  });
  assert.equal(result.adjustsFrom, "2026-07-18");
  assert.equal(result.report.sourceTimeZone, "+08:00");
});

// §7 双人批准
test("重大改序需两名不同人员批准", () => {
  assert.throws(
    () => assertReSequencingApproval({ major: true, proposer: "张三", approver: "张三" }),
    /DUAL_APPROVAL_REQUIRED/,
  );
  assert.throws(
    () => assertReSequencingApproval({ major: true, proposer: "张三", approver: "" }),
    /DUAL_APPROVAL_REQUIRED/,
  );
  assert.doesNotThrow(() =>
    assertReSequencingApproval({ major: true, proposer: "张三", approver: "李四" }),
  );
  assert.equal(assertReSequencingApproval({ major: false }).required, false);
});

// §7 指令追加日志与重启恢复
test("指令日志重放后恢复状态，非法迁移被拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "instr-"));
  const logPath = join(dir, "instructions.log");
  try {
    const store = new InstructionStore(logPath);
    await store.recover();
    await store.create({ instructionId: "INS-1", summary: "A区紧急补运", tons: 5000, major: true, proposer: "张三", approver: "李四" });
    await store.transition("INS-1", "issued", "调度员甲");
    await store.transition("INS-1", "acknowledged", "矿区值班");
    // 重启：新建实例并重放日志
    const restarted = new InstructionStore(logPath);
    await restarted.recover();
    assert.equal(restarted.get("INS-1").status, "acknowledged");
    assert.equal(restarted.pending().length, 1);
    await restarted.transition("INS-1", "executing", "铁路值班");
    await restarted.transition("INS-1", "completed", "电厂值班");
    assert.equal(restarted.pending().length, 0);

    const again = new InstructionStore(logPath);
    await again.recover();
    assert.equal(again.get("INS-1").status, "completed");
    assert.equal(again.get("INS-1").history.length, 5, "拟令+四次迁移全部可追溯");
    assert.equal(again.get("INS-1").approvals.proposer, "张三");
    await assert.rejects(() => again.transition("INS-1", "issued", "x"), /ILLEGAL_TRANSITION/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// §8 值班员视图
test("值班员视图汇总缺口、替代与被挤占订单", async () => {
  const plan = await loadPlan();
  const { plan: tilted } = recordPriorityDecision(plan, {
    date: "2026-07-18",
    plantId: "PLT-A",
    emergencyOrderId: "ORD-2204",
    preemptedOrderIds: ["ORD-2201", "ORD-2202"],
    thresholdDays: 7,
    reason: "保民生",
    seq: 2,
  });
  const view = dutyView(tilted);
  assert.ok(view.gaps.some((g) => g.gap.plantId === "PLT-A"));
  assert.ok(view.alternatives.some((a) => a.region === "华东网-A区" && a.reallocatableTons === 6000));
  assert.deepEqual(
    view.preemptedOrders.map((o) => o.orderId).sort(),
    ["ORD-2201", "ORD-2202"],
  );
});
