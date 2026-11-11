import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { createUsageClient } from './client.mjs';
import { dateTime, effectiveBucket, money, number, presetRange, seriesTimePositions } from './time.mjs';
import './styles.css';
import { DateRange } from './DateRange.jsx';

const presets = [['today', '今天'], ['yesterday', '昨天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['custom', '自定义']];
const outcome = { success: '成功', error: '失败', other: '其他' };

function Icon({ name, size = 18 }) {
  const paths = { arrow: <path d="M5 12h14m-5-5 5 5-5 5" />, key: <><circle cx="8" cy="8" r="4" /><path d="m11 11 9 9m-3-3 3-3m-6 0 3-3" /></>, eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>, shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>, chart: <><path d="M4 4v16h16M8 15l4-5 4 2 4-6" /></> };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function Empty({ loading, title, children }) {
  return <div className={`empty-state ${loading ? 'is-loading' : ''}`} role="status"><Icon name="chart" size={27} /><strong>{loading ? '正在读取用量…' : title}</strong><span>{loading ? '正在汇总所选日期内的请求记录，请稍候。' : children}</span></div>;
}

function Summary({ summary, loading }) {
  const value = (field) => summary ? number(summary[field]) : '—';
  const successRate = summary?.requests ? `${(100 * summary.success / summary.requests).toFixed(1)}%` : '—';
  return <section className="summary-band" aria-label="区间用量汇总" aria-busy={loading}>
    <div className="summary-stat"><span className="stat-label">请求总数</span><strong>{value('requests')}<small>次</small></strong><div className="stat-detail"><span>成功 {value('success')}</span><span>失败 {value('errors')}</span><span>其他 {value('other')}</span></div></div>
    <div className="summary-stat"><span className="stat-label">总 Token</span><strong>{value('total_tokens')}</strong><div className="stat-detail"><span>输入 {value('input_tokens')}</span><span>输出 {value('output_tokens')}</span></div></div>
    <div className="summary-stat"><span className="stat-label">{summary?.unpriced_requests ? '区间已知费用' : '区间费用'} <span className="unit">USD</span></span><strong className="accent-value">{summary ? money(summary.cost) : '—'}</strong><div className="stat-detail">{summary?.unpriced_requests ? <span className="warning-text">{number(summary.unpriced_requests)} 次请求尚未定价</span> : <span>按当前日志记录统计</span>}</div></div>
    <div className="summary-stat"><span className="stat-label">成功率</span><strong>{successRate}</strong><div className="stat-detail"><span>成功请求 / 全部请求</span></div></div>
    <div className="cache-line"><span>缓存 Token</span><span>读取 <b>{value('cache_read_tokens')}</b></span><span>写入 <b>{value('cache_creation_tokens')}</b></span><span className="cache-note">缓存输入不重复计入总 Token</span></div>
  </section>;
}

function Coverage({ usage }) {
  if (!usage) return null;
  const coverage = usage.coverage || {};
  return <div className={`coverage ${coverage.status === 'partial' ? 'partial' : ''}`}>
    <span className="coverage-dot" />
    <p><strong>{coverage.status === 'partial' ? '部分历史记录不可用' : coverage.status === 'complete' ? '所选区间记录完整' : '按当前保留日志统计'}</strong><span>{coverage.status === 'partial' ? `早期记录可能已清理${coverage.available_from ? `，可用记录起点：${dateTime(coverage.available_from)}` : ''}。当前统计不代表完整历史。` : coverage.status === 'complete' ? '统计包含所选区间内当前已记录的请求。' : '历史采集与保留情况可能影响结果，空结果不等于从未使用。'}</span></p>
  </div>;
}

function Trend({ usage, loading }) {
  const [metric, setMetric] = useState('requests');
  const sourceSeries = usage?.series || [];
  const sourcePositions = seriesTimePositions(sourceSeries, usage?.range);
  const series = sourceSeries.filter((_, i) => sourcePositions[i] != null);
  const positions = sourcePositions.filter(position => position != null);
  const fields = { requests: '请求数', total_tokens: 'Token', cost: '费用 USD' };
  const values = series.map(item => Number(item[metric]) || 0);
  const maximum = Math.max(...values, 1);
  const width = 780; const height = 220; const left = 56; const top = 20; const bottom = 178; const right = 758;
  const x = i => left + positions[i] * (right - left);
  const y = v => bottom - v / maximum * (bottom - top);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const labels = [0, 1 / 3, 2 / 3, 1];
  const rangeStart = Date.parse(usage?.range.start || '');
  const rangeEnd = Date.parse(usage?.range.end || '');
  const label = ratio => dateTime(new Date(rangeStart + ratio * (rangeEnd - rangeStart)).toISOString()).slice(5, usage?.range.bucket === 'hour' ? 16 : 10);
  return <section className="trend-section" aria-labelledby="trend-title">
    <div className="section-heading"><div><h2 id="trend-title">用量趋势</h2><p>{usage ? `${usage.range.bucket === 'hour' ? '按小时' : '按天'}汇总 · 上海时间` : '查看请求、Token 与费用的变化'}</p></div><div className="segmented metric-tabs" aria-label="趋势指标">{Object.entries(fields).map(([field, text]) => <button key={field} type="button" aria-pressed={metric === field} onClick={() => setMetric(field)}>{text}</button>)}</div></div>
    {!usage || loading ? <Empty loading={loading} title="等待查询用量">输入 Key 并选择日期，趋势将在这里呈现。</Empty> : series.length === 0 ? <Empty title="所选区间没有请求记录">尝试调整时间范围，并留意日志覆盖说明。</Empty> : <figure className="trend-figure"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${fields[metric]}趋势，${series.length} 个${usage.range.bucket === 'hour' ? '小时' : '日期'}，最高 ${metric === 'cost' ? money(Math.max(...values)) : number(Math.max(...values))}`}>
      {[0, 0.5, 1].map(ratio => <g key={ratio}><line x1={left} y1={y(maximum * ratio)} x2={right} y2={y(maximum * ratio)} stroke="#e7edf0" strokeDasharray={ratio === 0 ? undefined : '3 5'} /><text x={left - 12} y={y(maximum * ratio) + 4} textAnchor="end" className="chart-text">{metric === 'cost' ? (maximum * ratio).toFixed(2) : new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(maximum * ratio)}</text></g>)}
      <polygon points={`${x(0)},${bottom} ${points} ${x(series.length - 1)},${bottom}`} fill="#e4f4ef" />
      <polyline points={points} fill="none" stroke="#16836c" strokeWidth="2.5" strokeLinejoin="round" />
      {series.map((item, i) => <circle key={item.bucket} cx={x(i)} cy={y(values[i])} r={series.length > 40 ? 2 : 3.5} fill="#16836c" stroke="white" strokeWidth="1.5"><title>{item.bucket} · {fields[metric]} {metric === 'cost' ? money(item.cost) : number(values[i])}{item.unpriced_requests ? ` · ${item.unpriced_requests} 次待定价` : ''}</title></circle>)}
      {labels.map(ratio => <text key={ratio} x={left + ratio * (right - left)} y={205} textAnchor={ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'} className="chart-text">{label(ratio)}</text>)}
    </svg><figcaption>{metric === 'cost' ? '费用仅含已定价记录；待定价金额不按零费用解释。' : '横轴按实际时间间隔展示，未返回的日期不补零。'}</figcaption></figure>}
  </section>;
}

function Quota({ quota, loading }) {
  return <aside className="quota-section" aria-labelledby="quota-title"><div className="section-heading"><div><h2 id="quota-title">Key 额度</h2><p>与区间费用分别统计</p></div></div>{quota ? <>
    <div className="key-identity"><strong>{quota.key?.name || '当前 Key'}</strong><span className="mono">{quota.key?.masked_key || '—'}</span></div>
    <dl className="quota-list"><div><dt>状态</dt><dd>{quota.key?.expired ? '已到期' : quota.key?.status === 'active' ? '正常' : quota.key?.status === 'quota_exhausted' ? '额度已用尽' : quota.key?.status === 'disabled' ? '已停用' : '—'}</dd></div><div><dt>剩余额度</dt><dd className="quota-remaining">{quota.usd?.limit == null ? '不限额' : money(quota.usd.remaining)}</dd></div><div><dt>额度已使用</dt><dd>{money(quota.usd?.used)}</dd></div><div><dt>总额度</dt><dd>{quota.usd?.limit == null ? '不限额' : money(quota.usd.limit)}</dd></div><div><dt>到期时间</dt><dd>{quota.key?.expires_at ? dateTime(quota.key.expires_at) : '长期有效'}</dd></div>{quota.requests?.limit != null ? <div><dt>剩余请求数</dt><dd>{number(quota.requests.remaining)} 次</dd></div> : null}</dl>
    {quota.windows && Object.values(quota.windows).some(w => w.limit != null) ? <details className="quota-windows"><summary>查看周期额度</summary>{Object.entries(quota.windows).filter(([, w]) => w.limit != null).map(([name, window]) => <div key={name}><span>{({ '5h': '5 小时', '1d': '1 天', '7d': '7 天', '1w': '1 周', '1m': '1 月' })[name] || name}</span><strong>{money(window.remaining)} 剩余</strong>{window.reset_at ? <small>重置于 {dateTime(window.reset_at)}</small> : null}</div>)}</details> : null}
    <p className="quota-note">额度重置可能改变已使用额度，因此该数值可能与区间费用不同。</p>
  </> : <div className="quota-empty"><Icon name="key" size={24} /><p>{loading ? '正在读取当前 Key 额度…' : '查询后显示当前 Key 的状态与剩余额度。'}</p></div>}</aside>;
}

function Models({ usage, loading }) {
  const rows = usage?.models?.items || [];
  const other = usage?.models?.other;
  const total = usage?.summary.requests || 0;
  const row = (item, name, key) => <tr key={key}><th scope="row"><span className="model-name">{name}</span><svg className="share-track" viewBox="0 0 100 3" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="3" fill="#eef3f4" /><rect width={total ? Math.min(100, item.requests / total * 100) : 0} height="3" fill="#7dbca9" /></svg></th><td>{number(item.requests)}</td><td>{total ? `${(item.requests / total * 100).toFixed(1)}%` : '—'}</td><td>{number(item.input_tokens)}</td><td>{number(item.output_tokens)}</td><td>{number(item.cache_read_tokens)} / {number(item.cache_creation_tokens)}</td><td>{money(item.cost)}{item.unpriced_requests ? <small className="unpriced">{number(item.unpriced_requests)} 次待定价</small> : null}</td></tr>;
  return <section className="table-section" aria-labelledby="models-title"><div className="section-heading"><div><h2 id="models-title">模型分布</h2><p>按已知费用排序，模型名与客户端一致</p></div>{usage ? <span className="section-count">{rows.length} 个模型{usage.models?.truncated ? ' · 已合并其余模型' : ''}</span> : null}</div>
    {!usage || loading ? <Empty loading={loading} title="等待模型用量">查询后可比较各模型的请求量、Token 与费用。</Empty> : !rows.length && !other ? <p className="table-empty">所选区间暂无模型记录</p> : <div className="table-scroll" tabIndex="0" aria-label="模型用量表，可横向滚动"><table><thead><tr><th>模型</th><th>请求数</th><th>占比</th><th>输入 Token</th><th>输出 Token</th><th>缓存读取 / 写入</th><th>已知费用 (USD)</th></tr></thead><tbody>{rows.map((item, i) => row(item, item.model || '未知模型', `model-${i}`))}{other ? row(other, '其他模型（合计）', 'other') : null}</tbody></table></div>}
  </section>;
}

function Recent({ usage, loading, loadingMore, onMore }) {
  const rows = usage?.recent?.items || [];
  return <section className="table-section recent-section" aria-labelledby="recent-title"><div className="section-heading"><div><h2 id="recent-title">请求明细</h2><p>按时间从新到旧 · 时间为 Asia/Shanghai</p></div>{usage ? <span className="section-count">已显示 {number(rows.length)} 条</span> : null}</div>
    {!usage || loading ? <Empty loading={loading} title="等待请求明细">这里显示请求结果与用量，不包含对话内容。</Empty> : !rows.length ? <p className="table-empty">所选区间暂无请求记录</p> : <><div className="table-scroll" tabIndex="0" aria-label="请求明细表，可横向滚动"><table className="recent-table"><thead><tr><th>时间 / 请求 ID</th><th>模型</th><th>结果</th><th>输入 / 输出</th><th>缓存读取 / 写入</th><th>费用 (USD)</th><th>耗时</th></tr></thead><tbody>{rows.map((item, i) => <tr key={`${item.request_id}-${i}`}><th scope="row"><span className="request-time">{dateTime(item.created_at)}</span><span className="request-id mono" title={item.request_id}>{item.request_id || '—'}</span></th><td><span className="model-name">{item.model || '未知模型'}</span></td><td><span className={`outcome ${['success', 'error', 'other'].includes(item.outcome) ? item.outcome : 'other'}`}><i />{outcome[item.outcome] || '其他'}</span>{item.status ? <span className="status-code">{item.status}</span> : null}{item.error_code ? <small className="error-code">{item.error_code}</small> : null}</td><td>{number(item.input_tokens)} / {number(item.output_tokens)}</td><td>{number(item.cache_read_tokens)} / {number(item.cache_creation_tokens)}</td><td className={item.cost == null ? 'muted' : ''}>{money(item.cost)}</td><td>{item.duration_ms == null ? '—' : `${number(item.duration_ms)} ms`}</td></tr>)}</tbody></table></div><div className="pagination"><span>{usage.recent.has_more ? '还有更多请求记录' : '已显示当前区间的全部请求'}</span>{usage.recent.has_more ? <button type="button" className="button secondary" onClick={onMore} disabled={loadingMore}>{loadingMore ? '正在加载…' : '加载更多'}</button> : null}</div></>}
  </section>;
}

function App() {
  const [client] = useState(() => createUsageClient({ basePath: import.meta.env.BASE_URL }));
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [preset, setPreset] = useState('7d');
  useEffect(() => () => client.cancel(), [client]);
  const updateKey = value => { client.setKey(value); setKey(value); };
  const updateRange = patch => client.setRange({ ...state.range, ...patch });
  const selectPreset = value => { setPreset(value); if (value !== 'custom') client.setRange({ ...presetRange(value), bucket: state.range.bucket }); else client.setRange(state.range); };
  let hourAvailable = false;
  try { hourAvailable = effectiveBucket('hour', state.range.from, state.range.to) === 'hour'; } catch { /* Date input may be incomplete. */ }
  const today = presetRange('today').to;
  return <><a className="skip-link" href="#main">跳至查询内容</a><header className="site-header"><div className="header-inner"><a className="brand" href={import.meta.env.BASE_URL} aria-label="vm2api 用量查询首页"><span className="brand-mark">v<span>m</span></span><strong>vm2api</strong><span className="brand-divider" />用量查询</a><span className="header-note"><Icon name="shield" size={15} />仅查看当前 Key</span></div></header>
    <main id="main" className="page"><div className="page-heading"><h1>每一次调用，清晰可查。</h1><p>查询你的 Key 用量、模型分布与请求明细。</p></div>
      <form className="query-panel" onSubmit={event => { event.preventDefault(); client.query(); }}>
        <div className="key-row"><div className="key-control"><label htmlFor="api-key">你的 API Key</label><div className="key-input-wrap"><Icon name="key" /><input id="api-key" name="api-key" type={showKey ? 'text' : 'password'} value={key} onChange={event => updateKey(event.target.value)} placeholder="输入 vm2api 创建的 Key" autoComplete="off" autoCapitalize="none" spellCheck="false" aria-describedby="key-privacy" /><button type="button" className="reveal-key" onClick={() => setShowKey(!showKey)} aria-label={showKey ? '隐藏 Key' : '显示 Key'} aria-pressed={showKey}><Icon name="eye" /></button></div></div><button className="button primary query-button" type="submit" disabled={state.loading}>{state.loading ? '查询中…' : state.usage ? '刷新用量' : '查询用量'}<Icon name="arrow" /></button><button className="clear-button" type="button" onClick={() => { client.clear(); setKey(''); setShowKey(false); }} disabled={!key}>清除 Key</button></div>
        <p className="privacy-note" id="key-privacy"><Icon name="shield" size={14} />Key 仅保存在当前页面内存中，刷新或清除后即移除。</p>
        <div className="range-row"><div className="preset-group" aria-label="时间范围">{presets.map(([value, label]) => <button key={value} type="button" aria-pressed={preset === value} onClick={() => selectPreset(value)}>{label}</button>)}</div><div className="range-options"><label className="select-label" htmlFor="bucket">统计粒度</label><select id="bucket" value={state.range.bucket} onChange={event => updateRange({ bucket: event.target.value })}><option value="day">按天</option><option value="hour" disabled={!hourAvailable}>按小时</option></select><span className="timezone">上海时间 UTC+8</span></div></div>
        {preset === 'custom' ? <DateRange range={state.range} today={today} onRangeChange={updateRange} /> : <p className="range-caption">{state.range.from} 至 {state.range.to} · 包含结束日期 · {hourAvailable ? '最多可按小时查看' : '超过 7 天按天汇总'}</p>}
      </form>
      {state.error ? <div className="error-banner" role="alert"><strong>查询未完成</strong><span>{state.error}</span></div> : null}
      <div className="results-heading"><h2>用量概览</h2><span aria-live="polite">{state.loading ? '正在查询…' : state.usage ? `更新于 ${dateTime(state.usage.as_of)}` : '尚未查询'}</span></div>
      {state.usage ? <p className="actual-range">统计区间：{dateTime(state.usage.range.start)} 至 {dateTime(state.usage.range.end)}（不含截止时刻）</p> : null}
      <Coverage usage={state.usage} /><Summary summary={state.usage?.summary} loading={state.loading} />
      <div className="analysis-layout"><Trend usage={state.usage} loading={state.loading} /><Quota quota={state.quota} loading={state.loading} /></div>
      <Models usage={state.usage} loading={state.loading} /><Recent usage={state.usage} loading={state.loading} loadingMore={state.loadingMore} onMore={() => client.loadMore()} />
      <footer className="page-footer"><p>费用按当前日志价格记录统计，历史补价或修正可能调整金额；待定价请求不视为免费。</p><p>查询不发起模型调用，不消耗模型额度。历史记录受日志保留范围影响。</p><span>vm2api · Key 用量查询</span></footer>
    </main></>;
}

createRoot(document.getElementById('root')).render(<App />);
