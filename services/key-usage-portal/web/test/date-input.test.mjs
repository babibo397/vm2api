import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { transformWithEsbuild } from 'vite';
import { createUsageClient } from '../src/client.mjs';

// Exercise the actual React date controls. Assigning through the tracked DOM
// property reproduces fill tools that dispatch input but bypass React change.
test('native input edits clear loaded data and submit the visible custom dates', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const source = await readFile(new URL('../src/DateRange.jsx', import.meta.url), 'utf8');
  const compiled = await transformWithEsbuild(source, 'DateRange.jsx', { jsx: 'transform' });
  const moduleCode = compiled.code.replace('from "react"', `from ${JSON.stringify(import.meta.resolve('react'))}`);
  const { DateRange } = await import(`data:text/javascript;base64,${Buffer.from(moduleCode).toString('base64')}`);
  const urls = [];
  const client = createUsageClient({ initialRange: { from: '2026-11-05', to: '2026-11-11', bucket: 'day' }, fetchImpl: async url => {
    urls.push(url);
    return { ok: true, json: async () => url.includes('/quota') ? { key: { name: 'synthetic' } } : { range: {}, summary: {}, recent: { items: [] } } };
  } });
  client.setKey('synthetic-key'); await client.query();
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(DateRange, { range: client.getSnapshot().range, today: '2026-11-11', onRangeChange: patch => client.setRange({ ...client.getSnapshot().range, ...patch }) })));
  const start = document.querySelector('[aria-label="开始日期"]');
  await act(async () => { start.value = '2026-11-10'; start.dispatchEvent(new window.Event('input', { bubbles: true })); });
  assert.equal(client.getSnapshot().usage, null, 'visible date edit must immediately clear prior results');
  assert.equal(client.getSnapshot().quota, null);
  assert.equal(client.getSnapshot().range.from, '2026-11-10');
  const end = document.querySelector('[aria-label="结束日期"]');
  await act(async () => { end.value = '2026-11-10'; end.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await client.query();
  const lastUsage = new URL(urls.filter(url => url.includes('/usage?')).at(-1), 'http://localhost');
  assert.equal(lastUsage.searchParams.get('start'), '2026-11-10T00:00:00+08:00');
  assert.equal(lastUsage.searchParams.get('end'), '2026-11-11T00:00:00+08:00');
  await act(async () => root.unmount());
  dom.window.close();
});
