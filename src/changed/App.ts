import util from 'util';
import { WebClient, addAppMetadata, WebClientOptions } from '@slack/web-api';
import { Logger, LogLevel, ConsoleLogger } from '@slack/logger';
import ExpressReceiver, { ExpressReceiverOptions } from '@slack/bolt/dist/ExpressReceiver';
import {
  ignoreSelf as ignoreSelfMiddleware,
  onlyActions,
  matchConstraints,
  onlyCommands,
  matchCommandName,
  onlyOptions,
  onlyEvents,
  matchEventType,
  matchMessage,
  onlyViewActions,
} from '@slack/bolt/dist/middleware/builtin';
import { processMiddleware } from '@slack/bolt/dist/middleware/process';
import { ConversationStore, conversationContext, MemoryStore } from '@slack/bolt/dist/conversation-store';
import {
  Middleware,
  AnyMiddlewareArgs,
  SlackActionMiddlewareArgs,
  SlackCommandMiddlewareArgs,
  SlackEventMiddlewareArgs,
  SlackOptionsMiddlewareArgs,
  SlackViewMiddlewareArgs,
  SlackAction,
  Context,
  OptionsSource,
  SlackViewAction,
} from '@slack/bolt/dist/types';
import { IncomingEventType, getTypeAndConversation } from '@slack/bolt/dist/helpers';
import { ErrorCode, CodedError, errorWithCode, asCodedError } from '@slack/bolt/dist/errors';
import { Receiver, ReceiverEvent } from '../unchanged/receiver';
import { buildListenerArgs, setupAliases, buildSource, createSay, defaultErrorHandler, tokenUsageGuideMessage, validViewTypes } from '../added/app/helpers';
import { authorizationErrorFromOriginal, singleTeamAuthorization } from '../added/app/authorize-helpers';

const packageJson = require('../../package.json'); // tslint:disable-line:no-require-imports no-var-requires

export interface Authorize {
  (
    source: AuthorizeSourceData,
    body: ReceiverEvent['body'],
  ): Promise<AuthorizeResult>;
}

export interface AuthorizeSourceData {
  teamId: string;
  enterpriseId?: string;
  userId?: string;
  conversationId?: string;
}

export interface AuthorizeResult {
  // one of either botToken or userToken are required
  botToken?: string; // used by `say` (preferred over userToken)
  userToken?: string; // used by `say` (overridden by botToken)
  botId?: string; // required for `ignoreSelf` global middleware
  botUserId?: string; // optional but allows `ignoreSelf` global middleware be more filter more than just message events
  [key: string]: any;
}

export interface ActionConstraints {
  block_id?: string | RegExp;
  action_id?: string | RegExp;
  callback_id?: string | RegExp;
}

export interface ViewConstraints {
  callback_id?: string | RegExp;
  type?: 'view_closed' | 'view_submission';
}

export interface ErrorHandler {
  (error: CodedError): void;
}

export interface AppOptions {
  signingSecret?: ExpressReceiverOptions['signingSecret'];
  endpoints?: ExpressReceiverOptions['endpoints'];
  agent?: ExpressReceiverOptions['agent']; // also WebClientOptions['agent']
  clientTls?: ExpressReceiverOptions['clientTls']; // also WebClientOptions['tls']
  convoStore?: ConversationStore | false;
  token?: AuthorizeResult['botToken']; // either token or authorize
  botId?: AuthorizeResult['botId']; // only used when authorize is not defined, shortcut for fetching
  botUserId?: AuthorizeResult['botUserId']; // only used when authorize is not defined, shortcut for fetching
  authorize?: Authorize; // either token or authorize
  receiver?: Receiver;
  logger?: Logger;
  logLevel?: LogLevel;
  ignoreSelf?: boolean;
  clientOptions?: Pick<WebClientOptions, 'slackApiUrl'>;
}

export class App {

  public client: WebClient;
  private receiver: Receiver;
  private logger: Logger;
  private authorize: Authorize;
  private middleware: Middleware<AnyMiddlewareArgs>[];
  private listeners: Middleware<AnyMiddlewareArgs>[][];
  private errorHandler: ErrorHandler;

  constructor({
    signingSecret = undefined,
    endpoints = undefined,
    agent = undefined,
    clientTls = undefined,
    receiver = undefined,
    convoStore = undefined,
    token = undefined,
    botId = undefined,
    botUserId = undefined,
    authorize = undefined,
    logger = new ConsoleLogger(),
    logLevel = LogLevel.INFO,
    ignoreSelf = true,
    clientOptions = undefined,
  }: AppOptions = {}) {

    this.logger = logger;
    this.logger.setLevel(logLevel);
    this.errorHandler = defaultErrorHandler(this.logger);

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

    this.middleware = [];
    this.listeners = [];

    if (receiver !== undefined) {
      this.receiver = receiver;
    } else {
      if (signingSecret === undefined) {
        throw errorWithCode(
          'Signing secret not found, so could not initialize the default receiver. Set a signing secret or use a ' +
          'custom receiver.',
          ErrorCode.AppInitializationError,
        );
      } else {
        this.receiver = new ExpressReceiver({ signingSecret, logger, endpoints, agent, clientTls });
      }
    }

    this.receiver.on('message', message => {
      this.onIncomingEvent(message);
    });
    this.receiver.on('error', error => this.onGlobalError(error));
    if (ignoreSelf) {
      this.use(ignoreSelfMiddleware());
    }
    if (convoStore !== false) {
      const store: ConversationStore = convoStore === undefined ? new MemoryStore() : convoStore;
      this.use(conversationContext(store, this.logger));
    }
  }

