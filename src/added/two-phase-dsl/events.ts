import { ThenDef, PromiseMiddleware } from '../two-phase-dsl';
import { SlackEventMiddlewareArgs, AnyMiddlewareArgs } from '../../changed/utilities';
import { TwoPhaseApp } from '../TwoPhaseApp';
import { EventType } from 'aws-sdk/clients/cloudfront';
import { onlyEvents, matchEventType } from '@slack/bolt/dist/middleware/builtin';
import { toPromiseMiddleware } from '../primise-middleware';

export class EventThenDefinition implements ThenDef<SlackEventMiddlewareArgs> {
  private eventType: string;
  private app: TwoPhaseApp<any>;
  constructor(eventType: EventType, app: TwoPhaseApp<any>) {
    this.eventType = eventType;
    this.app = app;
  }
  then(listener: PromiseMiddleware<SlackEventMiddlewareArgs>): void {
    this.app.asyncListeners.push(
      [
        toPromiseMiddleware(onlyEvents),
        toPromiseMiddleware(matchEventType(this.eventType)),
        listener
      ] as PromiseMiddleware<AnyMiddlewareArgs>[],
    );
  }
}