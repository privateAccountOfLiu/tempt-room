/** Deterministic prompt for deliveries that were pending before a runner reconnect. */
export function buildRecoveryPrompt(entries) {
  const seen = new Set();
  const selected = [];
  for (const entry of [...entries].sort((left, right) => left.seq - right.seq)) {
    if (seen.has(entry.deliveryId)) continue;
    seen.add(entry.deliveryId);
    selected.push({...entry, text: entry.text?.trim() ? entry.text : '（未取得事件正文，请在房间历史中核对）'});
  }
  return {
    prompt: selected.length ? `以下是你离线期间待处理的会话输入（按顺序）：\n${selected.map((entry, index) => `${index + 1}. [seq ${entry.seq}] ${entry.text}`).join('\n')}` : '',
    deliveryIds: selected.map(entry => entry.deliveryId),
    maxSeq: selected.reduce((max, entry) => Math.max(max, entry.seq), 0)
  };
}
