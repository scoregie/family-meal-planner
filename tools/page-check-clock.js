// Part of tools/page-check.sh: gives the throwaway server a fixed clock (each look at the time is
// 1 millisecond after the last), so the times it stamps on things are the same on every run.
const RealDate = Date;
let now = RealDate.parse('2026-11-11T01:30:00Z');

// A Date that starts at the fixed moment instead of the real time.
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(now++); }
  static now() { return now++; }
}
global.Date = FixedDate;
