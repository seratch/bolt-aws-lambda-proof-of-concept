import { errorWithCode, ErrorCode, CodedError } from '@slack/bolt/dist/errors';
import { WebClient } from '@slack/web-api';
import { AuthorizeResult, Authorize } from '@slack/bolt/dist/App';

export interface AuthorizationError extends CodedError {
  code: ErrorCode.AuthorizationError;
  original: Error;
}

export function authorizationErrorFromOriginal(original: Error): AuthorizationError {
  const error = errorWithCode('Authorization of incoming event did not succeed.', ErrorCode.AuthorizationError);
  (error as AuthorizationError).original = original;
  return error as AuthorizationError;
}

export function singleTeamAuthorization(
  client: WebClient,
  authorization: Partial<AuthorizeResult> & { botToken: Required<AuthorizeResult>['botToken'] },
): Authorize {
  // TODO: warn when something needed isn't found
  const botUserId: Promise<string> = authorization.botUserId !== undefined ?
    Promise.resolve(authorization.botUserId) :
    client.auth.test({ token: authorization.botToken })
      .then(result => result.user_id as string);
  const botId: Promise<string> = authorization.botId !== undefined ?
    Promise.resolve(authorization.botId) :
    botUserId.then(id => client.users.info({ token: authorization.botToken, user: id }))
      .then(result => ((result.user as any).profile.bot_id as string));
  return async () => ({
    botToken: authorization.botToken,
    botId: await botId,
    botUserId: await botUserId,
  });
}
