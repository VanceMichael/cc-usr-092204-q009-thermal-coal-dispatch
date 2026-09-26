// 电煤库存联动调度核心领域规则。
// 规则出处见 docs/requirements.md，各函数与文档章节对应。

export const STAGES = Object.freeze({
  LOAD: "LOAD", // 装车（矿区）
  IN_TRANSIT: "IN_TRANSIT", // 在途（铁路）
  ARRIVE: "ARRIVE", // 到厂（电厂）
  RETURN: "RETURN", // 退运
});

// 各环节唯一有权确认的角色（需求 §1）。
const STAGE_CONFIRMER = Object.freeze({
  LOAD: "矿区",
  IN_TRANSIT: "铁路",
  ARRIVE: "电厂",
});

export function assertConfirmer(stage, confirmerRole, fromStage) {
  const required =
    stage === STAGES.RETURN
      ? fromStage === "plant"
        ? "电厂"
        : "铁路"
      : STAGE_CONFIRMER[stage];
  if (!required || confirmerRole !== required) {
    const err = new Error(`CONFIRMER_ROLE_MISMATCH:${stage} 需由 ${required} 确认`);
    err.code = "CONFIRMER_ROLE_MISMATCH";
    throw err;
  }
}

// --- 高温折算与库存投影（需求 §3） -----------------------------------------

// 温度区间 → 日耗系数，取第一个满足 tempC >= above 的区间。
export function heatFactorForTemp(tempC, bands) {
  for (const band of bands) {
    if (tempC >= band.above) return band.factor;
  }
  return 1;
}

// 吨数按整数规整，避免高温系数相乘产生浮点尾数。
export const roundTons = (n) => Math.round(n);

export function heatAdjustedBurn(baseDailyBurnTons, heatFactor) {
  return roundTons(baseDailyBurnTons * heatFactor);
}

// 逐日推演：库存 = 前日库存 − 折算日耗 + 当日到货。
export function projectInventory(plant) {
  let stock = plant.stockTons;
  return plant.daily.map((day) => {
    const burn = heatAdjustedBurn(plant.baseDailyBurnTons, day.heatFactor ?? 1);
    const stockBefore = stock;
    stock = roundTons(stock + (day.arrivalTons ?? 0) - burn);
    return {
      date: day.date,
      tempC: day.tempC ?? null,
      heatFactor: day.heatFactor ?? 1,
      burnTons: burn,
      arrivalTons: day.arrivalTons ?? 0,
      stockBeforeTons: stockBefore,
      stockAfterTons: stock,
      safetyRequirementTons: burn * plant.safetyDays,
    };
  });
}

// 最早跌破安全天数的日期与缺口量；无缺口返回 null。
export function firstGap(plant) {
  for (const day of projectInventory(plant)) {
    if (day.stockAfterTons < day.safetyRequirementTons) {
      return {
        plantId: plant.plantId,
        date: day.date,
        projectedStockTons: day.stockAfterTons,
        burnTons: day.burnTons,
        safetyDays: plant.safetyDays,
        safetyRequirementTons: day.safetyRequirementTons,
        gapTons: day.safetyRequirementTons - day.stockAfterTons,
      };
    }
  }
  return null;
}

// 可再安排量受煤矿可装、线路能力、车底周转三重约束（需求 §2/§3）。
export function feasibleAlternatives(capacities) {
  return capacities.map((c) => {
    const ceiling = Math.min(
      c.mineLoadableTons,
      c.lineCapacityTons,
      c.railcarTurnoverTons,
    );
    return {
      region: c.region,
      date: c.date,
      capacityCeilingTons: ceiling,
      committedTons: c.committedTons,
      reallocatableTons: Math.max(0, ceiling - c.committedTons),
    };
  });
}

// --- 滚动计划修订：只允许触及未执行区间（需求 §2） ---------------------------

// dateOverrides: { "YYYY-MM-DD": { plantId: { arrivalTons?, heatFactor?, tempC? } } }
export function revisePlan(plan, dateOverrides, revisedAt = new Date().toISOString()) {
  for (const date of Object.keys(dateOverrides)) {
    if (date <= plan.frozenThrough) {
      const err = new Error(`REVISION_FROZEN:${date} 已在冻结区间（截至 ${plan.frozenThrough}）`);
      err.code = "REVISION_FROZEN";
      throw err;
    }
  }
  const next = structuredClone(plan);
  for (const [date, byPlant] of Object.entries(dateOverrides)) {
    for (const [plantId, patch] of Object.entries(byPlant)) {
      const plant = next.plants.find((p) => p.plantId === plantId);
      const day = plant?.daily.find((d) => d.date === date);
      if (!day) {
        const err = new Error(`REVISION_TARGET_NOT_FOUND:${plantId}@${date}`);
        err.code = "REVISION_TARGET_NOT_FOUND";
        throw err;
      }
      Object.assign(day, patch);
    }
  }
  next.version = (plan.version ?? 1) + 1;
  next.revisions = [
    ...(plan.revisions ?? []),
    { at: revisedAt, dates: Object.keys(dateOverrides).sort() },
  ];
  return next;
}

