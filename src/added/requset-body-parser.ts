import querystring from 'querystring';
import { Logger } from '@slack/logger';

export function parseRequestBody(
  stringBody: string,
  contentType: string | undefined,
  logger: Logger,
): any {
  if (contentType === 'application/x-www-form-urlencoded') {
    const parsedBody = querystring.parse(stringBody);
    if (typeof parsedBody.payload === 'string') {
      return JSON.parse(parsedBody.payload);
    } else {
      return parsedBody;
    }
  } else if (contentType === 'application/json') {
    return JSON.parse(stringBody);
  } else {
    logger.warn(`Unexpected content-type detected: ${contentType}`);
    try {
      // Parse this body anyway
      return JSON.parse(stringBody);
    } catch (e) {
      logger.error(`Failed to parse body as JSON data for content-type: ${contentType}`);
      throw e;
    }
  }
}
