import { ReceiverAckTimeoutError } from '@slack/bolt/dist/types';
import { StringIndexed } from '@slack/bolt/dist/types/helpers';
import { RespondFn } from '../changed/utilities';
import { Receiver, ReceiverEvent } from '../unchanged/receiver';

export interface TwoPhaseReceiver extends Receiver {

  // Phase 1
  on(event: 'message', listener: (event: ReceiverEvent) => void): unknown;
  on(event: 'error', listener: (error: Error | ReceiverAckTimeoutError) => void): unknown;

  // Phase 2
  on(event: 'async-message', listener: (event: AsyncReceiverEvent) => void): unknown;
  on(event: 'async-completion', listener: (event: AsyncReceiverEvent) => void): unknown;
  emit(name: 'async-completion', event: AsyncReceiverEvent): unknown;

  // Just for Phase 1 compatibility
  start(...args: any[]): Promise<unknown>;
  stop(...args: any[]): Promise<unknown>;
}

export interface AsyncReceiverEvent {
  body: StringIndexed;
  respond?: RespondFn;
}