import { ReceiverAckTimeoutError, BlockAction, InteractiveMessage, SlackAction } from '@slack/bolt/dist/types';
import { ErrorCode } from '@slack/bolt/dist/errors';
import { IncomingEventType, assertNever } from '@slack/bolt/dist/helpers';
import { AnyMiddlewareArgs, SayFn, RespondFn, SlackEventMiddlewareArgs, SlackActionMiddlewareArgs, SlackCommandMiddlewareArgs, Context } from '../../changed/utilities';
import { SlackOptionsMiddlewareArgs, OptionsSource } from '../../unchanged/options';
import { SlackViewMiddlewareArgs } from '../../unchanged/view';
import { AuthorizeSourceData, ErrorHandler } from '@slack/bolt/dist/App';
import { AckFn } from '@slack/bolt/dist/types/utilities';
import { ChatPostMessageArguments, WebAPICallResult, WebClient } from '@slack/web-api';
import { Logger } from '@slack/logger';

export function sleep(millis: number) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

export const validViewTypes = ['view_closed', 'view_submission'];

export function defaultErrorHandler(logger: Logger): ErrorHandler {
  return (error) => {
    logger.error(error);
  };
}

export function receiverAckTimeoutError(message: string): ReceiverAckTimeoutError {
  const error = new Error(message);
  (error as ReceiverAckTimeoutError).code = ErrorCode.ReceiverAckTimeoutError;
  return (error as ReceiverAckTimeoutError);
}

export function isBlockActionOrInteractiveMessageBody(
  body: SlackActionMiddlewareArgs['body'],
): body is SlackActionMiddlewareArgs<BlockAction | InteractiveMessage>['body'] {
  return (body as SlackActionMiddlewareArgs<BlockAction | InteractiveMessage>['body']).actions !== undefined;
}

export function buildListenerArgs(bodyArg: any, type: IncomingEventType): Pick<AnyMiddlewareArgs, 'body' | 'payload'> & {
  say?: SayFn
  respond?: RespondFn,
  ack?: AckFn<any>,
} {
  return {
    body: bodyArg,
    payload:
      (type === IncomingEventType.Event) ?
        (bodyArg as SlackEventMiddlewareArgs['body']).event :
        (type === IncomingEventType.ViewAction) ?
          (bodyArg as SlackViewMiddlewareArgs['body']).view :
          (type === IncomingEventType.Action &&
            isBlockActionOrInteractiveMessageBody(bodyArg as SlackActionMiddlewareArgs['body'])) ?
            (bodyArg as SlackActionMiddlewareArgs<BlockAction | InteractiveMessage>['body']).actions[0] :
            (bodyArg as (
              Exclude<AnyMiddlewareArgs, SlackEventMiddlewareArgs | SlackActionMiddlewareArgs | SlackViewMiddlewareArgs> |
              SlackActionMiddlewareArgs<Exclude<SlackAction, BlockAction | InteractiveMessage>>
            )['body']),
  };
}

export function setupAliases(listenerArgs: Pick<AnyMiddlewareArgs, 'body' | 'payload'> & {
  say?: SayFn
  respond?: RespondFn,
}, type: IncomingEventType) {
  if (type === IncomingEventType.Event) {
    const eventListenerArgs = listenerArgs as SlackEventMiddlewareArgs;
    eventListenerArgs.event = eventListenerArgs.payload;
    if (eventListenerArgs.event.type === 'message') {
      const messageEventListenerArgs = eventListenerArgs as SlackEventMiddlewareArgs<'message'>;
      messageEventListenerArgs.message = messageEventListenerArgs.payload;
    }
  } else if (type === IncomingEventType.Action) {
    const actionListenerArgs = listenerArgs as SlackActionMiddlewareArgs;
    actionListenerArgs.action = actionListenerArgs.payload;
  } else if (type === IncomingEventType.Command) {
    const commandListenerArgs = listenerArgs as SlackCommandMiddlewareArgs;
    commandListenerArgs.command = commandListenerArgs.payload;
  } else if (type === IncomingEventType.Options) {
    const optionListenerArgs = listenerArgs as SlackOptionsMiddlewareArgs<OptionsSource>;
    optionListenerArgs.options = optionListenerArgs.payload;
  } else if (type === IncomingEventType.ViewAction) {
    const viewListenerArgs = listenerArgs as SlackViewMiddlewareArgs;
    viewListenerArgs.view = viewListenerArgs.payload;
  }
}

