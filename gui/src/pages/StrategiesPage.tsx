import React from 'react';
import { CheckCircle, Cpu, FolderOpen, PlusCircle, Trash2 } from 'lucide-react';

import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card } from '../components/ui/card.js';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { ScrollArea } from '../components/ui/scroll-area.js';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select.js';
import { Spinner } from '../components/ui/spinner.js';
import { Textarea } from '../components/ui/textarea.js';
import { cn } from '../lib/utils.js';
import type { DetectedAI } from '../types.js';
import type { WorkflowTemplate } from '../lib/api/queries.js';

interface StrategiesPageProps {
  workflowTemplates: WorkflowTemplate[];
  isEditingTemplate: boolean;
  setIsEditingTemplate: React.Dispatch<React.SetStateAction<boolean>>;
  mgtTemplateName: string;
  setMgtTemplateName: React.Dispatch<React.SetStateAction<string>>;
  mgtTemplateContent: string;
  setMgtTemplateContent: React.Dispatch<React.SetStateAction<string>>;
  selectedMgtTemplateId: string | null;
  setSelectedMgtTemplateId: React.Dispatch<React.SetStateAction<string | null>>;
  analysisResult: string | null;
  setAnalysisResult: React.Dispatch<React.SetStateAction<string | null>>;
  showToast: (msg: string, type?: 'success' | 'error' | 'info', dur?: number) => void;
  handleAnalyzeTemplate: (id: string, content: string, harness: string) => Promise<void>;
  handleSaveTemplate: () => Promise<void>;
  handleDeleteTemplate: (id: string) => Promise<void>;
  aiAssistants: DetectedAI[];
  analyzingTemplate: boolean;
  mgtAnalysisComment: string;
  setMgtAnalysisComment: React.Dispatch<React.SetStateAction<string>>;
  suggestedImprovement: string | null;
  setSuggestedImprovement: React.Dispatch<React.SetStateAction<string | null>>;
  savingTemplate: boolean;
  deletingTemplate: boolean;
  selectedInspectAssistant: string;
  setSelectedInspectAssistant: React.Dispatch<React.SetStateAction<string>>;
}

