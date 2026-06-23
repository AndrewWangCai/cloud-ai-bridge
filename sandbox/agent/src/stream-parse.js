// Claude Code / ccr 的 stream-json 解析（纯函数，便于单测）。
// 三件事：取文字增量、取最终整块文本、取"正在做什么"的步骤标签。

// 从一条事件里取「增量文字」（边生成边显示）
function streamDeltaText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.type === 'stream_event' && obj.event) {
    const ev = obj.event;
    if (ev.type === 'content_block_delta' && ev.delta && (ev.delta.type === 'text_delta' || typeof ev.delta.text === 'string')) return ev.delta.text || '';
  }
  return '';
}

// 取「完整最终文本」（result 事件 / 无增量时的 assistant 整块）
function streamFullText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'result' && typeof obj.result === 'string') return obj.result;
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    return obj.message.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
  }
  return null;
}

// 从 assistant 事件里取「正在做什么」的步骤标签（Claude Code 自身工具调用，与后端模型无关，GLM 经 ccr 也有）
function streamStepLabels(obj) {
  if (!obj || obj.type !== 'assistant' || !obj.message || !Array.isArray(obj.message.content)) return [];
  const base = (p) => String(p || '').split(/[\\/]/).pop();
  const out = [];
  for (const b of obj.message.content) {
    if (!b || b.type !== 'tool_use') continue;
    const name = b.name || ''; const inp = b.input || {};
    if (name === 'Write') out.push('✍️ 写文件 ' + base(inp.file_path));
    else if (name === 'Edit' || name === 'MultiEdit') out.push('✏️ 修改 ' + base(inp.file_path));
    else if (name === 'Read') out.push('📖 读取 ' + base(inp.file_path));
    else if (name === 'Glob' || name === 'Grep') out.push('🔍 查找文件…');
    else if (name === 'Bash') {
      const cmd = String(inp.command || '');
      if (/\b(npm|pnpm|yarn|pip|pip3)\b.*\b(install|add)\b/.test(cmd) || /\bnpm i\b/.test(cmd)) out.push('📦 安装依赖…');
      else if (/http\.server|\bserve\b|vite|next\b|\bdev\b|\bstart\b/.test(cmd)) out.push('🌐 启动服务…');
      else out.push('⚙️ 执行命令 ' + cmd.replace(/\s+/g, ' ').slice(0, 36));
    } else if (name) out.push('🔧 ' + name);
  }
  return out;
}

module.exports = { streamDeltaText, streamFullText, streamStepLabels };
