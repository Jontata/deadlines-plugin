import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { inflateRawSync } from 'node:zlib';
import { assertSizeLimits, buildPlugin, createZip, renderHostPlugin, renderHtml } from './build.mjs';

test('inline scripts preserve replacement tokens and cannot close their script element', () => {
  const template = '<!-- STYLES --><!-- LOGIC --><!-- APP -->';
  const html = renderHtml(template, 'body{}', 'var value = "</script>";', 'var title = "$& </script>";');
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
  assert.match(html, /\$&/);
  assert.match(html, /<\\\/script>/);
  assert.throws(() => renderHtml('<!-- APP -->', '', '', ''), /placeholder/);
});

test('ZIP entries round-trip through deflate and preserve filenames and contents', () => {
  const entries = [{ name: 'manifest.json', data: '{"id":"deadlines-view"}' }, { name: 'index.html', data: 'Deadline ⚑' }];
  const zip = createZip(entries);
  let offset = 0;
  for (const entry of entries) {
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const dataStart = offset + 30 + nameLength;
    assert.equal(zip.subarray(offset + 30, dataStart).toString(), entry.name);
    assert.equal(inflateRawSync(zip.subarray(dataStart, dataStart + size)).toString(), entry.data);
    offset = dataStart + size;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.throws(() => createZip([{ name: '../escape', data: '' }]), /Unsafe/);
});

test('host plugin only serves static assets for the supported message', () => {
  const assets = { css: 'body{color:red}', js: 'throw new Error("Do not execute in host");' };
  let handler;
  runInNewContext(renderHostPlugin(assets), { PluginAPI: { onMessage: (fn) => { handler = fn; } } });
  const reply = handler({ type: 'deadlines-assets-v1' });
  assert.equal(reply.css, assets.css);
  assert.equal(reply.js, assets.js);
  for (const message of [null, undefined, [], 'deadlines-assets-v1', {}, { type: 'other' }]) {
    assert.throws(() => handler(message), /Unsupported Deadlines asset request/);
  }
  assert.throws(() => runInNewContext(renderHostPlugin(assets), {}), /requires Super Productivity plugin message support/);
});

test('build rejects assets beyond Super Productivity upload limits', () => {
  assert.doesNotThrow(() => assertSizeLimits('small HTML', 'small host script', Buffer.alloc(1)));
  assert.throws(() => assertSizeLimits('x'.repeat(100 * 1024 + 1), ''), /index.html.*at most 102400 bytes/);
  assert.throws(() => assertSizeLimits('', Buffer.alloc(5 * 1024 * 1024 + 1)), /plugin.js.*at most 5242880 bytes/);
  assert.throws(() => assertSizeLimits('', '', Buffer.alloc(10 * 1024 * 1024 + 1)), /Plugin ZIP.*at most 10485760 bytes/);
});

test('built plugin fits upload limits and carries offline assets through the host message bridge', async () => {
  await buildPlugin();
  const version = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8')).version;
  const [html, plugin, zip] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./plugin.js', import.meta.url), 'utf8'),
    readFile(new URL(`./deadlines-plugin-${version}.zip`, import.meta.url)),
  ]);
  assertSizeLimits(html, plugin, zip);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\brel=["']stylesheet/i);
  assert.match(html, /<style id="deadlines-styles">/);
  assert.match(html, /\/\/ <logic>/);
  assert.match(html, /\/\/ <\/logic>/);
  let handler;
  runInNewContext(plugin, { PluginAPI: { onMessage: (fn) => { handler = fn; } } });
  const assets = handler({ type: 'deadlines-assets-v1' });
  assert.ok(assets.css.length > 1000, 'library styles must be packaged');
  assert.ok(assets.js.length > 1000, 'browser app must be packaged');
  assert.doesNotMatch(assets.css, /url\(\s*["']?(?:https?:|\/\/)/i);
  const archive = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const dataStart = offset + 30 + nameLength;
    archive.set(zip.subarray(offset + 30, dataStart).toString(), inflateRawSync(zip.subarray(dataStart, dataStart + size)).toString());
    offset = dataStart + size;
  }
  assert.deepEqual([...archive.keys()], ['manifest.json', 'index.html', 'plugin.js', 'icon.svg', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']);
  assert.equal(archive.get('plugin.js'), plugin);
  assert.equal(archive.get('index.html'), html);
  const notices = await readFile(new URL('./THIRD-PARTY-NOTICES.txt', import.meta.url), 'utf8');
  assert.match(notices, /core-js 3\.49\.0/);
  assert.match(notices, /2025–2026 CoreJS Company/);
});
