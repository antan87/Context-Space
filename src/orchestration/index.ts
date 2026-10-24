/**
 * @module orchestration/index
 * Re-exports all orchestration modules.
 */

export { detectOrchestrationTools, detectServiceConfig, detectAllServices, detectDeclaredServices, parseProcfile, suggestProcfiles } from './detect.js';
export {
  startServices,
  stopServices,
  startService,
  stopService,
  restartService,
  getServiceStatus,
  showLogs,
  loadRunningState,
  readRawRunningState,
  getPm2List,
  readPm2List,
} from './runner.js';
export type { Pm2Process, Pm2Env } from './runner.js';
export { tailLogFile } from './log-tail.js';
export { startOrchestrator, stopOrchestrator, stopRecordedOrchestrator } from './orchestrator.js';
