// Dictionary of «ja» (change `i18n`, design D2): one module per namespace.
import common from './common.js';
import chat from './chat.js';
import files from './files.js';
import mcp from './mcp.js';
import subscriptions from './subscriptions.js';
import limits from './limits.js';
import sessions from './sessions.js';
import settings from './settings.js';
import machines from './machines.js';
import projects from './projects.js';
import newSession from './newSession.js';
import workspace from './workspace.js';
import hub from './hub.js';
import desktop from './desktop.js';

import type { Dict } from '../../index.js';

export default {
  ...common,
  ...chat,
  ...files,
  ...mcp,
  ...subscriptions,
  ...limits,
  ...sessions,
  ...settings,
  ...machines,
  ...projects,
  ...newSession,
  ...workspace,
  ...hub,
  ...desktop,
} satisfies Dict;
