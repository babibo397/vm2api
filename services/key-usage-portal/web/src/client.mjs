import { calendarRange, effectiveBucket, presetRange, usageQuery } from './time.mjs';

const errors = {
  400: '查询条件无效，请检查日期范围后重试。',
  401: 'Key 无效或已停用，请检查后重新输入。',
  403: '此 Key 暂时无法查询，请检查 Key 状态。',
  429: '查询过于频繁，请稍后再试。',
  503: '查询服务繁忙，请稍后重试。',
  504: '查询超时，请缩短日期范围或稍后重试。',
};
export function createUsageClient({ fetchImpl = fetch, basePath = '/', initialRange = { ...presetRange('7d'), bucket: 'day' } } = {}) {
  const apiBase = `${basePath.replace(/\/$/, '')}/api`;
  let key = '';
  let generation = 0;
  let controller;
  let snapshot = { range: initialRange, usage: null, quota: null, error: '', loading: false, loadingMore: false, queried: false };
  const listeners = new Set();
  const emit = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
  const clear = () => {
    generation += 1;
    controller?.abort();
    controller = undefined;
    emit({ usage: null, quota: null, error: '', loading: false, loadingMore: false, queried: false });
  };
  async function read(url, token, signal) {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) { const error = new Error(errors[response.status] || '查询暂时不可用，请稍后重试。'); error.safe = true; throw error; }
    return response.json();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setKey(value) { if (value !== key) { key = value; clear(); } },
    setRange(range) {
      clear();
      let bucket = range.bucket;
      try { bucket = effectiveBucket(bucket, range.from, range.to); } catch { /* Incomplete input is validated on submit. */ }
      emit({ range: { ...range, bucket } });
    },
    clear() { key = ''; clear(); },
    cancel: clear,
    async query() {
      clear();
      if (!key.trim()) { emit({ error: '请先输入自己的 Key。' }); return; }
      let query;
      try { query = usageQuery({ ...calendarRange(snapshot.range.from, snapshot.range.to), bucket: snapshot.range.bucket }); }
      catch (error) { emit({ error: error.message }); return; }
      const current = generation;
      const token = key.trim();
      const activeController = new AbortController();
      controller = activeController;
      const signal = activeController.signal;
      const timer = setTimeout(() => activeController.abort(), 12_000);
      emit({ loading: true, queried: true });
      try {
        const [usage, quota] = await Promise.all([read(`${apiBase}/usage?${query}`, token, signal), read(`${apiBase}/quota`, token, signal)]);
        if (current === generation) emit({ usage, quota, loading: false });
      } catch (error) {
        if (current === generation) emit({ error: signal.aborted ? errors[504] : error.safe ? error.message : '网络连接失败或响应异常，请稍后重试。', loading: false, usage: null, quota: null });
        activeController.abort();
      } finally { clearTimeout(timer); }
    },
    async loadMore() {
      const previous = snapshot.usage;
      if (!previous?.recent?.next_cursor || snapshot.loadingMore || snapshot.loading) return;
      const current = generation;
      const token = key.trim();
      const activeController = new AbortController();
      controller = activeController;
      const signal = activeController.signal;
      const timer = setTimeout(() => activeController.abort(), 12_000);
      emit({ loadingMore: true, error: '' });
      try {
        const page = await read(`${apiBase}/usage?${usageQuery(previous.range, previous.recent.next_cursor)}`, token, signal);
        if (current === generation) emit({ loadingMore: false, usage: { ...previous, recent: { ...page.recent, items: [...previous.recent.items, ...page.recent.items] } } });
      } catch (error) {
        if (current === generation) emit({ loadingMore: false, error: signal.aborted ? errors[504] : '明细加载失败，请稍后重试。' });
      } finally { clearTimeout(timer); }
    },
  };
}