export function buildSource(
  type: IncomingEventType,
  channelId: string | undefined,
  body: AnyMiddlewareArgs['body'],
): AuthorizeSourceData {
  // NOTE: potentially something that can be optimized, so that each of these conditions isn't evaluated more than once.
  // if this makes it prettier, great! but we should probably check perf before committing to any specific optimization.

  // tslint:disable:max-line-length
  const source: AuthorizeSourceData = {
    teamId:
      ((type === IncomingEventType.Event || type === IncomingEventType.Command) ? (body as (SlackEventMiddlewareArgs | SlackCommandMiddlewareArgs)['body']).team_id as string :
        (type === IncomingEventType.Action || type === IncomingEventType.Options || type === IncomingEventType.ViewAction) ? (body as (SlackActionMiddlewareArgs | SlackOptionsMiddlewareArgs | SlackViewMiddlewareArgs)['body']).team.id as string :
          assertNever(type)),
    enterpriseId:
      ((type === IncomingEventType.Event || type === IncomingEventType.Command) ? (body as (SlackEventMiddlewareArgs | SlackCommandMiddlewareArgs)['body']).enterprise_id as string :
        (type === IncomingEventType.Action || type === IncomingEventType.Options || type === IncomingEventType.ViewAction) ? (body as (SlackActionMiddlewareArgs | SlackOptionsMiddlewareArgs | SlackViewMiddlewareArgs)['body']).team.enterprise_id as string :
          undefined),
    userId:
      ((type === IncomingEventType.Event) ?
        ((typeof (body as SlackEventMiddlewareArgs['body']).event.user === 'string') ? (body as SlackEventMiddlewareArgs['body']).event.user as string :
          (typeof (body as SlackEventMiddlewareArgs['body']).event.user === 'object') ? (body as SlackEventMiddlewareArgs['body']).event.user.id as string :
            ((body as SlackEventMiddlewareArgs['body']).event.channel !== undefined && (body as SlackEventMiddlewareArgs['body']).event.channel.creator !== undefined) ? (body as SlackEventMiddlewareArgs['body']).event.channel.creator as string :
              ((body as SlackEventMiddlewareArgs['body']).event.subteam !== undefined && (body as SlackEventMiddlewareArgs['body']).event.subteam.created_by !== undefined) ? (body as SlackEventMiddlewareArgs['body']).event.subteam.created_by as string :
                undefined) :
        (type === IncomingEventType.Action || type === IncomingEventType.Options || type === IncomingEventType.ViewAction) ? (body as (SlackActionMiddlewareArgs | SlackOptionsMiddlewareArgs | SlackViewMiddlewareArgs)['body']).user.id as string :
          (type === IncomingEventType.Command) ? (body as SlackCommandMiddlewareArgs['body']).user_id as string :
            undefined),
    conversationId: channelId,
  };
  // tslint:enable:max-line-length

  return source;
}

export function createSay(
  channelId: string,
  context: Context,
  client: WebClient,
  onGlobalError: (Error) => void
): SayFn {
  const token = context.botToken !== undefined ? context.botToken : context.userToken;
  return (message: Parameters<SayFn>[0]) => {
    const postMessageArguments: ChatPostMessageArguments =
      (typeof message === 'string') ? { token, text: message, channel: channelId }
        : { ...message, token, channel: channelId };
    const postMessageResult: Promise<WebAPICallResult> = client.chat.postMessage(postMessageArguments)
      .catch(error => {
        onGlobalError(error);
        return error;
      });
    return postMessageResult;
  };
}

export const tokenUsageGuideMessage = 'Apps used in one workspace should be initialized with a token. ' +
  'Apps used in many workspaces should be initialized with a authorize.';

