import { SayArguments, RespondArguments, AckFn } from '@slack/bolt/dist/types/utilities';
import { SlashCommand, SlackAction, BlockAction, InteractiveMessage, DialogSubmitAction, DialogValidation, BasicSlackEvent, SlackEvent } from '@slack/bolt/dist/types';
import { StringIndexed } from '@slack/bolt/dist/types/helpers';
import { ErrorCode, CodedError } from '@slack/bolt/dist/errors';
import { SlackOptionsMiddlewareArgs } from '../unchanged/options';
import { SlackViewMiddlewareArgs } from '../unchanged/view';
import { WebAPICallResult } from '@slack/web-api';
import { AxiosResponse } from 'axios';

// ###############################################################################
// CHANGED
export interface SayFn {
  (message: string | SayArguments): Promise<WebAPICallResult>;
}
export interface RespondFn {
  // may need to have an abstration rather than exposing AxiosResponse
  (message: string | RespondArguments): Promise<AxiosResponse<string>>;
}
// ###############################################################################

export type AnyMiddlewareArgs =
  SlackEventMiddlewareArgs | SlackActionMiddlewareArgs | SlackCommandMiddlewareArgs |
  SlackOptionsMiddlewareArgs | SlackViewMiddlewareArgs;

export interface PostProcessFn {
  (error: Error | undefined, done: (error?: Error) => void): unknown;
}

export interface Context extends StringIndexed {
}

export interface Middleware<Args> {
  (args: Args & { next: NextMiddleware, context: Context }): unknown;
}

export interface NextMiddleware {
  (error: Error): void;
  (postProcess: PostProcessFn): void;
  (): void;
}

export interface ContextMissingPropertyError extends CodedError {
  code: ErrorCode.ContextMissingPropertyError;
  missingProperty: string;
}

export interface SlackCommandMiddlewareArgs {
  payload: SlashCommand;
  command: this['payload'];
  body: this['payload'];
  say: SayFn;
  respond: RespondFn;
  ack: AckFn<string | RespondArguments>;
}

type ActionAckFn<A extends SlackAction> =
  A extends InteractiveMessage ? AckFn<string | SayArguments> :
  A extends DialogSubmitAction ? AckFn<DialogValidation> :
  AckFn<void>;

export interface SlackActionMiddlewareArgs<Action extends SlackAction = SlackAction> {
  payload: (Action extends BlockAction<infer ElementAction> ? ElementAction : Action extends InteractiveMessage<infer InteractiveAction> ? InteractiveAction : Action);
  action: this['payload'];
  body: Action;
  say: Action extends Exclude<SlackAction, DialogSubmitAction> ? SayFn : never;
  respond: RespondFn;
  ack: ActionAckFn<Action>;
}

export interface SlackEventMiddlewareArgs<EventType extends string = string> {
  payload: EventFromType<EventType>;
  event: this['payload'];
  message: EventType extends 'message' ? this['payload'] : never;
  body: EnvelopedEvent<this['payload']>;
  say: WhenEventHasChannelContext<this['payload'], SayFn>;
}

interface EnvelopedEvent<Event = BasicSlackEvent> extends StringIndexed {
  token: string;
  team_id: string;
  enterprise_id?: string;
  api_app_id: string;
  event: Event;
  type: 'event_callback';
  event_id: string;
  event_time: number;
  authed_users: string[];
}

declare type EventFromType<T extends string> = KnownEventFromType<T> extends never ? BasicSlackEvent<T> : KnownEventFromType<T>;
declare type KnownEventFromType<T extends string> = Extract<SlackEvent, {
  type: T;
}>;

declare type WhenEventHasChannelContext<Event, Type> = Event extends ({ channel: string; } | {
  item: {
    channel: string;
  };
}) ? Type : never;