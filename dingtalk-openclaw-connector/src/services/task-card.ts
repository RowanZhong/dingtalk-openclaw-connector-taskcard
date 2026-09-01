/**
 * 任务卡片（子代理模式）：类型、渲染纯函数与出站目标归一化。
 * Registry 在 Task 3 中加入本文件。
 */
import type { AICardInstance, AICardTarget } from "./messaging/card.ts";
import {
  finishAICard as defaultFinishAICard,
  streamAICard as defaultStreamAICard,
} from "./messaging/card.ts";

export type StepStatus = "pending" | "in_progress" | "completed" | "failed";
export type TaskStep = { step: string; status: StepStatus; childKey?: string };

const STATUS_ICON: Record<StepStatus, string> = {
  pending: "⏳",
  in_progress: "🔄",
  completed: "✅",
  failed: "❌",
};

export function renderTaskCard(state: { steps: TaskStep[]; answer: string }): string {
  const lines: string[] = [];
  const total = state.steps.length;
  if (total > 0) {
    const done = state.steps.filter((s) => s.status === "completed").length;
    lines.push(`**📋 任务进度（${done}/${total}）**`);
    for (const s of state.steps) {
      lines.push(`- ${STATUS_ICON[s.status]} ${s.step}${s.status === "failed" ? "（失败）" : ""}`);
    }
    lines.push("", "---", "");
  }
  lines.push("**💬 结果**", "");
  lines.push(state.answer.trim() ? state.answer : "（子任务执行中…）");
  return lines.join("\n");
}

/** 出站 to 的各种形态：user:/group: 前缀、裸 cid（群）、其余裸 id（用户）。 */
export function normalizeOutboundTarget(to: string): AICardTarget | null {
  const raw = (to ?? "").trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (lowered.startsWith("user:")) {
    const userId = raw.slice(5).trim();
    return userId ? { type: "user", userId } : null;
  }
  if (lowered.startsWith("group:")) {
    const openConversationId = raw.slice(6).trim();
    return openConversationId ? { type: "group", openConversationId } : null;
  }
  if (raw.startsWith("cid")) return { type: "group", openConversationId: raw };
  return { type: "user", userId: raw };
}

export function targetKey(target: AICardTarget): string {
  return target.type === "user" ? `user:${target.userId}` : `group:${target.openConversationId}`;
}

export const DEFAULT_TASK_WATCHDOG_MS = 900_000;
export const RENDER_THROTTLE_MS = 800;
/**
 * openclaw 按 textChunkLimit 把长文本切成多次 sendText。窗口内到达的出站分片
 * 视为同一条答案的续写（追加而非覆盖），并把收尾推迟到窗口关闭后，
 * 否则第 1 片就 finish，第 2 片会另开一张普通卡。
 */
export const OUTBOUND_CHUNK_WINDOW_MS = 1500;
const WATCHDOG_SUFFIX = "\n\n⚠️ 任务未在预期时间内完成，请重新发起或查看 /subagents";

export type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

export type TaskCardDeps = {
  streamAICard: typeof defaultStreamAICard;
  finishAICard: typeof defaultFinishAICard;
  now: () => number;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
};

type TaskChild = { label: string; done: boolean; ok?: boolean };

type TaskCardRecord = {
  sessionKey: string;
  phase: "normal" | "orchestrating";
  card?: AICardInstance;
  config?: unknown;
  log?: LoggerLike;
  tKey?: string;
  steps: TaskStep[];
  children: Map<string, TaskChild>;
  answer: string;
  watchdogMs: number;
  watchdog?: ReturnType<typeof setTimeout>;
  renderTimer?: ReturnType<typeof setTimeout>;
  finishTimer?: ReturnType<typeof setTimeout>;
  lastPushAt: number;
  lastOutboundAt: number;
  finishing: boolean;
};

