import { ReceiverAckTimeoutError } from '@slack/bolt/dist/types';
import { StringIndexed } from '@slack/bolt/dist/types/helpers';
import { AckFn } from '@slack/bolt/dist/types/utilities';
import { RespondFn } from '../changed/utilities';

export interface Receiver {

  on(event: 'message', listener: (event: ReceiverEvent) => void): unknown;
  on(event: 'error', listener: (error: Error | ReceiverAckTimeoutError) => void): unknown;

  start(...args: any[]): Promise<unknown>;
  stop(...args: any[]): Promise<unknown>;
}

export interface ReceiverEvent {
  body: StringIndexed;
  ack: AckFn<any>;
  respond?: RespondFn;
}