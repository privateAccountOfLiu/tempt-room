/**
 * Shared, deterministic failure classification for the run error card and the
 * run detail modal. This explains what happened; it never changes a run's
 * persisted status or re-enables a command automatically.
 */
export type FailureKind = 'canceled' | 'timeout' | 'budget' | 'context' | 'auth' | 'network' | 'dependency' | 'tool' | 'provider' | 'unknown';
export interface FailureInfo { kind: FailureKind; label: string; retryable: boolean; advice: string }
export function classifyFailure(error: string | undefined, status: string): FailureInfo {
  const text = (error ?? '').toLowerCase();
  if (/预算|budget/.test(text)) return { kind: 'budget', label: '预算限制', retryable: true, advice: '检查单次或房间预算后重试。' };
  if (/时间上限|超时|timeout|timed out/.test(text)) return { kind: 'timeout', label: '执行超时', retryable: true, advice: '可调整超时或自适应设置后重试。' };
  if (/上下文|context/.test(text)) return { kind: 'context', label: '上下文已变化', retryable: true, advice: '重试会基于当前房间事实重新运行。' };
  if (/认证|密钥|凭据|401|403|credential|api key/.test(text)) return { kind: 'auth', label: '认证失败', retryable: true, advice: '检查 Agent 凭据与环境变量后重试。' };
  if (/econn|connect|network|socket|fetch failed|网络/.test(text)) return { kind: 'network', label: '网络错误', retryable: true, advice: '检查本机代理或服务端网络后重试。' };
  if (/依赖|dependency/.test(text)) return { kind: 'dependency', label: '依赖未就绪', retryable: true, advice: '先完成或修复上游任务，再重试。' };
  if (/工具|tool|operation/.test(text)) return { kind: 'tool', label: '工具操作失败', retryable: true, advice: '未知副作用请先核对，再决定是否重试。' };
  if (status === 'canceled' || status === 'interrupted') return { kind: 'canceled', label: status === 'canceled' ? '已停止' : '已中断', retryable: true, advice: '确认没有未完成的副作用后可重试。' };
  if (/not found|not available|不可用|未找到/.test(text)) return { kind: 'provider', label: '提供方不可用', retryable: true, advice: '检查 Agent 程序或服务状态后重试。' };
  return { kind: 'unknown', label: status === 'unknown' ? '状态待核实' : '运行失败', retryable: true, advice: '查看详情与工具操作记录后再决定是否重试。' };
}
