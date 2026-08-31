/**
 * openclaw hook → TaskCardRegistry 桥接。
 * 只做字段映射与渠道过滤，不做任何 HTTP 调用。
 */
import { taskCardRegistry, type TaskCardRegistry } from "./services/task-card.ts";

const DINGTALK_SESSION_MARKER = ":dingtalk-connector:";

function isDingtalkSession(sessionKey: unknown): sessionKey is string {
  return typeof sessionKey === "string" && sessionKey.includes(DINGTALK_SESSION_MARKER);
}

type HookApi = {
  on?: (name: string, handler: (event: never, ctx?: never) => unknown, opts?: unknown) => unknown;
  logger?: { warn?: (...args: unknown[]) => void };
};

export function registerTaskCardHooks(api: unknown, registry: TaskCardRegistry = taskCardRegistry): void {
  const hookApi = api as HookApi;
  const on = typeof hookApi?.on === "function" ? hookApi.on.bind(hookApi) : null;
  if (!on) {
    hookApi?.logger?.warn?.("[dingtalk-connector] api.on 不可用（openclaw 版本过旧），任务卡片功能停用");
    return;
  }

  on("before_tool_call", (event: { toolName?: string }, ctx?: { sessionKey?: string }) => {
    if (event?.toolName !== "sessions_spawn") return;
    if (!isDingtalkSession(ctx?.sessionKey)) return;
    registry.markOrchestrating(ctx!.sessionKey!);
  });

  on("after_tool_call", (
    event: { toolName?: string; error?: string; params?: { plan?: unknown } },
    ctx?: { sessionKey?: string },
  ) => {
    if (event?.toolName !== "update_plan" || event?.error) return;
    if (!isDingtalkSession(ctx?.sessionKey)) return;
    const plan = event?.params?.plan;
    if (Array.isArray(plan)) registry.applyPlan(ctx!.sessionKey!, plan as never);
  });

  on("subagent_spawned", (
    event: { childSessionKey?: string; label?: string },
    ctx?: { requesterSessionKey?: string },
  ) => {
    if (!isDingtalkSession(ctx?.requesterSessionKey)) return;
    if (!event?.childSessionKey) return;
    registry.onChildSpawned(ctx!.requesterSessionKey!, event.childSessionKey, event.label);
  });

  on("subagent_ended", (event: { targetSessionKey?: string; outcome?: string }) => {
    if (!event?.targetSessionKey) return;
    registry.onChildEnded(event.targetSessionKey, event.outcome);
  });
}
