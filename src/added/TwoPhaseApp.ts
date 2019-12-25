import { WebClient } from '@slack/web-api';
import { Logger, LogLevel, ConsoleLogger } from '@slack/logger';
import { Context, Receiver, SlackAction, } from '@slack/bolt/dist/types';
import { IncomingEventType, getTypeAndConversation } from '@slack/bolt/dist/helpers';
import { ErrorCode, errorWithCode, asCodedError } from '@slack/bolt/dist/errors';
import { Authorize, ErrorHandler } from '@slack/bolt/dist/App';
import { App, AppOptions, ActionConstraints, ViewConstraints } from '../changed/App';
import { PromiseMiddleware, AckDef, ThenDef } from './two-phase-dsl';
import { CommandAckDefinition, CommandArgs, CommandAsyncArgs } from './two-phase-dsl/command';
import { TwoPhaseReceiver, AsyncReceiverEvent } from './receiver';
import { setupAliases, buildListenerArgs, buildSource, createSay, defaultErrorHandler, tokenUsageGuideMessage, validViewTypes } from './app/helpers';
import { authorizationErrorFromOriginal, singleTeamAuthorization } from './app/authorize-helpers';
import { AnyMiddlewareArgs, Middleware, SlackEventMiddlewareArgs, SlackActionMiddlewareArgs } from '../changed/utilities';
import util from 'util';
import { onlyEvents } from '@slack/bolt/dist/middleware/builtin';
import { OptionsSource, SlackOptionsMiddlewareArgs } from '../unchanged/options';
import { SlackViewAction, SlackViewMiddlewareArgs } from '../unchanged/view';
import { EventThenDefinition } from './two-phase-dsl/events';
import { matchMessage, matchEventType, onlyActions, matchConstraints, onlyOptions, onlyViewActions } from '@slack/bolt/dist/middleware/builtin';
import { toPromiseMiddleware } from './primise-middleware';

export interface TwoPhaseAppOptions<R extends Receiver & TwoPhaseReceiver> extends AppOptions {
  receiver: R;
}

export class TwoPhaseApp<R extends Receiver & TwoPhaseReceiver> {

  public phase1App: App;
  public client: WebClient;

  private twoPhaseReceiver: R;

  public receiver(): R {
    return this.twoPhaseReceiver;
  }

  // Proposal
  // I believe it's okay to make app.logger public
  public logger: Logger;

  private authorize: Authorize;
  private errorHandler: ErrorHandler;

  // expose to the same dir
  asyncListeners: PromiseMiddleware<AnyMiddlewareArgs>[][];

  constructor({
    signingSecret = undefined,
    endpoints = undefined,
    agent = undefined,
    clientTls = undefined,
    receiver = undefined,
    token = undefined,
    botId = undefined,
    botUserId = undefined,
    authorize = undefined,
    logger = new ConsoleLogger(),
    logLevel = LogLevel.INFO,
    clientOptions = undefined,
  }: TwoPhaseAppOptions<R>) {

    this.logger = logger;
    this.logger.setLevel(logLevel);
    this.errorHandler = defaultErrorHandler(this.logger);

    this.phase1App = new App({
      signingSecret,
      endpoints,
      agent,
      clientTls,
      receiver,
      token,
      botId,
      botUserId,
      authorize,
      logger,
      logLevel,
      clientOptions,
    });

    this.client = new WebClient(undefined, {
      agent,
      logLevel,
      logger,
      tls: clientTls,
      slackApiUrl: clientOptions !== undefined ? clientOptions.slackApiUrl : undefined,
    });

    if (token !== undefined) {
      if (authorize !== undefined) {
        throw errorWithCode(
          `Both token and authorize options provided. ${tokenUsageGuideMessage}`,
          ErrorCode.AppInitializationError,
        );
      }
      this.authorize = singleTeamAuthorization(this.client, { botId, botUserId, botToken: token });
    } else if (authorize === undefined) {
      throw errorWithCode(
        `No token and no authorize options provided. ${tokenUsageGuideMessage}`,
        ErrorCode.AppInitializationError,
      );
    } else {
      this.authorize = authorize;
    }

    this.asyncListeners = [];

    if (receiver !== undefined) {
      this.twoPhaseReceiver = receiver;
    } else {
      // TODO: better error message
      throw errorWithCode('TwoPhaseReceiver not found', ErrorCode.AppInitializationError);
    }

    this.twoPhaseReceiver.on('async-message', message => {
      this.onIncomingEvent(message)
        .then(() => this.twoPhaseReceiver.emit('async-completion', message));
    });
    this.twoPhaseReceiver.on('error', error => this.onGlobalError(error));
  }

