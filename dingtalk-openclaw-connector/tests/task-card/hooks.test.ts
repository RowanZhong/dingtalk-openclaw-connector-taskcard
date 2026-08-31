import { describe, expect, it, vi } from "vitest";
import { registerTaskCardHooks } from "../../src/task-card-hooks.ts";

const DT_KEY = "agent:main:dingtalk-connector:dm:u1";
const OTHER_KEY = "agent:main:telegram:dm:u1";

function makeApi() {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  return {
    handlers,
    api: {
      on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(name, handler),
      logger: { warn: vi.fn() },
    },
  };
}

function makeRegistry() {
  return {
    bind: vi.fn(), markOrchestrating: vi.fn(), isOrchestrating: vi.fn(),
    applyPlan: vi.fn(), onChildSpawned: vi.fn(), onChildEnded: vi.fn(),
    setAnswer: vi.fn(), interceptOutboundText: vi.fn(), onDispatchIdle: vi.fn(),
    release: vi.fn(), reset: vi.fn(),
  };
}

describe("registerTaskCardHooks", () => {
  it("sessions_spawn → markOrchestrating，且只处理钉钉会话 —— 其他渠道的运行不得污染注册表", () => {
    const { handlers, api } = makeApi();
    const registry = makeRegistry();
    registerTaskCardHooks(api, registry as never);
    handlers.get("before_tool_call")!({ toolName: "sessions_spawn", params: {} }, { sessionKey: DT_KEY });
    handlers.get("before_tool_call")!({ toolName: "sessions_spawn", params: {} }, { sessionKey: OTHER_KEY });
    handlers.get("before_tool_call")!({ toolName: "exec", params: {} }, { sessionKey: DT_KEY });
    expect(registry.markOrchestrating).toHaveBeenCalledTimes(1);
    expect(registry.markOrchestrating).toHaveBeenCalledWith(DT_KEY);
  });

  it("update_plan 成功 → applyPlan；带 error 的调用被忽略 —— 不用坏数据覆盖状态", () => {
    const { handlers, api } = makeApi();
    const registry = makeRegistry();
    registerTaskCardHooks(api, registry as never);
    const plan = [{ step: "A", status: "in_progress" }];
    handlers.get("after_tool_call")!({ toolName: "update_plan", params: { plan } }, { sessionKey: DT_KEY });
    handlers.get("after_tool_call")!({ toolName: "update_plan", params: { plan }, error: "boom" }, { sessionKey: DT_KEY });
    expect(registry.applyPlan).toHaveBeenCalledTimes(1);
    expect(registry.applyPlan).toHaveBeenCalledWith(DT_KEY, plan);
  });

  it("subagent_spawned 用 ctx.requesterSessionKey 定位；subagent_ended 全局按 childKey 转发", () => {
    const { handlers, api } = makeApi();
    const registry = makeRegistry();
    registerTaskCardHooks(api, registry as never);
    handlers.get("subagent_spawned")!({ childSessionKey: "child-1", label: "任务A" }, { requesterSessionKey: DT_KEY });
    handlers.get("subagent_spawned")!({ childSessionKey: "child-2", label: "X" }, { requesterSessionKey: OTHER_KEY });
    handlers.get("subagent_ended")!({ targetSessionKey: "child-1", outcome: "ok" });
    expect(registry.onChildSpawned).toHaveBeenCalledTimes(1);
    expect(registry.onChildSpawned).toHaveBeenCalledWith(DT_KEY, "child-1", "任务A");
    expect(registry.onChildEnded).toHaveBeenCalledWith("child-1", "ok");
  });

  it("api.on 不存在时告警并跳过 —— 旧版 SDK 下插件仍可加载", () => {
    const registry = makeRegistry();
    const logger = { warn: vi.fn() };
    expect(() => registerTaskCardHooks({ logger }, registry as never)).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});
