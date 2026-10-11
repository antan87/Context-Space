import { AcpCliAdapter, isSafeAcpSessionId, type AcpTransportFactory } from './AcpCliAdapter.js';
import { findExecutable } from './cliAvailability.js';
import { isValidSessionUuid } from './session.js';

/** Copilot ACP starts with a read/search-only tool surface. */
export function buildCopilotAcpArgs(): string[] {
  return [
    '--acp',
    '--stdio',
    '--available-tools=view,glob,grep',
    '--disable-builtin-mcps',
    '--no-ask-user',
    '--no-auto-update',
    '--no-remote',
    '--no-remote-export',
  ];
}

export class CopilotAcpAdapter extends AcpCliAdapter {
  constructor(transportFactory?: AcpTransportFactory) {
    super({
      executable: findExecutable('copilot') ?? 'copilot',
      args: buildCopilotAcpArgs(),
      label: 'GitHub Copilot CLI',
      harness: 'copilot',
      loginCommand: 'copilot login',
      validateSessionId: (id) => isValidSessionUuid(id) || isSafeAcpSessionId(id),
      transportFactory,
    });
  }
}
