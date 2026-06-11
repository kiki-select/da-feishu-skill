// 中国法定节假日 + 调休字典（2025-2027 三年滚动维护）
// 数据源：国务院办公厅每年 11/12 月发布的下一年节假日通知
// 维护：每年人工更新；如缺当年数据，holiday-detect.js 会 warn
//
// 数据结构：
//   YYYY-MM-DD: { name: '元旦', type: 'holiday' | 'weekend-makeup' }
//   - holiday: 法定休假日（包括调休出的"假"）
//   - weekend-makeup: 调休出的"上班日"（一般是周末上班补偿假期）
//
// 用法：
//   const { getHolidaysInRange, isHoliday } = require('./cn-holidays');
//   const holidays = getHolidaysInRange('2026-04-30', '2026-05-26');
//   // → [ {date:'2026-04-30', name:'劳动节', ...}, ... ]

const HOLIDAYS = {
  // 2025
  '2025-01-01': { name: '元旦', type: 'holiday' },
  '2025-01-28': { name: '春节', type: 'holiday' }, '2025-01-29': { name: '春节', type: 'holiday' },
  '2025-01-30': { name: '春节', type: 'holiday' }, '2025-01-31': { name: '春节', type: 'holiday' },
  '2025-02-01': { name: '春节', type: 'holiday' }, '2025-02-02': { name: '春节', type: 'holiday' },
  '2025-02-03': { name: '春节', type: 'holiday' }, '2025-02-04': { name: '春节', type: 'holiday' },
  '2025-04-04': { name: '清明', type: 'holiday' }, '2025-04-05': { name: '清明', type: 'holiday' }, '2025-04-06': { name: '清明', type: 'holiday' },
  '2025-05-01': { name: '劳动节', type: 'holiday' }, '2025-05-02': { name: '劳动节', type: 'holiday' },
  '2025-05-03': { name: '劳动节', type: 'holiday' }, '2025-05-04': { name: '劳动节', type: 'holiday' },
  '2025-05-05': { name: '劳动节', type: 'holiday' },
  '2025-05-31': { name: '端午', type: 'holiday' }, '2025-06-01': { name: '端午', type: 'holiday' }, '2025-06-02': { name: '端午', type: 'holiday' },
  '2025-10-01': { name: '国庆+中秋', type: 'holiday' }, '2025-10-02': { name: '国庆+中秋', type: 'holiday' },
  '2025-10-03': { name: '国庆+中秋', type: 'holiday' }, '2025-10-04': { name: '国庆+中秋', type: 'holiday' },
  '2025-10-05': { name: '国庆+中秋', type: 'holiday' }, '2025-10-06': { name: '国庆+中秋', type: 'holiday' },
  '2025-10-07': { name: '国庆+中秋', type: 'holiday' }, '2025-10-08': { name: '国庆+中秋', type: 'holiday' },

  // 2026
  '2026-01-01': { name: '元旦', type: 'holiday' }, '2026-01-02': { name: '元旦', type: 'holiday' }, '2026-01-03': { name: '元旦', type: 'holiday' },
  '2026-02-16': { name: '春节', type: 'holiday' }, '2026-02-17': { name: '春节', type: 'holiday' },
  '2026-02-18': { name: '春节', type: 'holiday' }, '2026-02-19': { name: '春节', type: 'holiday' },
  '2026-02-20': { name: '春节', type: 'holiday' }, '2026-02-21': { name: '春节', type: 'holiday' },
  '2026-02-22': { name: '春节', type: 'holiday' }, '2026-02-23': { name: '春节', type: 'holiday' },
  '2026-04-04': { name: '清明', type: 'holiday' }, '2026-04-05': { name: '清明', type: 'holiday' }, '2026-04-06': { name: '清明', type: 'holiday' },
  '2026-04-30': { name: '劳动节', type: 'holiday' }, '2026-05-01': { name: '劳动节', type: 'holiday' },
  '2026-05-02': { name: '劳动节', type: 'holiday' }, '2026-05-03': { name: '劳动节', type: 'holiday' },
  '2026-05-04': { name: '劳动节', type: 'holiday' }, '2026-05-05': { name: '劳动节', type: 'holiday' },
  '2026-06-19': { name: '端午', type: 'holiday' }, '2026-06-20': { name: '端午', type: 'holiday' }, '2026-06-21': { name: '端午', type: 'holiday' },
  '2026-09-25': { name: '中秋', type: 'holiday' }, '2026-09-26': { name: '中秋', type: 'holiday' }, '2026-09-27': { name: '中秋', type: 'holiday' },
  '2026-10-01': { name: '国庆', type: 'holiday' }, '2026-10-02': { name: '国庆', type: 'holiday' },
  '2026-10-03': { name: '国庆', type: 'holiday' }, '2026-10-04': { name: '国庆', type: 'holiday' },
  '2026-10-05': { name: '国庆', type: 'holiday' }, '2026-10-06': { name: '国庆', type: 'holiday' }, '2026-10-07': { name: '国庆', type: 'holiday' },
};

const SUPPORTED_YEARS = new Set([2025, 2026]); // 2027 待官方发布后补

function isHoliday(date) {
  return !!HOLIDAYS[date];
}

function getHolidaysInRange(startDate, endDate) {
  const result = [];
  // 检查范围内年份是否都有数据
  const startYear = parseInt(startDate.slice(0, 4), 10);
  const endYear = parseInt(endDate.slice(0, 4), 10);
  for (let y = startYear; y <= endYear; y++) {
    if (!SUPPORTED_YEARS.has(y)) {
      console.warn(`⚠ cn-holidays.js 缺 ${y} 年数据，请补充后重跑！`);
    }
  }
  for (const [date, info] of Object.entries(HOLIDAYS)) {
    if (date >= startDate && date <= endDate) result.push({ date, ...info });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

// 把连续日期合并成段：[{name, start, end, days}]
function groupConsecutiveHolidays(dates) {
  if (dates.length === 0) return [];
  const sorted = [...dates].sort((a, b) => a.date.localeCompare(b.date));
  const groups = [];
  let cur = { name: sorted[0].name, start: sorted[0].date, end: sorted[0].date, days: 1 };
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(cur.end);
    const next = new Date(sorted[i].date);
    const diff = (next - prev) / (1000 * 60 * 60 * 24);
    if (diff === 1 && sorted[i].name === cur.name) {
      cur.end = sorted[i].date;
      cur.days++;
    } else {
      groups.push(cur);
      cur = { name: sorted[i].name, start: sorted[i].date, end: sorted[i].date, days: 1 };
    }
  }
  groups.push(cur);
  return groups;
}

module.exports = { HOLIDAYS, isHoliday, getHolidaysInRange, groupConsecutiveHolidays };
