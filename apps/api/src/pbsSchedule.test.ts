import { describe, expect, it } from "vitest";
import { isPbsJobDue } from "./pbsSchedule.js";

// 2026-10-30 is a Friday (getDay() = 5); local time is used on purpose.
const at = (h: number, m = 0, day = 30) => new Date(2026, 9, day, h, m);

describe("isPbsJobDue", () => {
  const job = { enabled: 1, days: "12345", time: "02:00", last_run_at: null as string | null };

  it("is not due before the slot, due after it", () => {
    expect(isPbsJobDue(job, at(1, 59))).toBe(false);
    expect(isPbsJobDue(job, at(2, 0))).toBe(true);
    expect(isPbsJobDue(job, at(14, 0))).toBe(true); // missed while down → runs once
  });

  it("runs once per slot", () => {
    expect(isPbsJobDue({ ...job, last_run_at: at(2, 0).toISOString() }, at(2, 30))).toBe(false);
    expect(isPbsJobDue({ ...job, last_run_at: at(2, 0, 29).toISOString() }, at(2, 30))).toBe(true);
  });

  it("respects weekdays and the enabled flag", () => {
    expect(isPbsJobDue(job, at(3, 0, 31))).toBe(false); // Saturday
    expect(isPbsJobDue({ ...job, enabled: 0 }, at(3))).toBe(false);
  });
});
