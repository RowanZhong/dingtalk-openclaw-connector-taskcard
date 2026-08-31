/**
 * 任务卡片（子代理模式）：类型、渲染纯函数与出站目标归一化。
 * Registry 在 Task 3 中加入本文件。
 */
import type { AICardTarget } from "./messaging/card.ts";

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
