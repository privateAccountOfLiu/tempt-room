import { z } from 'zod';

/** This is a connection to an existing backend, never a launcher or a model URL. */
export const codexBindingSchema = z.object({
  transport: z.enum(['websocket', 'control-socket']),
  endpoint: z.string().min(1).max(2000),
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).or(z.literal('')).default(''),
  threadId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  expectedCwd: z.string().min(1).max(1500)
}).strict().superRefine((value, ctx) => {
  if (value.transport === 'websocket') {
    let valid = false;
    try {
      const url = new URL(value.endpoint);
      valid = ['ws:', 'wss:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname)
        && !url.username && !url.password && !url.search && !url.hash;
    } catch {}
    if (!valid) ctx.addIssue({ code: 'custom', path: ['endpoint'], message: '附着端点必须是无内嵌凭据的 loopback WebSocket URL（127.0.0.1 或 [::1]）' });
    if (!value.credentialEnv) ctx.addIssue({ code: 'custom', path: ['credentialEnv'], message: 'WebSocket 附着必须配置认证令牌的环境变量名称' });
  } else if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\\.\\pipe\\)/.test(value.endpoint)) {
    ctx.addIssue({ code: 'custom', path: ['endpoint'], message: '控制 socket 必须是绝对路径' });
  }
  if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value.expectedCwd)) ctx.addIssue({ code: 'custom', path: ['expectedCwd'], message: '线程工作目录必须是绝对路径' });
});
export type CodexBinding = z.infer<typeof codexBindingSchema>;

export const codexRunStateSchema = z.object({
  binding: codexBindingSchema,
  version: z.string().optional(),
  executable: z.string().optional(),
  clientUserMessageId: z.string().min(1),
  queuedSubmissionId: z.string().optional(),
  nativeTurnId: z.string().optional(),
  nativeStatus: z.enum(['inProgress','completed','failed','interrupted']).optional(),
  phase: z.enum(['prepared', 'queued', 'running', 'uncertain', 'completed', 'canceled'])
});
export type CodexRunState = z.infer<typeof codexRunStateSchema>;
