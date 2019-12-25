import { Context, Middleware } from '../changed/utilities';

export interface PromiseMiddleware<Args> {
  (args: Args & { context: Context; }): Promise<any>;
}

export interface AckDef<Args, AsyncArgs> {
  ack(...middleware: Middleware<Args>[]): ThenDef<AsyncArgs>;
}

export interface ThenDef<Args> {
  then(middleware: PromiseMiddleware<Args>): void;
}