export type TaskCardRegistry = {
  /** 返回是否注册成功；已有编排态记录且卡片不同时拒绝（调用方按普通卡片处理）。 */
  bind(p: { sessionKey: string; accountId: string; target: AICardTarget; card: AICardInstance; config: unknown; log?: LoggerLike }): boolean;
  markOrchestrating(sessionKey: string): void;
  isOrchestrating(sessionKey: string): boolean;
  applyPlan(sessionKey: string, plan: Array<{ step?: unknown; status?: unknown }>): void;
  onChildSpawned(sessionKey: string, childKey: string, label?: string): void;
  onChildEnded(childKey: string, outcome?: string): void;
  setAnswer(sessionKey: string, text: string): Promise<void>;
  interceptOutboundText(p: { accountId: string; to: string; text: string }): Promise<{ handled: boolean; cardInstanceId?: string }>;
  onDispatchIdle(sessionKey: string): "keep-open" | "not-orchestrating";
  release(sessionKey: string): void;
  reset(): void;
};

const VALID_STATUSES: readonly StepStatus[] = ["pending", "in_progress", "completed", "failed"];

export function createTaskCardRegistry(depsIn?: Partial<TaskCardDeps>): TaskCardRegistry {
  const deps: TaskCardDeps = {
    streamAICard: depsIn?.streamAICard ?? defaultStreamAICard,
    finishAICard: depsIn?.finishAICard ?? defaultFinishAICard,
    now: depsIn?.now ?? Date.now,
    setTimeoutFn: depsIn?.setTimeoutFn ?? setTimeout,
    clearTimeoutFn: depsIn?.clearTimeoutFn ?? clearTimeout,
  };

  const bySession = new Map<string, TaskCardRecord>();
  const byTarget = new Map<string, string>();      // `${accountId}:${targetKey}` -> sessionKey
  const byChild = new Map<string, string>();       // childSessionKey -> sessionKey

  const clearTimers = (rec: TaskCardRecord) => {
    if (rec.watchdog) { deps.clearTimeoutFn(rec.watchdog); rec.watchdog = undefined; }
    if (rec.renderTimer) { deps.clearTimeoutFn(rec.renderTimer); rec.renderTimer = undefined; }
    if (rec.finishTimer) { deps.clearTimeoutFn(rec.finishTimer); rec.finishTimer = undefined; }
  };

  const remove = (rec: TaskCardRecord) => {
    clearTimers(rec);
    bySession.delete(rec.sessionKey);
    if (rec.tKey && byTarget.get(rec.tKey) === rec.sessionKey) byTarget.delete(rec.tKey);
    for (const [child, owner] of byChild) if (owner === rec.sessionKey) byChild.delete(child);
  };

  // 编排协议强制在计划末尾放一条不会 spawn 子代理的「汇总结果」，它永远
  // 停在 pending/in_progress。因此完成判定只看真正有子代理绑定的步骤，
  // 未绑定的残留步骤在 finish 时补标完成。
  const isComplete = (rec: TaskCardRecord): boolean => {
    if (!rec.answer.trim()) return false;
    if (rec.children.size === 0) return false;
    if (![...rec.children.values()].every((c) => c.done)) return false;
    return rec.steps.every((s) => !s.childKey || s.status === "completed" || s.status === "failed");
  };

  const push = async (rec: TaskCardRecord) => {
    if (rec.phase !== "orchestrating" || !rec.card || !rec.config || rec.finishing) return;
    rec.lastPushAt = deps.now();
    try {
      await deps.streamAICard(rec.card, renderTaskCard(rec), false, rec.config as never, rec.log as never);
    } catch (err) {
      rec.log?.warn?.(`[TaskCard] 渲染推送失败（下次事件会全量补齐）: ${(err as Error)?.message ?? err}`);
    }
  };

  const scheduleRender = (rec: TaskCardRecord) => {
    if (!rec.card || !rec.config || rec.renderTimer || rec.finishing) return;
    const delay = Math.max(0, RENDER_THROTTLE_MS - (deps.now() - rec.lastPushAt));
    rec.renderTimer = deps.setTimeoutFn(() => {
      rec.renderTimer = undefined;
      void push(rec);
    }, delay);
    (rec.renderTimer as { unref?: () => void }).unref?.();
  };

  const finish = async (rec: TaskCardRecord) => {
    if (rec.finishing) return;
    rec.finishing = true;
    clearTimers(rec);
    // 未绑定子代理的残留步骤（如协议强制的「汇总结果」）在收尾时补标完成
    for (const s of rec.steps) {
      if (!s.childKey && (s.status === "pending" || s.status === "in_progress")) s.status = "completed";
    }
    const { card, config } = rec;
    remove(rec);
    if (card && config) {
      try {
        await deps.finishAICard(card, renderTaskCard(rec), config as never, rec.log as never);
        rec.log?.info?.(`[TaskCard] ✅ 任务卡收尾完成 card=${card.cardInstanceId}`);
      } catch (err) {
        rec.log?.error?.(`[TaskCard] ❌ 任务卡收尾失败: ${(err as Error)?.message ?? err}`);
      }
    }
  };

  const touchWatchdog = (rec: TaskCardRecord) => {
    if (rec.phase !== "orchestrating") return;
    if (rec.watchdog) deps.clearTimeoutFn(rec.watchdog);
    rec.watchdog = deps.setTimeoutFn(() => {
      rec.watchdog = undefined;
      if (!rec.card) { remove(rec); return; }   // 从未绑定卡片的悬空记录：静默清理
      rec.log?.warn?.(`[TaskCard] 看门狗到期，强制收尾 session=${rec.sessionKey}`);
      rec.answer = (rec.answer.trim() ? rec.answer : "") + WATCHDOG_SUFFIX;
      void finish(rec);
    }, rec.watchdogMs);
    (rec.watchdog as { unref?: () => void }).unref?.();
  };

  const afterMutation = (rec: TaskCardRecord): Promise<void> => {
    touchWatchdog(rec);
    if (isComplete(rec)) return finish(rec);
    scheduleRender(rec);
    return Promise.resolve();
  };

  const applyAnswer = async (rec: TaskCardRecord, text: string) => {
    rec.answer = text;
    await afterMutation(rec);
  };

  const getOrCreate = (sessionKey: string): TaskCardRecord => {
    let rec = bySession.get(sessionKey);
    if (!rec) {
      rec = {
        sessionKey,
        phase: "normal",
        steps: [],
        children: new Map(),
        answer: "",
        watchdogMs: DEFAULT_TASK_WATCHDOG_MS,
        lastPushAt: 0,
        lastOutboundAt: 0,
        finishing: false,
      };
      bySession.set(sessionKey, rec);
    }
    return rec;
  };

  return {
    bind(p) {
      const rec = getOrCreate(p.sessionKey);
      // 编排进行中的任务卡不得被同 session 的新一轮卡片顶替：否则旧卡永远
      // 不收尾，新一轮的输出还会被写进旧卡。此时拒绝注册，新卡走普通路径。
      if (rec.phase === "orchestrating" && rec.card && rec.card.cardInstanceId !== p.card.cardInstanceId) {
        (p.log ?? rec.log)?.info?.(
          `[TaskCard] 已有编排中的任务卡 card=${rec.card.cardInstanceId}，拒绝注册新卡 card=${p.card.cardInstanceId}`,
        );
        return false;
      }
      rec.card = p.card;
      rec.config = p.config;
      rec.log = p.log;
      rec.tKey = `${p.accountId}:${targetKey(p.target)}`;
      byTarget.set(rec.tKey, p.sessionKey);
      const configured = (p.config as { taskCard?: { watchdogMs?: number } } | undefined)?.taskCard?.watchdogMs;
      if (typeof configured === "number" && configured > 0) rec.watchdogMs = configured;
      if (rec.phase === "orchestrating") touchWatchdog(rec);
      return true;
    },
    markOrchestrating(sessionKey) {
      const rec = getOrCreate(sessionKey);
      if (rec.phase === "orchestrating") { touchWatchdog(rec); return; }
      rec.phase = "orchestrating";
      touchWatchdog(rec);
      // 注意：此处不 scheduleRender —— steps 尚空，避免用占位符清掉已流式的叙述文本
    },
    isOrchestrating(sessionKey) {
      return bySession.get(sessionKey)?.phase === "orchestrating";
    },
    applyPlan(sessionKey, plan) {
      const rec = bySession.get(sessionKey);
      if (!rec || rec.phase !== "orchestrating") return;
      const old = rec.steps;
      rec.steps = plan
        .filter((e): e is { step: string; status: string } => typeof e?.step === "string" && !!(e.step as string).trim())
        .map((e) => {
          const status = VALID_STATUSES.includes(e.status as StepStatus) ? (e.status as StepStatus) : "pending";
          const prev = old.find((o) => o.step === e.step);
          return { step: e.step, status, ...(prev?.childKey ? { childKey: prev.childKey } : {}) };
        });
      void afterMutation(rec);
    },
    onChildSpawned(sessionKey, childKey, label) {
      if (!childKey) return;
      const rec = getOrCreate(sessionKey);
      if (rec.phase !== "orchestrating") { rec.phase = "orchestrating"; }
      const name = (label ?? "").trim() || `子任务 ${rec.children.size + 1}`;
      rec.children.set(childKey, { label: name, done: false });
      byChild.set(childKey, sessionKey);
      const match = rec.steps.find((s) => s.step === name && (!s.childKey || s.childKey === childKey));
      if (match) {
        match.childKey = childKey;
        if (match.status === "pending" || match.status === "failed") match.status = "in_progress";
      } else {
        rec.steps.push({ step: name, status: "in_progress", childKey });
      }
      void afterMutation(rec);
    },
    onChildEnded(childKey, outcome) {
      const sessionKey = byChild.get(childKey);
      if (!sessionKey) return;
      const rec = bySession.get(sessionKey);
      if (!rec) return;
      // outcome 缺省（openclaw 正常结束事件可能不带该字段）按成功处理
      const ok = outcome === undefined || outcome === "ok";
      const child = rec.children.get(childKey);
      if (child) { child.done = true; child.ok = ok; }
      const step = rec.steps.find((s) => s.childKey === childKey);
      if (step && (step.status === "pending" || step.status === "in_progress")) {
        step.status = ok ? "completed" : "failed";
      }
      void afterMutation(rec);
    },
    async setAnswer(sessionKey, text) {
      const rec = bySession.get(sessionKey);
      if (!rec || rec.phase !== "orchestrating") return;
      await applyAnswer(rec, text);
    },
    async interceptOutboundText({ accountId, to, text }) {
      const target = normalizeOutboundTarget(to);
      if (!target) return { handled: false };
      const sessionKey = byTarget.get(`${accountId}:${targetKey(target)}`);
      if (!sessionKey) return { handled: false };
      const rec = bySession.get(sessionKey);
      if (!rec || rec.phase !== "orchestrating" || !rec.card || !rec.config) return { handled: false };
      const cardInstanceId = rec.card.cardInstanceId;
      const at = deps.now();
      // 窗口内的后续分片是同一条答案的续写，追加而不是覆盖
      rec.answer = rec.lastOutboundAt > 0 && at - rec.lastOutboundAt < OUTBOUND_CHUNK_WINDOW_MS && rec.answer
        ? `${rec.answer}\n${text}`
        : text;
      rec.lastOutboundAt = at;
      if (rec.finishTimer) { deps.clearTimeoutFn(rec.finishTimer); rec.finishTimer = undefined; }
      touchWatchdog(rec);
      if (isComplete(rec)) {
        // 收尾推迟一个窗口：后续分片会取消并重排这个定时器
        rec.finishTimer = deps.setTimeoutFn(() => {
          rec.finishTimer = undefined;
          void finish(rec);
        }, OUTBOUND_CHUNK_WINDOW_MS);
        (rec.finishTimer as { unref?: () => void }).unref?.();
      } else {
        scheduleRender(rec);
      }
      return { handled: true, cardInstanceId };
    },
    onDispatchIdle(sessionKey) {
      const rec = bySession.get(sessionKey);
      if (!rec || rec.phase !== "orchestrating") return "not-orchestrating";
      // 只看是否真的有子代理：协议要求先把 step 标 in_progress 再 spawn，
      // spawn 被拒时那个 in_progress 永远不会有人收尾。
      if (rec.children.size === 0) {
        rec.phase = "normal";       // 降级：spawn 从未成功，交回 dispatcher 正常收尾
        clearTimers(rec);
        return "not-orchestrating";
      }
      return "keep-open";
    },
    release(sessionKey) {
      const rec = bySession.get(sessionKey);
      if (rec && rec.phase !== "orchestrating") remove(rec);
    },
    reset() {
      for (const rec of [...bySession.values()]) remove(rec);
    },
  };
}

export const taskCardRegistry: TaskCardRegistry = createTaskCardRegistry();
