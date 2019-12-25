import { Middleware, NextMiddleware, Context, PostProcessFn } from '../changed/utilities';
import { PromiseMiddleware } from './two-phase-dsl';

export function toPromiseMiddleware<Args>(middleware: Middleware<Args>): PromiseMiddleware<Args> {

  return async (args: Args): Promise<any> => {
    let result: Promise<string> = null;
    const next: NextMiddleware = function (_errorOrPostProcess?: (Error | PostProcessFn)) {
      result = Promise.resolve('next called');
    }
    const middlewareArgs: Args & { next: NextMiddleware, context: Context } = {
      ...args,
      next,
      context: args['context'] as Context
    };
    await middleware(middlewareArgs);
    if (result == null) {
      // TODO: error with code
      result = Promise.reject('discontinued');
    }
    return result;
  };
}