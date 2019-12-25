import { Middleware, SlackEventMiddlewareArgs } from '../../changed/utilities';
import util from 'util';
import { matchMessage } from '@slack/bolt/dist/middleware/builtin';

export function createMessageMiddleware(
  patternsOrMiddleware: (string | RegExp | Middleware<SlackEventMiddlewareArgs<'message'>>)[]) {
  return patternsOrMiddleware.map((patternOrMiddleware) => {
    if (typeof patternOrMiddleware === 'string' || util.types.isRegExp(patternOrMiddleware)) {
      return matchMessage(patternOrMiddleware);
    }
    return patternOrMiddleware;
  });
}
