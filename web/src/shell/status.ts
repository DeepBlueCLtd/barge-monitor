// What the display client reports about itself, for the shell's status
// summary and the client's card (VS-28). The shell only reads it.
import { Store } from './store';

export interface ClientStatus {
  phase: 'starting' | 'handshake' | 'running' | 'degraded' | 'rejected' | 'unreachable';
  essentialsMissing: number;
  optional: number;
  instance: string | null;
}

export const clientStatus = new Store<ClientStatus>({ phase: 'starting', essentialsMissing: 0, optional: 0, instance: null });
