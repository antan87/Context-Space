import { useEffect, useRef, useState } from 'react';
import { Play, X } from 'lucide-react';
import type { Feature } from '../types.js';
import { useServiceAction, useWorkspaceServices } from '../lib/api/queries.js';
import { useServiceLogStream } from '../features/services/useServiceLogStream.js';

interface VsCodeShellProps {
  activeWsId: string | null;
  setActiveWsId: (workspaceId: string | null) => void;
  appVersion: string;
  workspaces: Feature[];
  executeTerminal: (command: string) => void;
}

export function VsCodeShell({
  activeWsId,
  setActiveWsId,
  appVersion,
  workspaces,
  executeTerminal,
}: VsCodeShellProps) {
  const [selectedLogService, setSelectedLogService] = useState<string | null>(null);

  const servicesQuery = useWorkspaceServices(activeWsId);
  const services = servicesQuery.data?.services ?? [];
  const runningServices = servicesQuery.data?.runningState ?? [];
  const serviceAction = useServiceAction(activeWsId ?? '');
  const { logs } = useServiceLogStream(activeWsId, selectedLogService, !!activeWsId);

  // Keep a valid log selection as the detected set changes.
  useEffect(() => {
    if (services.length === 0) {
      if (selectedLogService !== null) setSelectedLogService(null);
    } else if (!selectedLogService || !services.some((s) => s.name === selectedLogService)) {
      setSelectedLogService(services[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services]);

  const logsEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const runningCount = runningServices.filter((rs) => rs.pid > 0).length;

  return (
    <div className="flex flex-col h-screen w-full bg-background text-foreground font-mono text-[11px] overflow-hidden select-none border-t border-border">
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-card border-b border-border shrink-0 text-[10px]">
        <div className="flex items-center gap-2">
          <span className="font-bold text-primary">CONTEXTSPACE_SHELL</span>
          <span className="text-muted-foreground">|</span>
          <span className="text-muted-foreground">ws: {activeWsId || 'none'}</span>
        </div>
        <div className="flex items-center gap-2">
          {activeWsId && (
            <button
              onClick={() => {
                setActiveWsId(null);
                setSelectedLogService(null);
              }}
              className="text-primary hover:text-primary/90 hover:underline transition-colors cursor-pointer rounded bg-transparent border-none p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              [Change WS]
            </button>
          )}
          {appVersion && <span className="text-[10px] text-muted-foreground">v{appVersion}</span>}
        </div>
      </div>

      {!activeWsId ? (
        /* CLI Workspace Selection Menu */
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center overflow-y-auto">
          <div className="text-primary font-bold mb-4 text-[12px] uppercase">
            === Select Active Workspace ===
          </div>
          <div className="flex flex-col gap-2 w-full max-w-xs">
            {workspaces.map((ws) => (
              <button
                key={ws.branchName}
                onClick={() => setActiveWsId(ws.branchName)}
                className="w-full text-left p-2.5 bg-muted border border-border hover:border-primary rounded hover:bg-primary/10 text-muted-foreground hover:text-foreground transition-all text-[11px] cursor-pointer"
              >
                &gt; {ws.branchName}
              </button>
            ))}
            {workspaces.length === 0 && (
              <div className="text-muted-foreground italic">No workspaces found. Initialize one via the CLI.</div>
            )}
          </div>
        </div>
      ) : (
        /* Active Workspace Panel */
        <div className="flex-1 flex flex-col min-h-0">
          {/* Top Config / Control Panel */}
          <div className="p-3 border-b border-border shrink-0 bg-muted/30">
            {/* Service Control Buttons */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => serviceAction.mutate({ action: 'start' })}
                disabled={serviceAction.isPending || !services.some((service) => service.declared)}
                title={services.some((service) => service.declared) ? undefined : 'Nothing is declared. Add a Procfile.dev, or start guessed services from the Services tab.'}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-success/20 bg-success/10 hover:bg-success/20 text-success font-bold transition-all cursor-pointer text-[10px] disabled:opacity-50"
              >
                <Play size={10} /> [START SERVICES]
              </button>
              <button
                onClick={() => serviceAction.mutate({ action: 'stop' })}
                disabled={serviceAction.isPending}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-destructive/20 bg-destructive/10 hover:bg-destructive/20 text-destructive font-bold transition-all cursor-pointer text-[10px] disabled:opacity-50"
              >
                <X size={10} /> [STOP SERVICES]
              </button>
            </div>

            {/* Service List */}
            <div className="mb-3">
              <div className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider mb-1 px-1">
                Background Services ({runningCount}/{services.length})
              </div>
              {services.length === 0 ? (
                <div className="text-muted-foreground italic px-1 text-[10px]">No services detected in workspace.</div>
              ) : (
                <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto pr-1">
                  {services.map((service) => {
                    const isRunning = runningServices.some((rs) => rs.name === service.name && rs.pid > 0);
                    const isSelected = selectedLogService === service.name;
                    return (
                      <div
                        key={service.name}
                        onClick={() => setSelectedLogService(service.name)}
                        className={`flex items-center justify-between p-1.5 border rounded cursor-pointer transition-all ${
                          isSelected
                            ? 'bg-primary/20 border-primary/50 text-foreground'
                            : 'bg-muted/20 border-border hover:border-border/80 text-muted-foreground'
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <span className={`h-1.5 w-1.5 rounded-full ${isRunning ? 'bg-success' : 'bg-destructive'}`}></span>
                          <span className="font-bold truncate">{service.name}</span>
                          {!service.declared && <span className="text-[8px] uppercase text-warning" title={`Guessed from ${service.source}`}>guessed</span>}
                        </div>
                        <span className="text-[10px] font-mono shrink-0">
                          {isRunning ? (
                            <span className="text-success bg-success/10 px-1 py-0.2 rounded border border-success/20 text-[8px] font-bold uppercase">on</span>
                          ) : (
                            <span className="text-muted-foreground bg-muted px-1 py-0.2 rounded border border-border text-[8px] font-bold uppercase">off</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* MCP Status Check */}
            <div className="mb-3 border-t border-border pt-2.5">
              <div className="text-[10px] text-muted-foreground font-bold uppercase mb-1 px-1">
                Active Local MCP Tools
              </div>
              <div className="flex flex-col gap-1 px-1 text-[10px] text-muted-foreground font-mono">
                <div className="flex justify-between">
                  <span>• search_workspace</span>
                  <span className="text-primary font-bold">READY</span>
                </div>
                <div className="flex justify-between">
                  <span>• get_service_logs</span>
                  <span className="text-primary font-bold">READY</span>
                </div>
              </div>
            </div>

            {/* Interactive CLI Buttons */}
            <div className="border-t border-border pt-2.5">
              <div className="text-[10px] text-muted-foreground font-bold uppercase mb-1.5 px-1">
                Terminal Commands (Click to Run)
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {['ctxspace sync', 'ctxspace diff', 'ctxspace handoff', 'ctxspace status'].map((cmd) => (
                  <button
                    key={cmd}
                    onClick={() => executeTerminal(cmd)}
                    className="px-2 py-1.5 text-left border border-border hover:border-primary bg-muted/40 rounded text-muted-foreground hover:text-foreground hover:bg-primary/10 transition-all font-mono text-[9px] cursor-pointer"
                  >
                    $ {cmd}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Bottom Log Pane — live SSE stream */}
          <div className="flex-1 flex flex-col min-h-0 bg-background">
            <div className="flex items-center justify-between px-3 py-1.5 bg-card border-b border-border shrink-0 text-[9px] text-muted-foreground uppercase tracking-wider font-bold">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-primary"></span>
                <span>log_stream: {selectedLogService || 'none'}</span>
              </div>
            </div>
            <div className="flex-1 p-3 overflow-y-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap select-text selection:bg-primary/30 text-foreground">
              {logs.trim() ? (
                logs
              ) : (
                <span className="text-muted-foreground italic font-mono">(no logs recorded yet)</span>
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
