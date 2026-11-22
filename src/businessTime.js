'use strict';
// Working time: 09:30-18:30 IST, Monday-Friday, excluding holidays.
// All public functions take and return epoch milliseconds.

const OFFSET_MS = 330 * 60000; // IST = UTC+5:30 (no DST)
const DAY_MS = 86400000;
const OPEN = 9 * 60 + 30;   // minutes after midnight
const CLOSE = 18 * 60 + 30;
const WORKDAY_MINUTES = CLOSE - OPEN; // 540

let holidays = new Set(); // 'YYYY-MM-DD'
function setHolidays(list) { holidays = new Set(list); }

const split = (t) => {
  const local = t + OFFSET_MS;
  const d = Math.floor(local / DAY_MS);
  return { d, m: (local - d * DAY_MS) / 60000 };
};
const toMs = (d, m) => d * DAY_MS + m * 60000 - OFFSET_MS;

function isWorkday(d) {
  const date = new Date(d * DAY_MS);
  const dow = date.getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(date.toISOString().slice(0, 10));
}

// Move t forward to the nearest moment that is inside working time.
function normalize(t) {
  let { d, m } = split(t);
  if (isWorkday(d) && m < CLOSE) return toMs(d, Math.max(m, OPEN));
  d += 1;
  while (!isWorkday(d)) d += 1;
  return toMs(d, OPEN);
}

function addBusinessMinutes(start, minutes) {
  let t = normalize(start);
  let left = minutes;
  for (;;) {
    const { d, m } = split(t);
    const room = CLOSE - m;
    if (left <= room) return t + left * 60000;
    left -= room;
    t = normalize(toMs(d, CLOSE));
  }
}

function businessMinutesBetween(a, b) {
  if (b <= a) return 0;
  let t = normalize(a);
  let total = 0;
  while (t < b) {
    const { d } = split(t);
    const end = toMs(d, CLOSE);
    if (b <= end) { total += (b - t) / 60000; break; }
    total += (end - t) / 60000;
    t = normalize(end);
  }
  return total;
}

// End of the working day that contains (or follows) t.
function workdayClose(t) {
  const { d } = split(normalize(t));
  return toMs(d, CLOSE);
}

module.exports = {
  WORKDAY_MINUTES, setHolidays, isWorkday, normalize,
  addBusinessMinutes, businessMinutesBetween, workdayClose,
};