  // ---------------------------------------------------------------------------------------------

  public start(...args: any[]): Promise<unknown> {
    return this.phase1App.start(...args);
  }

  public stop(...args: any[]): Promise<unknown> {
    return this.phase1App.stop(...args);
  }

  public use(m: Middleware<AnyMiddlewareArgs>): this {
    this.phase1App.use(m);
    return this;
  }

  public command(commandName: string): AckDef<CommandArgs, CommandAsyncArgs> {
    return new CommandAckDefinition(commandName, this);
  }

  public event<EventType extends string = string>(eventType: EventType): ThenDef<SlackEventMiddlewareArgs> {
    return new EventThenDefinition(eventType, this);
  }

  public message(...listeners: Middleware<SlackEventMiddlewareArgs<'message'>>[]): void;
  public message(pattern: string | RegExp, ...listeners: Middleware<SlackEventMiddlewareArgs<'message'>>[]): void;
  public message(
    ...patternsOrMiddleware: (string | RegExp | Middleware<SlackEventMiddlewareArgs<'message'>>)[]
  ): void {
    const messageMiddleware: PromiseMiddleware<SlackEventMiddlewareArgs<'message'>>[] =
      patternsOrMiddleware.map((patternOrMiddleware) => {
        if (typeof patternOrMiddleware === 'string' || util.types.isRegExp(patternOrMiddleware)) {
          return toPromiseMiddleware(matchMessage(patternOrMiddleware));
        }
        return toPromiseMiddleware(patternOrMiddleware);
      });
    this.asyncListeners.push(
      [
        toPromiseMiddleware(onlyEvents),
        toPromiseMiddleware(matchEventType('message')),
        ...messageMiddleware
      ] as PromiseMiddleware<AnyMiddlewareArgs>[],
    );
  }

  public action<ActionType extends SlackAction = SlackAction>(
    actionId: string | RegExp,
    ...listeners: PromiseMiddleware<SlackActionMiddlewareArgs<ActionType>>[]
  ): void;
  public action<ActionType extends SlackAction = SlackAction>(
    constraints: ActionConstraints,
    ...listeners: PromiseMiddleware<SlackActionMiddlewareArgs<ActionType>>[]
  ): void;
  public action<ActionType extends SlackAction = SlackAction>(
    actionIdOrConstraints: string | RegExp | ActionConstraints,
    ...listeners: PromiseMiddleware<SlackActionMiddlewareArgs<ActionType>>[]
  ): void {
    const constraints: ActionConstraints =
      (typeof actionIdOrConstraints === 'string' || util.types.isRegExp(actionIdOrConstraints)) ?
        { action_id: actionIdOrConstraints } : actionIdOrConstraints;

    // Fail early if the constraints contain invalid keys
    const unknownConstraintKeys = Object.keys(constraints)
      .filter(k => (k !== 'action_id' && k !== 'block_id' && k !== 'callback_id'));
    if (unknownConstraintKeys.length > 0) {
      this.logger.error(
        `Action listener cannot be attached using unknown constraint keys: ${unknownConstraintKeys.join(', ')}`,
      );
      return;
    }

    this.asyncListeners.push(
      [
        toPromiseMiddleware(onlyActions),
        toPromiseMiddleware(matchConstraints(constraints)),
        ...listeners
      ] as PromiseMiddleware<AnyMiddlewareArgs>[],
    );
  }

  public options<Source extends OptionsSource = OptionsSource>(
    actionId: string | RegExp,
    ...listeners: PromiseMiddleware<SlackOptionsMiddlewareArgs<Source>>[]
  ): void;
  public options<Source extends OptionsSource = OptionsSource>(
    constraints: ActionConstraints,
    ...listeners: PromiseMiddleware<SlackOptionsMiddlewareArgs<Source>>[]
  ): void;
  public options<Source extends OptionsSource = OptionsSource>(
    actionIdOrConstraints: string | RegExp | ActionConstraints,
    ...listeners: PromiseMiddleware<SlackOptionsMiddlewareArgs<Source>>[]
  ): void {
    const constraints: ActionConstraints =
      (typeof actionIdOrConstraints === 'string' || util.types.isRegExp(actionIdOrConstraints)) ?
        { action_id: actionIdOrConstraints } : actionIdOrConstraints;

    this.asyncListeners.push(
      [
        toPromiseMiddleware(onlyOptions),
        toPromiseMiddleware(matchConstraints(constraints)),
        ...listeners
      ] as PromiseMiddleware<AnyMiddlewareArgs>[],
    );
  }

