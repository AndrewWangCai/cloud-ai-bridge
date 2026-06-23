// 单测：stream-json 解析（文字增量 / 最终文本 / 步骤标签）。运行：node test-stream-parse.js
const assert = require('assert');
const { streamDeltaText, streamFullText, streamStepLabels } = require('./src/stream-parse');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; };
const eq = (name, a, b) => { assert.deepStrictEqual(a, b, name + ' => ' + JSON.stringify(a)); console.log('  ✓ ' + name); pass++; };

// 真实形态的 stream-json 行样本
const deltaEvt = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } } };
const resultEvt = { type: 'result', result: '已为你生成网页。' };
const assistantText = { type: 'assistant', message: { content: [{ type: 'text', text: '好的，我来做。' }] } };
const writeEvt = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/workspace/sub/about.html', content: '...' } }] } };
const bashInstall = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm install three' } }] } };
const bashServe = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'python3 -m http.server 8765' } }] } };
const multiTool = { type: 'assistant', message: { content: [
  { type: 'tool_use', name: 'Edit', input: { file_path: 'index.html' } },
  { type: 'tool_use', name: 'Read', input: { file_path: '/workspace/style.css' } }
] } };

console.log('streamDeltaText:');
eq('文字增量', streamDeltaText(deltaEvt), '你好');
eq('非增量事件返回空', streamDeltaText(resultEvt), '');
eq('垃圾输入不崩', streamDeltaText(null), '');

console.log('streamFullText:');
eq('result 整块', streamFullText(resultEvt), '已为你生成网页。');
eq('assistant 文本块', streamFullText(assistantText), '好的，我来做。');
eq('无文本返回 null/空', streamFullText(deltaEvt), null);

console.log('streamStepLabels:');
eq('Write → 写文件(取 basename)', streamStepLabels(writeEvt), ['✍️ 写文件 about.html']);
eq('Bash install → 装依赖', streamStepLabels(bashInstall), ['📦 安装依赖…']);
eq('Bash http.server → 起服务', streamStepLabels(bashServe), ['🌐 启动服务…']);
eq('多工具一次返回多个', streamStepLabels(multiTool), ['✏️ 修改 index.html', '📖 读取 style.css']);
eq('纯文本 assistant 无步骤', streamStepLabels(assistantText), []);
eq('非 assistant 无步骤', streamStepLabels(resultEvt), []);

// 模拟一整条 NDJSON 流：把上面拼成多行，逐行解析（和 index.js 里循环一致）
const stream = [deltaEvt, writeEvt, bashInstall, bashServe, resultEvt].map((o) => JSON.stringify(o)).join('\n') + '\n';
let streamed = '', full = '', steps = [];
for (const line of stream.split('\n')) {
  const s = line.trim(); if (!s) continue;
  let obj; try { obj = JSON.parse(s); } catch (e) { continue; }
  const d = streamDeltaText(obj); if (d) streamed += d;
  for (const st of streamStepLabels(obj)) steps.push(st);
  const f = streamFullText(obj); if (f) full = f;
}
console.log('整流回放:');
eq('累计增量文字', streamed, '你好');
eq('最终文本=result', full, '已为你生成网页。');
eq('步骤序列', steps, ['✍️ 写文件 about.html', '📦 安装依赖…', '🌐 启动服务…']);

console.log('\n🎉 全部通过：' + pass + ' 项');
