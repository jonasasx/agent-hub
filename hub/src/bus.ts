import { EventEmitter } from 'node:events';
import type { AgentMessage, EnrollStage, PayloadOf, RunnerView } from '@agent-hub/shared';

export interface HubEvents {
  'runner.status': [userId: string, runner: RunnerView];
  'agent.message': [runnerId: string, message: AgentMessage];
  /** An agent completed hello/welcome; sessions of the runner are reconciled with liveSessions. */
  /** side.file with its bytes (tool-results of a session, D3/D7). */
  'agent.side': [runnerId: string, meta: PayloadOf<AgentMessage, 'side.file'>, data: Buffer];
  'agent.hello': [runnerId: string, userId: string, hello: PayloadOf<AgentMessage, 'hello'>];
  /** Change multi-user: a stage of «Подключить машину» (runner.enroll to the owner's windows). */
  'runner.enroll': [userId: string, runnerId: string, stage: EnrollStage, runner: RunnerView];
}

/** In-process event bus between the agent gateway, the UI gateway and (later) schedulers. */
export class HubBus extends EventEmitter<HubEvents> {}
