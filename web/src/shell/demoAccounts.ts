// The demonstrator's two demo accounts (FR-102, VS-24, PR-07), offered on the display
// client's login screen and labelled as demo credentials. They belong to the shell: the
// display client knows no account (FR-118), and a developed system never pre-populates
// credentials. They match the server's configuration (web/src/standin/accounts.ts).
import type { DemoAccount } from '../client/DisplayClient';

export const DEMO_LOGINS: DemoAccount[] = [
  { user: 'owner', password: 'demo-owner', note: 'the owner: weather and CO₂' },
  { user: 'friend', password: 'demo-friend', note: 'a friend: weather only' },
];
