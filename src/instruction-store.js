// 调度指令追加日志：每次状态迁移落一条记录，重启后重放恢复（需求 §7）。
//
// 状态机：draft（拟令）→ issued（已下达）→ acknowledged（已确认）
//         → executing（执行中）→ completed（已完成）
// 任意非终态可 → cancelled（已取消）。

import { appendFile, readFile, access } from "node:fs/promises";

const TERMINAL = new Set(["completed", "cancelled"]);

const FLOW = Object.freeze({
  draft: ["issued", "cancelled"],
  issued: ["acknowledged", "cancelled"],
  acknowledged: ["executing", "cancelled"],
  executing: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
});

export class InstructionStore {
  constructor(logPath) {
    this.logPath = logPath;
    this.instructions = new Map();
  }

  // 重放追加日志，重建全部指令状态。
  async recover() {
    this.instructions.clear();
    try {
      await access(this.logPath);
    } catch {
      return this; // 首次运行，日志尚不存在
    }
    const text = await readFile(this.logPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      this.#apply(entry);
    }
    return this;
  }

  async create({ instructionId, summary, tons, major, proposer, approver }) {
    if (this.instructions.has(instructionId)) {
      throw new Error(`INSTRUCTION_EXISTS:${instructionId}`);
    }
    await this.#append({
      type: "create",
      at: new Date().toISOString(),
      instructionId,
      summary,
      tons,
      major: major ?? false,
      approvals: major ? { proposer, approver } : null,
    });
    return this.instructions.get(instructionId);
  }

  async transition(instructionId, toStatus, actor, note = "") {
    const current = this.instructions.get(instructionId);
    if (!current) throw new Error(`INSTRUCTION_NOT_FOUND:${instructionId}`);
    if (!FLOW[current.status].includes(toStatus)) {
      const err = new Error(
        `ILLEGAL_TRANSITION:${instructionId} ${current.status} → ${toStatus}`,
      );
      err.code = "ILLEGAL_TRANSITION";
      throw err;
    }
    await this.#append({
      type: "transition",
      at: new Date().toISOString(),
      instructionId,
      fromStatus: current.status,
      toStatus,
      actor,
      note,
    });
    return this.instructions.get(instructionId);
  }

  // 重启后需要继续推进的未完成指令。
  pending() {
    return [...this.instructions.values()].filter((i) => !TERMINAL.has(i.status));
  }

  get(instructionId) {
    return this.instructions.get(instructionId);
  }

  #apply(entry) {
    if (entry.type === "create") {
      this.instructions.set(entry.instructionId, {
        instructionId: entry.instructionId,
        summary: entry.summary,
        tons: entry.tons,
        major: entry.major,
        approvals: entry.approvals,
        status: "draft",
        history: [{ at: entry.at, status: "draft" }],
      });
      return;
    }
    const ins = this.instructions.get(entry.instructionId);
    ins.status = entry.toStatus;
    ins.history.push({
      at: entry.at,
      status: entry.toStatus,
      actor: entry.actor,
      note: entry.note,
    });
  }

  async #append(entry) {
    // 先持久化，再改内存状态，保证重启后日志与状态一致。
    await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
    this.#apply(entry);
  }
}
