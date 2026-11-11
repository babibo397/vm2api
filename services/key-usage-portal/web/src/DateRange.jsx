import React from 'react';

export function DateRange({ range, today, onRangeChange }) {
  // Native date input / fill tools can emit input without a React change event.
  // Handle both so displayed dates and the query snapshot stay in sync.
  const update = field => event => onRangeChange({ [field]: event.currentTarget.value });
  return <div className="custom-range">
    <label>开始日期<input aria-label="开始日期" type="date" value={range.from} max={today} onInput={update('from')} onChange={update('from')} /></label>
    <span className="date-separator">至</span>
    <label>结束日期<input aria-label="结束日期" type="date" value={range.to} max={today} onInput={update('to')} onChange={update('to')} /></label>
    <p>包含结束日期整日；最多 90 天。超过 7 天按天汇总。</p>
  </div>;
}