export function StrategiesPage(props: StrategiesPageProps) {
  const {
    workflowTemplates,
    isEditingTemplate,
    setIsEditingTemplate,
    mgtTemplateName,
    setMgtTemplateName,
    mgtTemplateContent,
    setMgtTemplateContent,
    selectedMgtTemplateId,
    setSelectedMgtTemplateId,
    analysisResult,
    setAnalysisResult,
    showToast,
    handleAnalyzeTemplate,
    handleSaveTemplate,
    handleDeleteTemplate,
    aiAssistants,
    analyzingTemplate,
    mgtAnalysisComment,
    setMgtAnalysisComment,
    suggestedImprovement,
    setSuggestedImprovement,
    savingTemplate,
    deletingTemplate,
    selectedInspectAssistant,
    setSelectedInspectAssistant,
  } = props;

  const selectedTemplate = workflowTemplates.find((template) => template.id === selectedMgtTemplateId);
  const detectedHarnesses = aiAssistants.filter((ai) => ai.detected && ai.command);
  const selectedHarnessLabel =
    detectedHarnesses.find((ai) => ai.name === selectedInspectAssistant)?.displayName ?? 'No Harness Found';

  return (
    <div className="mx-auto max-w-6xl animate-fade-in">
      <header className="mb-6 border-b border-border/70 pb-4">
        <h1 className="text-xl font-bold tracking-tight text-foreground">Team Collaboration Strategies</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Predefine and review custom teamwork orchestration templates injected into workspaces' AGENTS.md files.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 text-left lg:grid-cols-12">
        <div className="flex flex-col gap-4 lg:col-span-4">
          <Card className="rounded-xl border border-border/80 bg-card/70 backdrop-blur-md p-5 shadow-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Strategies</h3>
              <Button
                size="sm"
                onClick={() => {
                  setIsEditingTemplate(true);
                  setMgtTemplateName('New Strategy');
                  setMgtTemplateContent('# New Strategy\n\nWrite custom teamwork rules here for subagent orchestration...');
                  setSelectedMgtTemplateId(null);
                  setAnalysisResult(null);
                }}
              >
                <PlusCircle size={12} /> Add New
              </Button>
            </div>

            <ScrollArea className="mt-4 max-h-[480px]">
              <div className="flex flex-col gap-2 pr-1">
                {workflowTemplates.map((template) => {
                  const isSelected = selectedMgtTemplateId === template.id;
                  return (
                    <div
                      key={template.id}
                      className={cn(
                        'flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors',
                        isSelected
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
                          : 'border-border bg-card hover:border-foreground/15 hover:bg-muted/40',
                      )}
                      onClick={() => {
                        setSelectedMgtTemplateId(template.id);
                        setIsEditingTemplate(false);
                        setMgtTemplateName(template.name);
                        setMgtTemplateContent(template.content);
                        setAnalysisResult(null);
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn('text-xs font-semibold', isSelected ? 'text-primary' : 'text-foreground')}>
                          {template.name}
                        </span>
                        <Badge variant={template.custom ? 'info' : 'secondary'} size="sm" className="font-mono uppercase">
                          {template.custom ? 'Custom' : 'Built-in'}
                        </Badge>
                      </div>
                      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {template.description}
                      </p>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </Card>
        </div>

        <div className="flex flex-col gap-6 lg:col-span-8">
          {selectedMgtTemplateId || isEditingTemplate ? (
            <Card className="flex flex-col gap-5 rounded-xl p-6 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  {isEditingTemplate ? (
                    <div className="flex flex-col gap-2">
                      <Label className="text-sm">Strategy Name</Label>
                      <Input
                        type="text"
                        value={mgtTemplateName}
                        onChange={(e) => setMgtTemplateName(e.target.value)}
                        placeholder="e.g. Test-Driven Development"
                      />
                    </div>
                  ) : (
                    <div>
                      <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
                        {mgtTemplateName}
                        {selectedTemplate?.custom && (
                          <Badge variant="info" className="font-mono uppercase">
                            Custom Template
                          </Badge>
                        )}
                      </h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedTemplate?.description || 'Custom strategy template.'}
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  {isEditingTemplate ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (selectedMgtTemplateId) {
                            const original = workflowTemplates.find((template) => template.id === selectedMgtTemplateId);
                            if (original) {
                              setMgtTemplateName(original.name);
                              setMgtTemplateContent(original.content);
                            }
                            setIsEditingTemplate(false);
                          } else {
                            setIsEditingTemplate(false);
                            if (workflowTemplates.length > 0) {
                              const first = workflowTemplates[0];
                              setSelectedMgtTemplateId(first.id);
                              setMgtTemplateName(first.name);
                              setMgtTemplateContent(first.content);
                            }
                          }
                        }}
                      >
                        Cancel
                      </Button>
                      <Button size="sm" onClick={handleSaveTemplate} disabled={savingTemplate}>
                        {savingTemplate ? 'Saving...' : 'Save Strategy'}
                      </Button>
                    </>
                  ) : (
                    <>
                      {selectedTemplate?.custom && (
                        <>
                          <Button variant="outline" size="sm" onClick={() => setIsEditingTemplate(true)}>
                            Edit
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDeleteTemplate(selectedMgtTemplateId!)}
                            disabled={deletingTemplate}
                          >
                            <Trash2 size={12} /> Delete
                          </Button>
                        </>
                      )}
                      {!selectedTemplate?.custom && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setIsEditingTemplate(true);
                            setMgtTemplateName(`${mgtTemplateName} Copy`);
                            setMgtTemplateContent(mgtTemplateContent);
                            setSelectedMgtTemplateId(null);
                            setAnalysisResult(null);
                          }}
                        >
                          Duplicate & Customize
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-sm">Guidelines Markdown</Label>
                <Textarea
                  className="min-h-[250px] font-mono text-xs leading-relaxed"
                  value={mgtTemplateContent}
                  onChange={(e) => setMgtTemplateContent(e.target.value)}
                  disabled={!isEditingTemplate}
                  placeholder="Write cooperation guidelines in Markdown..."
                />
              </div>

              {!isEditingTemplate && selectedMgtTemplateId && (
                <div className="flex flex-col gap-4 border-t border-border pt-5">
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                      <div className="flex flex-col">
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          <Cpu size={14} className="text-muted-foreground" /> AI Strategy Analysis
                        </span>
                        <span className="mt-0.5 text-xs text-muted-foreground">
                          Select an AI assistant harness installed on your system to inspect these guidelines.
                        </span>
                      </div>

                      <div className="flex w-full items-center justify-end gap-3 sm:w-auto">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Harness:
                          </span>
                          <Select
                            value={selectedInspectAssistant}
                            disabled={detectedHarnesses.length === 0}
                            onValueChange={(value) =>
                              typeof value === 'string' && setSelectedInspectAssistant(value)
                            }
                          >
                            <SelectTrigger size="sm" className="w-44" aria-label="Harness">
                              <SelectValue>{selectedHarnessLabel}</SelectValue>
                            </SelectTrigger>
                            <SelectPopup alignItemWithTrigger={false}>
                              {detectedHarnesses.length > 0 ? (
                                detectedHarnesses.map((ai) => (
                                  <SelectItem key={ai.name} value={ai.name}>
                                    {ai.displayName}
                                  </SelectItem>
                                ))
                              ) : (
                                <SelectItem value="">No Harness Found</SelectItem>
                              )}
                            </SelectPopup>
                          </Select>
                        </div>

                        <Button
                          size="sm"
                          onClick={() => handleAnalyzeTemplate(selectedMgtTemplateId, mgtTemplateContent, selectedInspectAssistant)}
                          disabled={analyzingTemplate || detectedHarnesses.length === 0}
                        >
                          {analyzingTemplate ? (
                            <>
                              <Spinner className="size-3" /> Inspecting...
                            </>
                          ) : (
                            <>
                              <Cpu size={12} /> Inspect Strategy
                            </>
                          )}
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <Label className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                        Evaluation Focus / Instructions (Optional)
                      </Label>
                      <Textarea
                        className="min-h-[60px] text-xs leading-relaxed"
                        value={mgtAnalysisComment}
                        onChange={(e) => setMgtAnalysisComment(e.target.value)}
                        placeholder="e.g. Focus on checking if timeouts are handled well, check subagent roles coordination..."
                        disabled={analyzingTemplate}
                      />
                    </div>
                  </div>

                  {analysisResult && (
                    <div className="flex flex-col gap-4">
                      <ScrollArea className="max-h-[300px] rounded-xl border border-border bg-muted/40 p-5">
                        <div className="select-text whitespace-pre-wrap text-left text-xs leading-relaxed text-foreground">
                          {analysisResult}
                        </div>
                      </ScrollArea>
                      {suggestedImprovement && (
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            onClick={() => {
                              setMgtTemplateContent(suggestedImprovement);
                              setIsEditingTemplate(true);
                              setSuggestedImprovement(null);
                              setAnalysisResult(null);
                              showToast('Suggested improvements applied! Click Save to persist changes.', 'success');
                            }}
                          >
                            <CheckCircle size={14} /> Apply Suggested Improvements
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Card>
          ) : (
            <div className="flex min-h-[400px] flex-col items-center justify-center">
              <Empty className="w-full max-w-md border border-dashed border-border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderOpen />
                  </EmptyMedia>
                  <EmptyTitle>No strategy template selected</EmptyTitle>
                  <EmptyDescription>
                    Select a template from the list to view, edit, or analyze it, or add a new custom teamwork
                    workflow template.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
