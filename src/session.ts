import { randomUUID } from 'node:crypto';
import type { Vex } from './vex';
import type { VexResult, ConversationTurn } from './models';
import { TraceContext } from './trace';

export interface SessionTraceOptions {
  task?: string;
  input?: unknown;
  parentExecutionId?: string;
}

export class Session {
  public readonly sessionId: string;
  private readonly vex: Vex;
  private readonly agentId: string;
  private readonly metadata: Record<string, unknown>;
  private seq = 0;
  private history: ConversationTurn[] = [];

  constructor(
    vex: Vex,
    agentId: string,
    sessionId?: string,
    metadata?: Record<string, unknown>,
  ) {
    this.vex = vex;
    this.agentId = agentId;
    this.sessionId = sessionId ?? randomUUID();
    this.metadata = metadata ?? {};
  }

  get sequence(): number {
    return this.seq;
  }

  async trace(
    opts: SessionTraceOptions,
    fn: (ctx: TraceContext) => Promise<void> | void,
  ): Promise<VexResult> {
    const currentSeq = this.seq;
    const windowSize = this.vex.config.conversationWindowSize;
    const historySnapshot: ConversationTurn[] | undefined =
      this.history.length > 0 ? this.history.slice(-windowSize) : undefined;

    const ctx = new TraceContext({
      agentId: this.agentId,
      task: opts.task,
      input: opts.input,
      sessionId: this.sessionId,
      sequenceNumber: currentSeq,
      parentExecutionId: opts.parentExecutionId,
      conversationHistory: historySnapshot,
    });

    for (const [key, value] of Object.entries(this.metadata)) {
      ctx.setMetadata(key, value);
    }

    await fn(ctx);
    const result = await this.vex._processTraceContext(ctx);

    this.seq++;
    this.history.push({
      sequenceNumber: currentSeq,
      input: opts.input,
      output: ctx.getOutput(),
      task: opts.task,
    });
    if (this.history.length > windowSize) {
      this.history = this.history.slice(-windowSize);
    }

    return result;
  }
}
