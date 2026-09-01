import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStreamAICard = vi.hoisted(() => vi.fn(async () => {}));
const mockFinishAICard = vi.hoisted(() => vi.fn(async () => {}));
const mockSendTextToDingTalk = vi.hoisted(() => vi.fn(async () => ({ ok: true, processQueryKey: "pq-1" })));

vi.mock("../../src/services/messaging/card.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/messaging/card.ts")>();
  return { ...actual, streamAICard: mockStreamAICard, finishAICard: mockFinishAICard };
});
vi.mock("../../src/services/messaging.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/messaging.ts")>();
  return { ...actual, sendTextToDingTalk: mockSendTextToDingTalk };
});

const CARD = { cardInstanceId: "card-1", accessToken: "tk", tokenExpireTime: 0, inputingStarted: true };
const KEY = "agent:main:dingtalk-connector:dm:u1";
const CFG = { channels: { "dingtalk-connector": { clientId: "id", clientSecret: "sec" } } } as any;
// CFG 未配置 accounts/defaultAccount，resolveDingtalkAccount 解析出的就是这个默认账号 id
const ACC = "__default__";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("outbound sendText 任务卡命中", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { taskCardRegistry } = await import("../../src/services/task-card.ts");
    taskCardRegistry.reset();
  });

  it("编排态命中：文本写入任务卡，不调 sendTextToDingTalk，messageId 为卡片 id —— 一指令一卡片", async () => {
    const { taskCardRegistry } = await import("../../src/services/task-card.ts");
    const { dingtalkPlugin } = await import("../../src/channel.ts");
    taskCardRegistry.bind({ sessionKey: KEY, accountId: ACC, target: { type: "user", userId: "u1" }, card: CARD as never, config: {} });
    taskCardRegistry.markOrchestrating(KEY);
    taskCardRegistry.onChildSpawned(KEY, "child-1", "任务A");
    const result = await dingtalkPlugin.outbound!.sendText!({ cfg: CFG, to: "u1", text: "阶段结论" } as never);
    expect(mockSendTextToDingTalk).not.toHaveBeenCalled();
    expect(result).toMatchObject({ messageId: "card-1", conversationId: "u1" });
  });

  it("全部子代理完成后的出站文本触发 finish —— 最终答案落在同一张卡并收尾", async () => {
    const { taskCardRegistry, OUTBOUND_CHUNK_WINDOW_MS } = await import("../../src/services/task-card.ts");
    const { dingtalkPlugin } = await import("../../src/channel.ts");
    taskCardRegistry.bind({ sessionKey: KEY, accountId: ACC, target: { type: "user", userId: "u1" }, card: CARD as never, config: {} });
    taskCardRegistry.markOrchestrating(KEY);
    taskCardRegistry.onChildSpawned(KEY, "child-1", "任务A");
    taskCardRegistry.onChildEnded("child-1", "ok");
    await dingtalkPlugin.outbound!.sendText!({ cfg: CFG, to: "u1", text: "最终答案" } as never);
    // 出站文本可能被 openclaw 按 textChunkLimit 切成多段，收尾要等分片窗口关闭
    await vi.waitFor(() => expect(mockFinishAICard).toHaveBeenCalledTimes(1), {
      timeout: OUTBOUND_CHUNK_WINDOW_MS + 2000,
      interval: 25,
    });
    expect(mockFinishAICard.mock.calls[0][1]).toContain("最终答案");
  });

  it("被切成两段的长答案合并进同一张卡且只 finish 一次 —— 分片不得互相覆盖或新开卡", async () => {
    const { taskCardRegistry, OUTBOUND_CHUNK_WINDOW_MS } = await import("../../src/services/task-card.ts");
    const { dingtalkPlugin } = await import("../../src/channel.ts");
    taskCardRegistry.bind({ sessionKey: KEY, accountId: ACC, target: { type: "user", userId: "u1" }, card: CARD as never, config: {} });
    taskCardRegistry.markOrchestrating(KEY);
    taskCardRegistry.onChildSpawned(KEY, "child-1", "任务A");
    taskCardRegistry.onChildEnded("child-1", "ok");
    await dingtalkPlugin.outbound!.sendText!({ cfg: CFG, to: "u1", text: "第一段内容" } as never);
    await sleep(100);
    await dingtalkPlugin.outbound!.sendText!({ cfg: CFG, to: "u1", text: "第二段内容" } as never);
    await vi.waitFor(() => expect(mockFinishAICard).toHaveBeenCalledTimes(1), {
      timeout: OUTBOUND_CHUNK_WINDOW_MS + 2000,
      interval: 25,
    });
    const md = mockFinishAICard.mock.calls[0][1] as string;
    expect(md).toContain("第一段内容");
    expect(md).toContain("第二段内容");
    expect(md.indexOf("第一段内容")).toBeLessThan(md.indexOf("第二段内容"));
    expect(mockSendTextToDingTalk).not.toHaveBeenCalled();
  });

  it("未命中（无编排记录）时走原有 sendTextToDingTalk —— 回归保障", async () => {
    const { dingtalkPlugin } = await import("../../src/channel.ts");
    await dingtalkPlugin.outbound!.sendText!({ cfg: CFG, to: "u1", text: "hi" } as never);
    expect(mockSendTextToDingTalk).toHaveBeenCalledTimes(1);
  });
});
