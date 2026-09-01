import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTaskCardRegistry,
  DEFAULT_TASK_WATCHDOG_MS,
  type TaskCardRegistry,
} from "../../src/services/task-card.ts";

const CARD = { cardInstanceId: "card-1", accessToken: "tk", tokenExpireTime: 0, inputingStarted: true };
const CFG = { taskCard: {} } as any;
const KEY = "agent:main:dingtalk-connector:dm:u1";
const TARGET = { type: "user", userId: "u1" } as const;
const ACC = "acc-1";

function make() {
  const streamAICard = vi.fn().mockResolvedValue(undefined);
  const finishAICard = vi.fn().mockResolvedValue(undefined);
  const registry: TaskCardRegistry = createTaskCardRegistry({ streamAICard, finishAICard });
  return { registry, streamAICard, finishAICard };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TaskCardRegistry", () => {
  it("编排态下 setAnswer('') 不触发 finish —— 第 1 轮 yield 后卡片必须保持打开", async () => {
    const { registry, finishAICard } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    await registry.setAnswer(KEY, "");
    expect(finishAICard).not.toHaveBeenCalled();
    expect(registry.isOrchestrating(KEY)).toBe(true);
  });

  it("applyPlan 按 step 文本保留 childKey 绑定 —— 重规划不丢子代理关联", async () => {
    const { registry, streamAICard } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.applyPlan(KEY, [{ step: "A", status: "in_progress" }]);
    registry.onChildSpawned(KEY, "child-1", "A");
    registry.applyPlan(KEY, [
      { step: "A", status: "in_progress" },
      { step: "B", status: "pending" },
    ]);
    // childKey 仍绑定：child-1 结束时 A 被标记 completed
    registry.onChildEnded("child-1", "ok");
    // 通过渲染结果断言（不暴露内部 state）：A 已完成，完成计数 1/2 出现在下一次推送内容里
    await vi.advanceTimersByTimeAsync(900);
    const md = streamAICard.mock.calls.at(-1)![1] as string;
    expect(md).toContain("✅ A");
    expect(md).toContain("（1/2）");
  });

  it("最终答案先到、最后一个子代理后到时，由 onChildEnded 主动 finish —— 事件乱序不悬空", async () => {
    const { registry, finishAICard } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    await registry.setAnswer(KEY, "最终答案");           // isComplete 仍为 false
    expect(finishAICard).not.toHaveBeenCalled();
    registry.onChildEnded("child-1", "ok");              // 此刻 isComplete 为 true
    await vi.runAllTimersAsync();
    expect(finishAICard).toHaveBeenCalledTimes(1);
    const md = finishAICard.mock.calls[0][1] as string;
    expect(md).toContain("✅ 任务A");
    expect(md).toContain("最终答案");
    expect(registry.isOrchestrating(KEY)).toBe(false);
  });

  it("outcome!=='ok' 只标 failed 不 finish —— 等主控收尾", async () => {
    const { registry, finishAICard } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    registry.onChildSpawned(KEY, "child-2", "任务B");
    registry.onChildEnded("child-1", "timeout");
    await vi.advanceTimersByTimeAsync(900);
    expect(finishAICard).not.toHaveBeenCalled();
  });

  it("看门狗到期 forceFinish 并追加提示 —— 不留永久转圈卡", async () => {
    const { registry, finishAICard } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    await vi.advanceTimersByTimeAsync(DEFAULT_TASK_WATCHDOG_MS + 1000);
    expect(finishAICard).toHaveBeenCalledTimes(1);
    expect(finishAICard.mock.calls[0][1]).toContain("任务未在预期时间内完成");
  });

  it("800ms 内多次变更只推送一次 —— QPS 限流保护", async () => {
    const { registry, streamAICard } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "c1", "A");
    registry.onChildSpawned(KEY, "c2", "B");
    registry.onChildSpawned(KEY, "c3", "C");
    await vi.advanceTimersByTimeAsync(900);
    expect(streamAICard.mock.calls.length).toBeLessThanOrEqual(2); // 首推 + 合并推各至多一次
  });

  it("spawn 被拒（无 spawned 子代理）时 onDispatchIdle 回退普通收尾 —— 协议先置 in_progress 再 spawn，仍不得留悬空卡", () => {
    const { registry } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    // 编排协议要求先把首个 step 标 in_progress 再调 sessions_spawn；spawn 被拒时
    // 计划表里仍留着这个 in_progress，但没有任何子代理会来收尾。
    registry.applyPlan(KEY, [{ step: "A", status: "in_progress" }, { step: "汇总结果", status: "pending" }]);
    expect(registry.onDispatchIdle(KEY)).toBe("not-orchestrating");
    expect(registry.isOrchestrating(KEY)).toBe(false);
  });

  it("有活跃子代理时 onDispatchIdle 返回 keep-open", () => {
    const { registry } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    expect(registry.onDispatchIdle(KEY)).toBe("keep-open");
  });

  it("interceptOutboundText 按归一化 target 命中并写入结果区；未完成时不 finish", async () => {
    const { registry, finishAICard, streamAICard } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    const r = await registry.interceptOutboundText({ accountId: ACC, to: "u1", text: "阶段结论" });
    expect(r).toEqual({ handled: true, cardInstanceId: "card-1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(streamAICard).toHaveBeenCalled();
    expect(finishAICard).not.toHaveBeenCalled();
    const miss = await registry.interceptOutboundText({ accountId: ACC, to: "user:other", text: "x" });
    expect(miss.handled).toBe(false);
  });

  it("release 只清除非编排态记录 —— 普通轮收尾不影响任务卡", () => {
    const { registry } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.release(KEY);
    expect(registry.isOrchestrating(KEY)).toBe(true);
  });

  it("计划里未绑定子代理的「汇总结果」不阻塞收尾 —— 否则卡片必然转到看门狗超时", async () => {
    const { registry, finishAICard } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.applyPlan(KEY, [
      { step: "任务A", status: "in_progress" },
      { step: "汇总结果", status: "pending" },      // 协议强制的一条，永远不会有子代理绑定它
    ]);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    registry.onChildEnded("child-1", "ok");
    await registry.setAnswer(KEY, "最终答案");
    await vi.runAllTimersAsync();
    expect(finishAICard).toHaveBeenCalledTimes(1);
    const md = finishAICard.mock.calls[0][1] as string;
    expect(md).toContain("✅ 任务A");
    expect(md).toContain("✅ 汇总结果");            // 收尾时未绑定的残留步骤补标完成
    expect(md).toContain("最终答案");
  });

  it("onChildEnded 缺省 outcome 视为成功 —— openclaw 正常结束事件不带 outcome 字段", async () => {
    const { registry, finishAICard } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    await registry.setAnswer(KEY, "最终答案");
    registry.onChildEnded("child-1");
    await vi.runAllTimersAsync();
    expect(finishAICard).toHaveBeenCalledTimes(1);
    expect(finishAICard.mock.calls[0][1]).toContain("✅ 任务A");
  });

  it("编排态下 bind 另一张卡被拒绝 —— 第二条用户消息不得劫持进行中的任务卡", () => {
    const { registry } = make();
    expect(registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG })).toBe(true);
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    const CARD_B = { ...CARD, cardInstanceId: "card-2" };
    expect(registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD_B, config: CFG })).toBe(false);
    // 记录仍指向 A：出站命中返回的仍是 card-1
    expect(registry.isOrchestrating(KEY)).toBe(true);
  });

  it("markOrchestrating 早于 bind（卡片尚未绑定）时 bind 仍被接受 —— 卡片创建在途的正常时序", () => {
    const { registry } = make();
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    expect(registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG })).toBe(true);
  });

  it("同一张卡重复 bind 被接受（幂等）—— preCreatedCard 复用路径", () => {
    const { registry } = make();
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.markOrchestrating(KEY);
    expect(registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG })).toBe(true);
  });

  it("markOrchestrating 早于 bind（卡片创建在途）也能工作，bind 合并后可正常渲染", async () => {
    const { registry, streamAICard } = make();
    registry.markOrchestrating(KEY);
    registry.onChildSpawned(KEY, "child-1", "任务A");
    registry.bind({ sessionKey: KEY, accountId: ACC, target: TARGET, card: CARD, config: CFG });
    registry.onChildSpawned(KEY, "child-2", "任务B");
    await vi.advanceTimersByTimeAsync(900);
    expect(streamAICard).toHaveBeenCalled();
    expect(registry.isOrchestrating(KEY)).toBe(true);
  });
});