  // ---------------------------------------------------------------------------------------------

  public use(m: Middleware<AnyMiddlewareArgs>): this {
    this.middleware.push(m);
    return this;
  }

  public start(...args: any[]): Promise<unknown> {
    return this.receiver.start(...args);
  }

  public stop(...args: any[]): Promise<unknown> {
    return this.receiver.stop(...args);
  }

  public event<EventType extends string = string>(
    eventName: EventType,
    ...listeners: Middleware<SlackEventMiddlewareArgs<EventType>>[]
  ): void {
    this.listeners.push(
      [onlyEvents, matchEventType(eventName), ...listeners] as Middleware<AnyMiddlewareArgs>[],
    );
  }

  public message(...listeners: Middleware<SlackEventMiddlewareArgs<'message'>>[]): void;
  public message(pattern: string | RegExp, ...listeners: Middleware<SlackEventMiddlewareArgs<'message'>>[]): void;
  public message(
    ...patternsOrMiddleware: (string | RegExp | Middleware<SlackEventMiddlewareArgs<'message'>>)[]
  ): void {
    const messageMiddleware = patternsOrMiddleware.map((patternOrMiddleware) => {
      if (typeof patternOrMiddleware === 'string' || util.types.isRegExp(patternOrMiddleware)) {
        return matchMessage(patternOrMiddleware);
      }
      return patternOrMiddleware;
    });

    this.listeners.push(
      [onlyEvents, matchEventType('message'), ...messageMiddleware] as Middleware<AnyMiddlewareArgs>[],
    );
  }

  public action<ActionType extends SlackAction = SlackAction>(
    actionId: string | RegExp,
    ...listeners: Middleware<SlackActionMiddlewareArgs<ActionType>>[]
  ): void;
  public action<ActionType extends SlackAction = SlackAction>(
    constraints: ActionConstraints,
    ...listeners: Middleware<SlackActionMiddlewareArgs<ActionType>>[]
  ): void;
  public action<ActionType extends SlackAction = SlackAction>(
    actionIdOrConstraints: string | RegExp | ActionConstraints,
    ...listeners: Middleware<SlackActionMiddlewareArgs<ActionType>>[]
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

    this.listeners.push(
      [onlyActions, matchConstraints(constraints), ...listeners] as Middleware<AnyMiddlewareArgs>[],
    );
  }

  public command(commandName: string, ...listeners: Middleware<SlackCommandMiddlewareArgs>[]): void {
    this.listeners.push(
      [onlyCommands, matchCommandName(commandName), ...listeners] as Middleware<AnyMiddlewareArgs>[],
    );
  }

  public options<Source extends OptionsSource = OptionsSource>(
    actionId: string | RegExp,
    ...listeners: Middleware<SlackOptionsMiddlewareArgs<Source>>[]
  ): void;
  public options<Source extends OptionsSource = OptionsSource>(
    constraints: ActionConstraints,
    ...listeners: Middleware<SlackOptionsMiddlewareArgs<Source>>[]
  ): void;
  public options<Source extends OptionsSource = OptionsSource>(
    actionIdOrConstraints: string | RegExp | ActionConstraints,
    ...listeners: Middleware<SlackOptionsMiddlewareArgs<Source>>[]
  ): void {
    const constraints: ActionConstraints =
      (typeof actionIdOrConstraints === 'string' || util.types.isRegExp(actionIdOrConstraints)) ?
        { action_id: actionIdOrConstraints } : actionIdOrConstraints;

    this.listeners.push(
      [onlyOptions, matchConstraints(constraints), ...listeners] as Middleware<AnyMiddlewareArgs>[],
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
    this.listeners.push(
      [onlyViewActions, matchConstraints(constraints), ...listeners] as Middleware<AnyMiddlewareArgs>[],
    );
  }

  public error(errorHandler: ErrorHandler): void {
    this.errorHandler = errorHandler;
  }

  // ---------------------------------------------------------------------------------------------

  private async onIncomingEvent({ body, ack, respond }: ReceiverEvent): Promise<void> {
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
    if (type !== IncomingEventType.Event) {
      listenerArgs.ack = ack;
    } else {
      ack();
    }
    processMiddleware(
      listenerArgs as AnyMiddlewareArgs,
      this.middleware,
      (globalProcessedContext: Context, globalProcessedArgs: AnyMiddlewareArgs, startGlobalBubble) => {
        this.listeners.forEach((listenerMiddleware) => {
          processMiddleware(
            globalProcessedArgs,
            listenerMiddleware,
            (_listenerProcessedContext, _listenerProcessedArgs, startListenerBubble) => {
              startListenerBubble();
            },
            (error) => {
              startGlobalBubble(error);
            },
            globalProcessedContext,
          );
        });
      },
      (globalError?: CodedError | Error) => {
        if (globalError !== undefined) {
          this.onGlobalError(globalError);
        }
      },
      context,
    );
  }

  private onGlobalError(error: Error): void {
    this.errorHandler(asCodedError(error));
  }
}

addAppMetadata({ name: packageJson.name, version: packageJson.version });