  public view<ViewActionType extends SlackViewAction = SlackViewAction>(
    callbackId: string | RegExp,
    ...listeners: Middleware<SlackViewMiddlewareArgs<ViewActionType>>[]
  ): void;
  public view<ViewActionType extends SlackViewAction = SlackViewAction>(
    constraints: ViewConstraints,
    ...listeners: Middleware<SlackViewMiddlewareArgs<ViewActionType>>[]
  ): void;
  public view<ViewActionType extends SlackViewAction = SlackViewAction>(
    callbackIdOrConstraints: string | RegExp | ViewConstraints,
    ...listeners: Middleware<SlackViewMiddlewareArgs<ViewActionType>>[]): void {
    const constraints: ViewConstraints =
      (typeof callbackIdOrConstraints === 'string' || util.types.isRegExp(callbackIdOrConstraints)) ?
        { callback_id: callbackIdOrConstraints, type: 'view_submission' } : callbackIdOrConstraints;
    const unknownConstraintKeys = Object.keys(constraints)
      .filter(k => (k !== 'callback_id' && k !== 'type'));
    if (unknownConstraintKeys.length > 0) {
      this.logger.error(
        `View listener cannot be attached using unknown constraint keys: ${unknownConstraintKeys.join(', ')}`,
      );
      return;
    }
    if (constraints.type !== undefined && !validViewTypes.includes(constraints.type)) {
      this.logger.error(
        `View listener cannot be attached using unknown view event type: ${constraints.type}`,
      );
      return;
    }
    this.asyncListeners.push(
      [
        toPromiseMiddleware(onlyViewActions),
        toPromiseMiddleware(matchConstraints(constraints))
        , ...listeners
      ] as PromiseMiddleware<AnyMiddlewareArgs>[],
    );
  }

  public error(errorHandler: ErrorHandler): void {
    this.errorHandler = errorHandler;
  }

  // ---------------------------------------------------------------------------------------------

  private async onIncomingEvent({ body, respond }: AsyncReceiverEvent): Promise<void> {
    const { type, conversationId } = getTypeAndConversation(body);
    if (type === undefined) {
      this.logger.warn('Could not determine the type of an incoming event. No listeners will be called.');
      return;
    }
    const bodyArg = body as AnyMiddlewareArgs['body'];
    const source = buildSource(type, conversationId, bodyArg);
    const authorizeResult = await (this.authorize(source, bodyArg).catch((error) => {
      this.onGlobalError(authorizationErrorFromOriginal(error));
    }));
    if (authorizeResult === undefined) {
      this.logger.warn('Authorization of incoming event did not succeed. No listeners will be called.');
      return;
    }
    const context: Context = { ...authorizeResult };

    const listenerArgs = buildListenerArgs(bodyArg, type);
    setupAliases(listenerArgs, type);
    if (conversationId !== undefined && type !== IncomingEventType.Options) {
      listenerArgs.say = createSay(conversationId, context, this.client, this.onGlobalError);
    }
    if (respond !== undefined) {
      listenerArgs.respond = respond;
    }
    for (const listeners of this.asyncListeners) {
      const lastIdx = listeners.length - 1;
      for (const [idx, asyncListener] of listeners.entries()) {
        try {
          if (idx === lastIdx) {
            return asyncListener({ context, ...listenerArgs as AnyMiddlewareArgs });
          } else {
            const result = await asyncListener({ context, ...listenerArgs as AnyMiddlewareArgs });
            this.logger.debug(`AsyncListener[${idx}]'s result: ${result}`);
          }
        } catch (e) {
          // TODO: error with code
          if (e === 'discontinued') {
            break;
          } else {
            return Promise.reject(e);
          }
        }
      }
    }
    // TODO: what to do here
    return Promise.resolve();
  }

  private onGlobalError(error: Error): void {
    this.errorHandler(asCodedError(error));
  }
}