// --- 紧急倾斜（需求 §4） ----------------------------------------------------

// recordPriorityDecision：校验阈值确已触发、缺口证据齐全，登记被挤占订单。
// 返回 { plan, decision }；plan 为更新后的副本。
export function recordPriorityDecision(
  plan,
  { date, plantId, emergencyOrderId, preemptedOrderIds, thresholdDays, reason, seq },
) {
  const plant = plan.plants.find((p) => p.plantId === plantId);
  if (!plant) throw new Error(`PLANT_NOT_FOUND:${plantId}`);

  const gap = firstGap(plant);
  if (!gap) {
    const err = new Error("PRIORITY_WITHOUT_GAP:不存在缺口，不得发起紧急倾斜");
    err.code = "PRIORITY_WITHOUT_GAP";
    throw err;
  }

  const firstDay = projectInventory(plant)[0];
  const currentSafetyDays = firstDay.stockBeforeTons / firstDay.burnTons;
  if (!(currentSafetyDays < thresholdDays)) {
    const err = new Error(
      `THRESHOLD_NOT_MET:当前安全天数 ${currentSafetyDays.toFixed(2)} ≥ 阈值 ${thresholdDays}`,
    );
    err.code = "THRESHOLD_NOT_MET";
    throw err;
  }
  if (!reason || !reason.trim()) {
    const err = new Error("PRIORITY_REASON_REQUIRED");
    err.code = "PRIORITY_REASON_REQUIRED";
    throw err;
  }

  const next = structuredClone(plan);
  const preempted = [];
  for (const orderId of preemptedOrderIds ?? []) {
    const order = next.orders.find((o) => o.orderId === orderId);
    if (!order) throw new Error(`ORDER_NOT_FOUND:${orderId}`);
    if (order.status !== "committed") {
      throw new Error(`ORDER_NOT_COMMITTED:${orderId}（${order.status}）`);
    }
    order.status = "preempted";
    preempted.push({ orderId, tons: order.tons });
  }

  const emergencyOrder = next.orders.find((o) => o.orderId === emergencyOrderId);
  if (!emergencyOrder) throw new Error(`ORDER_NOT_FOUND:${emergencyOrderId}`);
  emergencyOrder.status = "prioritized";

  const decision = {
    decisionId: `PD-${date.replaceAll("-", "")}-${String(seq).padStart(3, "0")}`,
    date,
    plantId,
    emergencyOrderId,
    trigger: {
      thresholdDays,
      currentSafetyDays: Number(currentSafetyDays.toFixed(3)),
      firstGapDate: gap.date,
      gapTons: gap.gapTons,
    },
    preemptedOrders: preempted,
    reason,
  };
  next.priorityDecisions = [...(plan.priorityDecisions ?? []), decision];
  return { plan: next, decision };
}

// 审计依据链：凭决策编号还原“为何优先保障”（需求 §8）。
export function explainPriority(plan, decisionId) {
  const decision = (plan.priorityDecisions ?? []).find((d) => d.decisionId === decisionId);
  if (!decision) throw new Error(`DECISION_NOT_FOUND:${decisionId}`);
  const plant = plan.plants.find((p) => p.plantId === decision.plantId);
  return {
    decision,
    plant: { plantId: plant.plantId, name: plant.name, safetyDays: plant.safetyDays },
    justification:
      `${decision.date} ${plant.name} 当前安全天数 ` +
      `${decision.trigger.currentSafetyDays} 天，低于触发阈值 ` +
      `${decision.trigger.thresholdDays} 天；首个缺口日 ${decision.trigger.firstGapDate} ` +
      `缺口 ${decision.trigger.gapTons} 吨。挤占订单 ${decision.preemptedOrders
        .map((o) => o.orderId)
        .join("、") || "无"}，理由：${decision.reason}。`,
  };
}

// --- 批次数量守恒台账（需求 §5） ---------------------------------------------

// 批次内每批煤在四个状态间流转，总量恒等：
// mine（已装待发）+ transit（在途）+ plant（到厂）+ returned（退运）= 累计装车量。
export class BatchLedger {
  #events = new Map();

  record(event) {
    if (this.#events.has(event.eventId)) {
      return { duplicate: true, eventId: event.eventId };
    }
    const stage = event.stage;
    if (!STAGES[stage]) throw new Error(`UNKNOWN_STAGE:${stage}`);
    if (!(Number(event.tons) > 0)) throw new Error("TONS_MUST_BE_POSITIVE");
    assertConfirmer(stage, event.confirmerRole, event.fromStage);

