/**
 * reply-dispatcher 编排态集成测试（子代理任务卡）
 *
 * 覆盖 Task 6 引入的行为：sessionKey 提供后启用任务卡注册表联动——
 * 卡片创建成功后 bind 注册表；编排态下 final/block/partial 改写结果区而不
 * finishAICard/密封；onIdle/onError 在 keep-open 时不收口；onDispatchIdle
 * 返回 not-orchestrating 时按原路径收口并 release 注册表记录；未传 sessionKey
 * 时行为与旧版本完全一致（向后兼容）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const mockRegistry = vi.hoisted(() => ({
  bind: vi.fn(),
  markOrchestrating: vi.fn(),
  isOrchestrating: vi.fn(() => false),
  applyPlan: vi.fn(),
  onChildSpawned: vi.fn(),
  onChildEnded: vi.fn(),
  setAnswer: vi.fn(async () => {}),
  interceptOutboundText: vi.fn(async () => ({ handled: false })),
  onDispatchIdle: vi.fn(() => "not-orchestrating"),
  release: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../../src/services/task-card.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/task-card.ts")>();
  return { ...actual, taskCardRegistry: mockRegistry };
});

const CARD = {
  cardInstanceId: "card-1",
  accessToken: "tk",
  inputingStarted: false,
};

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
    sessionKey: "agent:main:dingtalk-connector:dm:user-1",
    ...overrides,
  } as any);
  const args = (globalThis as any).__dispatcherArgs;
  return { result, args };
}

describe("reply-dispatcher task card integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveDingtalkAccount.mockReturnValue({
      accountId: "acc-1",
      config: { debug: false, streaming: true },
    });
    mockGetOapiAccessToken.mockResolvedValue(null);
    mockProcessLocalImages.mockImplementation(async (s: string) => s);
    mockCreateAICardForTarget.mockResolvedValue(CARD);
    mockStreamAICard.mockResolvedValue(undefined);
    mockFinishAICard.mockResolvedValue(undefined);
    mockSendMessage.mockResolvedValue({ ok: true });
    mockSendTextMessage.mockResolvedValue({ ok: true });
    mockSendMarkdownMessage.mockResolvedValue({ ok: true });
    mockIsQpsLimitError.mockReturnValue(false);
    mockRegistry.isOrchestrating.mockReturnValue(false);
    mockRegistry.onDispatchIdle.mockReturnValue("not-orchestrating");
    mockRegistry.interceptOutboundText.mockResolvedValue({ handled: false });
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

  it("卡片创建成功后 bind 注册表 —— hook 事件才能找到这张卡", async () => {
    const { args } = await makeDispatcher();
    await args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalled());
    expect(mockRegistry.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:dingtalk-connector:dm:user-1",
        card: CARD,
        target: { type: "user", userId: "user-1" },
      }),
    );
  });

  it("编排态下 final 只写结果区，不 finishAICard、不密封 —— 第 1 轮 yield 后卡片保持打开", async () => {
    mockRegistry.isOrchestrating.mockReturnValue(true);
    const { args } = await makeDispatcher();
    await args.onReplyStart();
    await args.deliver({ text: "我先拆解任务" }, { kind: "final" });
    expect(mockRegistry.setAnswer).toHaveBeenCalledWith(
      "agent:main:dingtalk-connector:dm:user-1",
      "我先拆解任务",
    );
    expect(mockFinishAICard).not.toHaveBeenCalled();
    // 未密封：后续 block 仍走卡片路径而非降级普通消息
    await args.deliver({ text: "后续块" }, { kind: "block" });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("编排态下 onIdle keep-open 时不 closeStreaming —— announce 轮还会回来写卡", async () => {
    mockRegistry.isOrchestrating.mockReturnValue(true);
    mockRegistry.onDispatchIdle.mockReturnValue("keep-open");
    const { args } = await makeDispatcher();
    await args.onReplyStart();
    await args.onIdle();
    expect(mockFinishAICard).not.toHaveBeenCalled();
  });

  it("onDispatchIdle 返回 not-orchestrating 时正常收尾 —— spawn 被拒不留悬空卡", async () => {
    mockRegistry.onDispatchIdle.mockReturnValue("not-orchestrating");
    const { args } = await makeDispatcher();
    await args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalled());
    await args.onIdle();
    expect(mockFinishAICard).toHaveBeenCalled();
    expect(mockRegistry.release).toHaveBeenCalledWith("agent:main:dingtalk-connector:dm:user-1");
  });

  it("编排态下 partial 与 block 都改写结果区而非覆盖整卡 —— todo 区不被破坏", async () => {
    mockRegistry.isOrchestrating.mockReturnValue(true);
    const { result, args } = await makeDispatcher();
    await args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalled());
    await result.replyOptions.onPartialReply({ text: "叙述" });
    await args.deliver({ text: "块文本" }, { kind: "block" });
    expect(mockRegistry.setAnswer).toHaveBeenCalledWith(expect.any(String), "叙述");
    expect(mockRegistry.setAnswer).toHaveBeenCalledWith(expect.any(String), "块文本");
    expect(mockStreamAICard).not.toHaveBeenCalled();   // 原始覆盖式推送被绕过
  });

  it("未传 sessionKey（旧调用方）时行为与 0.8.25 完全一致 —— 向后兼容", async () => {
    const { args } = await makeDispatcher({ sessionKey: undefined });
    await args.onReplyStart();
    await vi.waitFor(() => expect(mockCreateAICardForTarget).toHaveBeenCalled());
    await args.deliver({ text: "答案" }, { kind: "final" });
    expect(mockFinishAICard).toHaveBeenCalled();
    expect(mockRegistry.bind).not.toHaveBeenCalled();
  });
});
