import { EventEmitter } from 'events';
import { ReceiverEvent } from '@slack/bolt/dist/types';
import { Logger, ConsoleLogger } from '@slack/logger';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { Agent } from 'http';
import { SecureContextOptions } from 'tls';
import { sleep, receiverAckTimeoutError } from './app/helpers';

import * as AWS from 'aws-sdk';
import { TwoPhaseReceiver, AsyncReceiverEvent } from './receiver';
import { parseRequestBody } from './requset-body-parser';
import { isValidRequestSignature } from './signature-verifier';
import {
  APIGatewayProxyHandler,
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
  Callback
} from 'aws-lambda';

export interface AwsLambdaReceiverOptions {
  signingSecret: string;
  logger?: Logger;
  agent?: Agent;
  clientTls?: Pick<SecureContextOptions, 'pfx' | 'key' | 'passphrase' | 'cert' | 'ca'>;
}

export class AwsLambdaReceiver extends EventEmitter implements TwoPhaseReceiver {

  private signingSecret: string;
  private logger: Logger;
  private axios: AxiosInstance;

  constructor({
    signingSecret,
    logger = new ConsoleLogger(),
    agent = undefined,
    clientTls = undefined,
  }: AwsLambdaReceiverOptions) {
    super();
    this.signingSecret = signingSecret;
    this.logger = logger;
    this.axios = axios.create(Object.assign(
      {
        httpAgent: agent,
        httpsAgent: agent,
      },
      clientTls,
    ));
  }

  public async start(): Promise<APIGatewayProxyHandler> {
    return new Promise((resolve, reject) => {
      try {
        const handler = this.toHandler();
        resolve(handler);
      } catch (error) {
        reject(error);
      }
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve, _reject) => {
      resolve();
    });
  }

  public toHandler(): APIGatewayProxyHandler {
    return async (
      event: APIGatewayProxyEvent,
      context: Context,
      _callback: Callback<APIGatewayProxyResult>): Promise<APIGatewayProxyResult> => {

      this.logger.debug(event);

      const functionName = context.functionName;
      const awsRequestId = event.requestContext.requestId;

      const rawBody: string = event.body;

      if (event.httpMethod === 'none') {
        // -------------------------------------------
        // Behave as AsyncReceiver here
        // -------------------------------------------
        // internal async invocation
        const parsedBody: any = JSON.parse(rawBody);
        const asyncAwsRequestId = awsRequestId + "-async";
        parsedBody.awsRequestId = asyncAwsRequestId;
        return this.runAsyncInvocation(parsedBody, asyncAwsRequestId);
      }

      const originalParsedBody: any = parseRequestBody(rawBody, event.headers['Content-Type'], this.logger);

      // ssl_check (for Slash Commands)
      if (originalParsedBody && originalParsedBody.ssl_check) {
        return Promise.resolve({ statusCode: 200, body: '' });
      }

      // request signature verification
      const signature = event.headers['X-Slack-Signature'] as string;
      const ts = Number(event.headers['X-Slack-Request-Timestamp']);
      if (!isValidRequestSignature(this.signingSecret, rawBody, signature, ts)) {
        return Promise.resolve({ statusCode: 401, body: '' });
      }

      // url_verification (Events API)
      if (originalParsedBody && originalParsedBody.type && originalParsedBody.type === 'url_verification') {
        return Promise.resolve({
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 'challenge': originalParsedBody.challenge })
        });
      }

      // -------------------------------------------
      // Behave as Receiver here
      // -------------------------------------------
      let timer: NodeJS.Timer | undefined = setTimeout(
        () => {
          this.emit('error', receiverAckTimeoutError(
            'An incoming event was not acknowledged before the timeout. ' +
            'Ensure that the ack() argument is called in your listeners.',
          ));
          timer = undefined;
        },
        2800,
      );
      let acknowledged: Promise<APIGatewayProxyResult> = null;
      const receiverEvent: ReceiverEvent = {
        body: originalParsedBody as { [key: string]: any },
        ack: (response: any): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
            if (!response) {
              acknowledged = Promise.resolve({ statusCode: 200, body: '' });
            } else if (typeof response === 'string') {
              acknowledged = Promise.resolve({ statusCode: 200, body: response });
            } else {
              acknowledged = Promise.resolve({ statusCode: 200, body: JSON.stringify(response) });
            }
          }
        },
        respond: undefined,
      };
      this.emit('message', receiverEvent);

      const modifiedBody: any = parseRequestBody(rawBody, event.headers['Content-Type'], this.logger);
      modifiedBody.awsRequestId = awsRequestId;
      let modifiedEvent = JSON.parse(JSON.stringify(event));
      modifiedEvent.body = JSON.stringify(modifiedBody);
      modifiedEvent.httpMethod = 'none'; // mark as an internal request

      let errorDetected = false;
      this.on('error', (event) => {
        if (event.body && event.body.awsRequestId === awsRequestId) {
          errorDetected = true;
        }
      });

      const interval = 50;
      let totalMillis = 0;
      function sleep(millis: number) {
        return new Promise(resolve => setTimeout(resolve, millis));
      }
      while (acknowledged == null && totalMillis < 2800) { // 3 seconds - slack timeout
        totalMillis += interval;
        await sleep(interval);
      }

      if (errorDetected) {
        return Promise.resolve({ statusCode: 500, body: '' });
      } else if (acknowledged) {
        // TODO: can be better later
        if (process.env.IS_OFFLINE === 'true') { // serverless-offline
          this.runAsyncInvocation(modifiedBody, awsRequestId);
        } else {
          // invoke main lambda function
          const lambda = new AWS.Lambda();
          const params: AWS.Lambda.InvocationRequest = {
            InvocationType: 'Event', // async invocation
            FunctionName: functionName,
            Payload: JSON.stringify(modifiedEvent)
          };
          const response = await lambda.invoke(params).promise();
          this.logger.debug(`AWS lambda invocation result: ${response}`);
        }
        return acknowledged;

      } else {
        return Promise.resolve({ statusCode: 500, body: 'timed out' });
      }
    };
  }

  // -------------------------------------------
  // Behave as AsyncReceiver here
  // -------------------------------------------
  private async runAsyncInvocation(parsedBody: any, awsRequestId: string): Promise<APIGatewayProxyResult> {
    const receiverEvent: AsyncReceiverEvent = {
      body: parsedBody as { [key: string]: any },
      respond: undefined,
    };
    if (parsedBody && parsedBody.response_url) {
      receiverEvent.respond = (response): Promise<AxiosResponse<string>> => {
        return this.axios
          .post(parsedBody.response_url, response)
          .catch(e => {
            this.emit('error', e);
            return e;
          });
      };
    }
    this.emit('async-message', receiverEvent);

    let completed = false;
    let errorDetected = false;
    this.on('async-completion', (event) => {
      if (!completed && event.body.awsRequestId === awsRequestId) {
        completed = true;
      }
    });

    this.on('error', (event) => {
      if (!completed && event.body && event.body.awsRequestId === awsRequestId) {
        completed = true;
        errorDetected = true;
      }
    });

    const interval = 50;
    let totalMillis = 0;
    // AWS Lambda functions can be configured to run up to 15 minutes per execution.
    while (!completed && totalMillis < 900000) { // 15 min
      totalMillis += interval;
      await sleep(interval);
    }
    if (errorDetected) {
      // TODO: is it really good to return 500?
      return Promise.resolve({ statusCode: 500, body: '' });
    } else {
      return Promise.resolve({ statusCode: 200, body: '' });
    }
  }
}

