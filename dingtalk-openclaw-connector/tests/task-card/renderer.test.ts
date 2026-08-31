import { describe, expect, it } from "vitest";
import {
  normalizeOutboundTarget,
  renderTaskCard,
  targetKey,
  type TaskStep,
} from "../../src/services/task-card.ts";

describe("renderTaskCard", () => {
  it("渲染四种状态图标与完成计数，让用户一眼分辨进度", () => {
    const steps: TaskStep[] = [
      { step: "检索资料", status: "completed" },
      { step: "分析定价", status: "in_progress" },
      { step: "输出对比表", status: "pending" },
      { step: "汇总结果", status: "failed" },
    ];
    const md = renderTaskCard({ steps, answer: "" });
    expect(md).toContain("**📋 任务进度（1/4）**");
    expect(md).toContain("- ✅ 检索资料");
    expect(md).toContain("- 🔄 分析定价");
    expect(md).toContain("- ⏳ 输出对比表");
    expect(md).toContain("- ❌ 汇总结果（失败）");
    expect(md).toContain("---");
  });

  it("answer 为空时显示占位文案，避免结果区空白误导用户", () => {
    expect(renderTaskCard({ steps: [], answer: "" })).toContain("（子任务执行中…）");
  });

  it("answer 非空时原样出现在结果区", () => {
    const md = renderTaskCard({ steps: [{ step: "a", status: "completed" }], answer: "最终答案" });
    expect(md).toContain("**💬 结果**");
    expect(md.endsWith("最终答案")).toBe(true);
  });

  it("steps 为空时不渲染进度区（普通回复不该看到空 todo 头）", () => {
    const md = renderTaskCard({ steps: [], answer: "hi" });
    expect(md).not.toContain("任务进度");
  });
});

describe("normalizeOutboundTarget / targetKey", () => {
  it("解析 user:/group: 前缀、裸 cid 归为群、其余裸 id 归为用户（对齐出站 to 的各种形态）", () => {
    expect(normalizeOutboundTarget("user:u1")).toEqual({ type: "user", userId: "u1" });
    expect(normalizeOutboundTarget("group:cidXYZ")).toEqual({ type: "group", openConversationId: "cidXYZ" });
    expect(normalizeOutboundTarget("cidXYZ==")).toEqual({ type: "group", openConversationId: "cidXYZ==" });
    expect(normalizeOutboundTarget("u123")).toEqual({ type: "user", userId: "u123" });
    expect(normalizeOutboundTarget("")).toBeNull();
  });

  it("targetKey 与 bind 侧使用同一编码，保证出站命中判断的键一致", () => {
    expect(targetKey({ type: "user", userId: "u1" })).toBe("user:u1");
    expect(targetKey({ type: "group", openConversationId: "c1" })).toBe("group:c1");
  });
});
