# @slack/bolt-aws-lambda prototype

This repository was created in the aim of demonstrating the possibilities of proper FaaS (AWS Lambda, Google Cloud Functions etc) environment support by Bolt. As of December 2019, there is no plan to merge this implementation into Bolt framework.

## How it works

```ts
import { AwsLambdaReceiver } from './src/added/AwsLambdaReceiver';
import { TwoPhaseApp } from './src/added/TwoPhaseApp';
import { sleep } from './src/added/helpers';

const app = new TwoPhaseApp({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: new AwsLambdaReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET
  })
});

app.command('/lambda')
  .ack(({ ack }) => {
    ack('ack response');
  })
  .then(async ({ body, say }) => {
    app.logger.info("You are here after the acknowledgement...");
    let totalMillis = 0;
    while (totalMillis < 5000) { // sleep for 5 seconds
      totalMillis += 1000;
      await sleep(1000);
      app.logger.info('Sleeping...');
    }
    app.logger.info("Let's go!");
    return say('How are you?').then(() => say("I'm good!"));
  });

export const main = app.receiver().toHandler();
```

![demo](https://user-images.githubusercontent.com/19658/71427006-b9b27e80-26aa-11ea-83c5-71090849279b.gif)

## Run the app on your local machine

```bash
cp _env .env
# edit .env
npm i
npm i serverless -g
sls offline --printOutput
```

## Deploy the app onto AWS

```bash
export SLACK_BOT_TOKEN=xoxb-xxxxxxxxx
export SLACK_SIGNING_SECRET=xxxxxxxxx
export SERVERLESS_STAGE=dev
sls deploy --stage ${SERVERLESS_STAGE} -v
```
