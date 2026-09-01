/**
 * 编排态下的卡片归属保护（真实 TaskCardRegistry，不 mock）
 *
 * 覆盖两条跨组件缺陷：
 * 1. 任务卡编排进行中，用户又发一条消息 → 新一轮 dispatcher 创建的新卡不得
 *    顶替注册表里进行中的任务卡（否则旧卡永不收尾，新一轮输出还被写进旧卡）；
 * 2. 已存在编排态记录但本轮卡片创建失败（返回 null）→ 没有 bind 就没有任务卡
 *    模式，final 必须走原有的非流式发送，而不是被 setAnswer 吞掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateReplyDispatcherWithTyping = vi.hoisted(() => vi.fn());
const mockResolveDingtalkAccount = vi.hoisted(() => vi.fn());
const mockGetDingtalkRuntime = vi.hoisted(() => vi.fn());
const mockCreateAICardForTarget = vi.hoisted(() => vi.fn());
const mockStreamAICard = vi.hoisted(() => vi.fn());
const mockFinishAICard = vi.hoisted(() => vi.fn());
const mockIsQpsLimitError = vi.hoisted(() => vi.fn());
const mockSendMessage = vi.hoisted(() => vi.fn());
const mockSendTextMessage = vi.hoisted(() => vi.fn());
const mockSendMarkdownMessage = vi.hoisted(() => vi.fn());
const mockGetOapiAccessToken = vi.hoisted(() => vi.fn());
const mockProcessLocalImages = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  createReplyPrefixOptions: vi.fn(() => ({
    onModelSelected: vi.fn(),
  })),
  createTypingCallbacks: vi.fn(() => ({
    onActive: vi.fn(),
    onIdle: vi.fn(),
    onCleanup: vi.fn(),
  })),
  logTypingFailure: vi.fn(),
}));

vi.mock("../../src/config/accounts.ts", () => ({
  resolveDingtalkAccount: mockResolveDingtalkAccount,
}));

vi.mock("../../src/runtime.ts", () => ({
  getDingtalkRuntime: mockGetDingtalkRuntime,
}));

vi.mock("../../src/services/messaging/card.ts", () => ({
  createAICardForTarget: mockCreateAICardForTarget,
  streamAICard: mockStreamAICard,
  finishAICard: mockFinishAICard,
  isQpsLimitError: mockIsQpsLimitError,
}));

vi.mock("../../src/services/messaging.ts", () => ({
  sendMessage: mockSendMessage,
  sendTextMessage: mockSendTextMessage,
  sendMarkdownMessage: mockSendMarkdownMessage,
}));

vi.mock("../../src/services/media/image.ts", () => ({
  processLocalImages: mockProcessLocalImages,
}));

vi.mock("../../src/services/media/index.ts", () => ({
  processLocalImages: mockProcessLocalImages,
  processVideoMarkers: vi.fn(async (s: string) => s),
  processAudioMarkers: vi.fn(async (s: string) => s),
  uploadAndReplaceFileMarkers: vi.fn(async (s: string) => s),
}));

vi.mock("../../src/services/media/video.ts", () => ({
  processVideoMarkers: vi.fn(async (s: string) => s),
}));

vi.mock("../../src/services/media/audio.ts", () => ({
  processAudioMarkers: vi.fn(async (s: string) => s),
}));

vi.mock("../../src/services/media/file.ts", () => ({
  uploadAndReplaceFileMarkers: vi.fn(async (s: string) => s),
}));

vi.mock("../../src/services/media.ts", () => ({
  processRawMediaPaths: vi.fn(async (s: string) => s),
}));

vi.mock("../../src/utils/token.ts", () => ({
  getAccessToken: vi.fn(),
  getOapiAccessToken: mockGetOapiAccessToken,
}));

const CARD_A = { cardInstanceId: "card-1", accessToken: "tk", inputingStarted: false };
const CARD_B = { cardInstanceId: "card-2", accessToken: "tk", inputingStarted: false };
const KEY = "agent:main:dingtalk-connector:dm:user-1";

function makeRuntime() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

async function makeDispatcher(overrides: Record<string, unknown> = {}) {
  const { createDingtalkReplyDispatcher } = await import("../../src/reply-dispatcher");
  const result = createDingtalkReplyDispatcher({
    cfg: {} as any,
    agentId: "a1",
    runtime: makeRuntime() as any,
    conversationId: "conv-1",
    senderId: "user-1",
    isDirect: true,
    sessionWebhook: "http://webhook",
    sessionKey: KEY,
    ...overrides,
  } as any);
  const args = (globalThis as any).__dispatcherArgs;
  return { result, args };
}

async function registry() {
  return (await import("../../src/services/task-card.ts")).taskCardRegistry;
}

describe("reply-dispatcher × 真实任务卡注册表：卡片归属", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (await registry()).reset();
    mockResolveDingtalkAccount.mockReturnValue({
      accountId: "acc-1",
      config: { debug: false, streaming: true },
    });
    mockGetOapiAccessToken.mockResolvedValue(null);
    mockProcessLocalImages.mockImplementation(async (s: string) => s);
    mockCreateAICardForTarget.mockResolvedValue(CARD_A);
    mockStreamAICard.mockResolvedValue(undefined);
    mockFinishAICard.mockResolvedValue(undefined);
    mockSendMessage.mockResolvedValue({ ok: true });
    mockSendTextMessage.mockResolvedValue({ ok: true });
    mockSendMarkdownMessage.mockResolvedValue({ ok: true });
    mockIsQpsLimitError.mockReturnValue(false);
    mockCreateReplyDispatcherWithTyping.mockImplementation((args: any) => {
      (globalThis as any).__dispatcherArgs = args;
      return {
        dispatcher: {},
        replyOptions: {},
        markDispatchIdle: vi.fn(),
        markRunComplete: vi.fn(),
      };
    });
    mockGetDingtalkRuntime.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: () => 4000,
          resolveChunkMode: () => "markdown",
          chunkTextWithMode: (text: string) => [text],
        },
        reply: {
          resolveHumanDelayConfig: () => ({ enabled: false }),
          createReplyDispatcherWithTyping: mockCreateReplyDispatcherWithTyping,
        },
      },
    });
  });

  afterEach(async () => {
    (await registry()).reset();
  });

  it("编排进行中收到第二条用户消息：新一轮不进入任务卡模式，自己收口自己的卡，原任务卡记录不受影响", async () => {
    const reg = await registry();

    // 第 1 轮：创建卡片 A 并进入编排态（有在跑的子代理）
    const first = await makeDispatcher();
    await first.args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalledTimes(1));
    reg.markOrchestrating(KEY);
    reg.onChildSpawned(KEY, "child-1", "任务A");
    await first.args.onIdle();
    expect(mockFinishAICard).not.toHaveBeenCalled();          // A 保持打开

    // 第 2 轮：同一 session 的新消息，创建了卡片 B
    mockCreateAICardForTarget.mockResolvedValue(CARD_B);
    const second = await makeDispatcher();
    await second.args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalledTimes(2));
    await second.args.deliver({ text: "第二条消息的答案" }, { kind: "final" });

    // B 按普通卡片正常收口
    expect(mockFinishAICard).toHaveBeenCalledTimes(1);
    expect(mockFinishAICard.mock.calls[0][0]).toMatchObject({ cardInstanceId: "card-2" });
    expect(mockFinishAICard.mock.calls[0][1]).toContain("第二条消息的答案");

    // 注册表仍绑定 A：出站命中返回 card-1，且仍处于编排态
    expect(reg.isOrchestrating(KEY)).toBe(true);
    const hit = await reg.interceptOutboundText({ accountId: "acc-1", to: "user-1", text: "阶段结论" });
    expect(hit).toMatchObject({ handled: true, cardInstanceId: "card-1" });
  });

  it("已有编排态记录但本轮卡片创建失败：final 走原有非流式发送，不被任务卡吞掉", async () => {
    const reg = await registry();
    reg.markOrchestrating(KEY);                                // 记录存在但从未 bind 卡片
    mockCreateAICardForTarget.mockResolvedValue(null);

    const { args } = await makeDispatcher();
    await args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalled());
    await args.deliver({ text: "答案文本" }, { kind: "final" });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][2]).toBe("答案文本");
  });
});
