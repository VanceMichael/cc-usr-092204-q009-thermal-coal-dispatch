# 电煤库存联动调度

本项目服务于联结煤矿、电厂库存和铁路运力的保障计划。仓库保存领域资料、交换契约、核心调度规则与可运行的服务入口，便于参与方在同一语义下协作。

## 领域事实

- 铁路加大主产区煤炭外运力度
- 电煤运输强调应装尽装
- 直供电厂存煤保持较高水平
- 高位库存下，局部线路检修、煤矿减产或连续高温仍可能让区域迅速跌破安全天数
- 同一批煤在装车、在途、到厂和退运之间数量守恒

## 规则与实现

完整需求与不变量见 [`docs/requirements.md`](docs/requirements.md)，核心代码与文档章节一一对应：

| 规则 | 实现 |
| --- | --- |
| 安全天数投影、缺口与三重能力约束（§3） | `firstGap` / `projectInventory` / `feasibleAlternatives` |
| 预测修订只影响未执行区间（§2） | `revisePlan`（`frozenThrough` 冻结） |
| 紧急倾斜记录触发阈值与被挤占订单（§4） | `recordPriorityDecision` / `explainPriority` |
| 批次数量守恒（§5） | `BatchLedger` |
| 幂等报送、跨时区迟到数据（§6） | 事件 `eventId` 去重 / `businessDate` / `applyLateStockReport` |
| 三方分段确认（§1） | `assertConfirmer` |
| 重大改序双人批准（§7） | `assertReSequencingApproval` |
| 指令重启恢复（§7） | `src/instruction-store.js` 追加日志 + 重放 |
| 值班员/审计视图（§8） | `dutyView` / `explainPriority`，HTTP `/duty-view` |

## 目录说明

- `docs/requirements.md`：需求与不变量。
- `contracts/`：交换数据的结构约定（滚动计划、物流事件、倾斜决策、调度指令）。
- `fixtures/`：去标识的领域样例（`context.json`、`rolling-plan.json`）。
- `src/dispatch.js`：调度核心规则；`src/instruction-store.js`：指令持久化与恢复；`src/server.js`：服务入口。
- `test/`：核对领域资料载入与全部调度规则。

## 本地检查

```bash
npm test
node src/server.js   # /health /context /plan /duty-view
```
