import type {AgentOutput} from '../../../../packages/protocol/src/index.ts';
import type {AdapterContext} from '../adapters.ts';
import type {AgentExecution, AgentTransport} from './agent-transport.ts';

/**
 * Optional F03 service adapter boundary (AgentScope-shaped).
 *
 * This is a fixture contract, not a claim of compatibility with a specific
 * AgentScope release: the real target version and official API must be pinned
 * before production use. It maps the service operations the plan requires
 * (open session, outputs, input, cancel, outcome query, close) onto the
 * shared AgentTransport port. Until a real service test exists every
 * capability is reported as unverified.
 */
export interface AgentScopeOptions {
  endpoint: string;
  credentialEnv?: string;
  fetchImpl?: typeof fetch;
}

export const agentScopeCapabilities = {
  streaming: 'unverified',
  input: 'unverified',
  cancel: 'unverified',
  queryOutcome: 'unverified',
  resume: 'unverified'
} as const;

export class AgentScopeTransport implements AgentTransport {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sessions = new Map<string, string>();

  constructor(private readonly options: AgentScopeOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(context?: AdapterContext): Record<string, string> {
    const token = this.options.credentialEnv ? process.env[this.options.credentialEnv] : undefined;
    return {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})};
  }

  openExecution(context: AdapterContext): AgentExecution {
    const transport = this;
    const outputs = async function* (): AsyncIterable<AgentOutput> {
      const executionId = context.executionId ?? context.run.executionId ?? context.run.id;
      const response = await transport.fetchImpl(`${transport.endpoint}/sessions`, {
        method: 'POST',
        headers: transport.headers(context),
        body: JSON.stringify({
          prompt: context.prompt,
          metadata: {
            roomId: context.run.roomId,
            runId: context.run.id,
            generation: context.run.generation ?? 1,
            executionId
          }
        }),
        signal: context.signal
      });
      if (!response.ok) throw new Error(`AgentScope session failed: HTTP ${response.status}`);
      const body = await response.json() as {sessionId?: string; output?: string; events?: Array<{type: string; text?: string; usage?: any}>; error?: {message?: string}};
      if (body.error) throw new Error(body.error.message ?? 'AgentScope service error');
      if (!body.sessionId) throw new Error('AgentScope response omitted sessionId');
      transport.sessions.set(executionId, body.sessionId);
      yield {type: 'session', id: body.sessionId};
      if (typeof body.output === 'string' && body.output) yield {type: 'text', text: body.output};
      for (const event of body.events ?? []) {
        if (event.type === 'text' && typeof event.text === 'string') yield {type: 'text', text: event.text};
        if (event.type === 'usage' && event.usage) yield {type: 'usage', usage: event.usage};
      }
    };
    return {outputs: outputs()};
  }

  provideInput(executionId: string, text: string): boolean {
    const sessionId = this.sessions.get(executionId);
    if (!sessionId) return false;
    void this.fetchImpl(`${this.endpoint}/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({text})
    }).catch(() => undefined);
    return true;
  }

  cancel(executionId: string, reason?: unknown): void {
    const sessionId = this.sessions.get(executionId);
    if (!sessionId) return;
    void this.fetchImpl(`${this.endpoint}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify({reason: reason instanceof Error ? reason.message : reason})
    }).catch(() => undefined);
  }

  async queryOutcome(executionId: string): Promise<unknown> {
    const sessionId = this.sessions.get(executionId);
    if (!sessionId) throw new Error('AgentScope execution is not known');
    const response = await this.fetchImpl(`${this.endpoint}/sessions/${encodeURIComponent(sessionId)}/outcome`, {headers: this.headers()});
    if (!response.ok) throw new Error(`AgentScope outcome failed: HTTP ${response.status}`);
    return response.json();
  }
}
