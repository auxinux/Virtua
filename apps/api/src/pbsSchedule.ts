export interface PbsJobSchedule {
  enabled: number | boolean;
  /** JS weekday digits, 0 = Sunday */
  days: string;
  /** server-local HH:MM */
  time: string;
  last_run_at: string | null;
}

/** True when the job's slot for today has passed and it has not run since. */
export function isPbsJobDue(job: PbsJobSchedule, now: Date): boolean {
  if (!job.enabled || !job.days.includes(String(now.getDay()))) return false;
  const [h, m] = job.time.split(":").map(Number);
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  if (now < slot) return false;
  return !job.last_run_at || new Date(job.last_run_at) < slot;
}
