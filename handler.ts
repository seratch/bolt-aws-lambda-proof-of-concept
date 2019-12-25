// cp _env .env - then modify it
// see https://github.com/motdotla/dotenv
const config = require('dotenv').config().parsed;
for (const k in config) {
  process.env[k] = config[k];
}
import { AwsLambdaReceiver } from './src/added/AwsLambdaReceiver';
import { TwoPhaseApp } from './src/added/TwoPhaseApp';
import { sleep } from './src/added/app/helpers';

const app = new TwoPhaseApp({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: new AwsLambdaReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET
  })
});

app.event('app_mention').then(async ({ event }) => {
  app.logger.info(event);
})

app.message('hello', ({ say }) => {
  say("Hi there!");
});

app.command('/lambda')
  .ack(({ ack }) => {
    app.logger.info('ack log');
    ack('ack response');
  })
  .then(async ({ body, say }) => {
    app.logger.info("You are here after the acknowledgement...");
    await sleep(3000);

    const sleeping = async () => {
      let totalMillis = 0;
      app.logger.info(body);
      while (totalMillis < 3000) { // sleep for 5 seconds
        totalMillis += 500;
        await sleep(500);
        app.logger.info('Sleeping...');
      }
      return "done";
    };

    return say('How are you?')
      .then(sleeping)
      .then(str => {
        app.logger.info(str);
        return say("I'm good!");
      });
  });

export const main = app.receiver().toHandler();