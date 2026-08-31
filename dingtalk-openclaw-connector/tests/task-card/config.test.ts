import { describe, expect, it } from "vitest";
import { DingtalkConfigSchema } from "../../src/config/schema.ts";

describe("taskCard / streaming config", () => {
  it("接受 taskCard 配置（顶层与账号级）—— 用户必须能关闭任务卡或调整看门狗", () => {
    const parsed = DingtalkConfigSchema.safeParse({
      clientId: "id",
      taskCard: { enabled: false, watchdogMs: 600000 },
      accounts: { a1: { taskCard: { enabled: true } } },
    });
    expect(parsed.success).toBe(true);
  });

  it("接受 streaming 布尔（修复 strict schema 拒绝已被代码读取的键的缺口）", () => {
    expect(DingtalkConfigSchema.safeParse({ clientId: "id", streaming: false }).success).toBe(true);
  });

  it("拒绝 taskCard 未知子键 —— 保持 strict 校验风格", () => {
    expect(DingtalkConfigSchema.safeParse({ clientId: "id", taskCard: { foo: 1 } }).success).toBe(false);
  });
});