    const batch = (this[event.batchId] ??= {
      batchId: event.batchId,
      loaded: 0,
      mine: 0,
      transit: 0,
      plant: 0,
      returned: 0,
      events: [],
    });

    const tons = Number(event.tons);
    switch (stage) {
      case STAGES.LOAD:
        batch.loaded += tons;
        batch.mine += tons;
        break;
      case STAGES.IN_TRANSIT:
        if (batch.mine < tons) throw new Error("CONSERVATION_VIOLATION:待发量不足，不能发运");
        batch.mine -= tons;
        batch.transit += tons;
        break;
      case STAGES.ARRIVE:
        if (batch.transit < tons) throw new Error("CONSERVATION_VIOLATION:在途量不足，不能到厂");
        batch.transit -= tons;
        batch.plant += tons;
        break;
      case STAGES.RETURN: {
        const from = event.fromStage === "plant" ? "plant" : "transit";
        if (batch[from] < tons) throw new Error(`CONSERVATION_VIOLATION:${from} 余量不足，不能退运`);
        batch[from] -= tons;
        batch.returned += tons;
        break;
      }
    }

    const recorded = { ...event, businessDate: businessDate(event.occurredAt, event.sourceTimeZone) };
    batch.events.push(recorded);
    this.#events.set(event.eventId, recorded);
    return { duplicate: false, eventId: event.eventId, state: this.checkBatchConservation(event.batchId) };
  }

  checkBatchConservation(batchId) {
    const b = this[batchId];
    if (!b) throw new Error(`BATCH_NOT_FOUND:${batchId}`);
    const accounted = b.mine + b.transit + b.plant + b.returned;
    return {
      batchId,
      loadedTons: b.loaded,
      mineTons: b.mine,
      inTransitTons: b.transit,
      arrivedTons: b.plant,
      returnedTons: b.returned,
      accountedTons: accounted,
      ok: accounted === b.loaded,
    };
  }
}

// --- 幂等与跨时区晚到数据（需求 §6） -----------------------------------------

// 源时区接受 "+08:00" / "+0800" 形式的偏移；业务日期一律换算到 UTC 日历日。
export function businessDate(occurredAt, sourceTimeZone = "+00:00") {
  const instant = Date.parse(occurredAt);
  if (Number.isNaN(instant)) throw new Error(`BAD_INSTANT:${occurredAt}`);
  const m = String(sourceTimeZone).match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) throw new Error(`BAD_TIMEZONE_OFFSET:${sourceTimeZone}`);
  const shift = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
  return new Date(instant + shift).toISOString().slice(0, 10);
}

// 迟到库存报送：业务日期落入冻结区间则拒绝；否则只调整该日及之后的投影。
export function applyLateStockReport(
  plan,
  { plantId, occurredAt, sourceTimeZone, stockTons },
  receivedAt = new Date().toISOString(),
) {
  const date = businessDate(occurredAt, sourceTimeZone);
  if (date <= plan.frozenThrough) {
    const err = new Error(`LATE_DATA_IN_FROZEN_ZONE:${date} 已执行，不得回溯改写`);
    err.code = "LATE_DATA_IN_FROZEN_ZONE";
    throw err;
  }
  const next = structuredClone(plan);
  const plant = next.plants.find((p) => p.plantId === plantId);
  const day = plant?.daily.find((d) => d.date === date);
  if (!day) throw new Error(`REPORT_TARGET_NOT_FOUND:${plantId}@${date}`);
  day.reportedStockTons = stockTons;
  next.lateStockReports = [
    ...(plan.lateStockReports ?? []),
    { plantId, businessDate: date, stockTons, sourceTimeZone, receivedAt },
  ];
  return { plan: next, report: next.lateStockReports.at(-1), adjustsFrom: date };
}

// --- 重大人工改序双人批准（需求 §7） -----------------------------------------

export function assertReSequencingApproval({ major, proposer, approver }) {
  if (!major) return { required: false };
  if (!proposer || !approver || proposer === approver) {
    const err = new Error("DUAL_APPROVAL_REQUIRED:重大人工改序需两名不同人员批准");
    err.code = "DUAL_APPROVAL_REQUIRED";
    throw err;
  }
  return { required: true, proposer, approver };
}

// --- 值班员视图（需求 §8） --------------------------------------------------

export function dutyView(plan) {
  const plantGaps = plan.plants
    .map((p) => ({ plant: { plantId: p.plantId, name: p.name, region: p.region }, gap: firstGap(p) }))
    .filter((x) => x.gap !== null);
  return {
    generatedFor: plan.planId,
    gaps: plantGaps,
    alternatives: feasibleAlternatives(plan.capacities ?? []),
    preemptedOrders: (plan.orders ?? []).filter((o) => o.status === "preempted"),
  };
}
