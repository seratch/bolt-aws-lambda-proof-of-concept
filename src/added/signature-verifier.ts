import crypto from 'crypto';
import tsscmp from 'tsscmp';

export function isValidRequestSignature(
  signingSecret: string,
  body: string,
  signature: string,
  requestTimestamp: number
): boolean {

  if (!signature || !requestTimestamp) {
    return false;
  }

  // Divide current date to match Slack ts format
  // Subtract 5 minutes from current time
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);
  if (requestTimestamp < fiveMinutesAgo) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', signingSecret);
  const [version, hash] = signature.split('=');
  hmac.update(`${version}:${requestTimestamp}:${body}`);
  if (!tsscmp(hash, hmac.digest('hex'))) {
    return false;
  }

  return true;
}
