import { StringIndexed } from '@slack/bolt/dist/types/helpers';
import { RespondArguments, AckFn } from '@slack/bolt/dist/types/utilities';

export type SlackViewAction = ViewSubmitAction | ViewClosedAction;

export interface SlackViewMiddlewareArgs<ViewActionType extends SlackViewAction = SlackViewAction> {
  payload: ViewOutput;
  view: this['payload'];
  body: ViewActionType;
  ack: AckFn<string | RespondArguments>;
}

interface PlainTextElementOutput {
  type: 'plain_text';
  text: string;
  emoji: boolean;
}

export interface ViewSubmitAction {
  type: 'view_submission';
  team: {
    id: string;
    domain: string;
    enterprise_id?: string; // undocumented
    enterprise_name?: string; // undocumented
  };
  user: {
    id: string;
    name: string;
    team_id?: string; // undocumented
  };
  view: ViewOutput;
  api_app_id: string;
  token: string;
}

export interface ViewClosedAction {
  type: 'view_closed';
  team: {
    id: string;
    domain: string;
    enterprise_id?: string; // undocumented
    enterprise_name?: string; // undocumented
  };
  user: {
    id: string;
    name: string;
    team_id?: string; // undocumented
  };
  view: ViewOutput;
  api_app_id: string;
  token: string;
  is_cleared: boolean;
}

export interface ViewOutput {
  id: string;
  callback_id: string;
  team_id: string;
  app_id: string | null;
  bot_id: string;
  title: PlainTextElementOutput;
  type: string;
  blocks: StringIndexed; // TODO: should this just be any?
  close: PlainTextElementOutput | null;
  submit: PlainTextElementOutput | null;
  state: object; // TODO: this should probably be expanded in the future
  hash: string;
  private_metadata: string;
  root_view_id: string | null;
  previous_view_id: string | null;
  clear_on_close: boolean;
  notify_on_close: boolean;
  external_id?: string;
}
