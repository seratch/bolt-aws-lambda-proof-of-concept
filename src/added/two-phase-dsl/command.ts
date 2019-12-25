import { SlashCommand } from '@slack/bolt/dist/types';
import { AckFn, RespondArguments } from '@slack/bolt/dist/types/utilities';
import { SayFn, RespondFn, Middleware, AnyMiddlewareArgs } from '../../changed/utilities';
import { TwoPhaseApp } from '../TwoPhaseApp';
import { AckDef, ThenDef, PromiseMiddleware } from '../two-phase-dsl';
import { toPromiseMiddleware } from '../primise-middleware';
import { onlyCommands, matchCommandName } from '@slack/bolt/dist/middleware/builtin';

export interface CommandArgs {
  payload: SlashCommand;
  command: this['payload'];
  body: this['payload'];
  ack: AckFn<string | RespondArguments>;
}

export interface CommandAsyncArgs {
  payload: SlashCommand;
  command: this['payload'];
  body: this['payload'];
  say: SayFn;
  respond: RespondFn;
}

export class CommandAckDefinition implements AckDef<CommandArgs, CommandAsyncArgs> {
  private commandName: string;
  private app: TwoPhaseApp<any>;
  constructor(commandName: string, app: TwoPhaseApp<any>) {
    this.commandName = commandName;
    this.app = app;
  }
  ack(...middleware: Middleware<CommandArgs>[]): ThenDef<CommandAsyncArgs> {
    this.app.phase1App.command(this.commandName, ...middleware);
    return new CommandThenDefinition(this.commandName, this.app);
  }
}

class CommandThenDefinition implements ThenDef<CommandAsyncArgs> {
  private commandName: string;
  private app: TwoPhaseApp<any>;
  constructor(commandName: string, app: TwoPhaseApp<any>) {
    this.commandName = commandName;
    this.app = app;
  }
  then(listener: PromiseMiddleware<CommandAsyncArgs>): void {
    this.app.asyncListeners.push(
      [
        toPromiseMiddleware(onlyCommands),
        toPromiseMiddleware(matchCommandName(this.commandName)),
        listener
      ] as PromiseMiddleware<AnyMiddlewareArgs>[],
    );
  }
}