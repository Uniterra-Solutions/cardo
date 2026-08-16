import { useEffect, useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { ComposerAttachment, NewThreadEnvironment, WorkspaceRecord } from "./desktop-state";
import type { MentionOption } from "./hooks/use-mention-menu";
import { ArrowUpIcon, ChevronDownIcon, PiLogoMark, PlusIcon } from "./icons";
import {
  MODEL_OPTIONS_EMPTY_TITLE,
  type ComposerSlashCommand,
  type ComposerSlashCommandSection,
  type ComposerSlashOption,
  type ComposerSlashOptionEmptyState,
} from "./composer-commands";
import { ComposerSurface } from "./composer-surface";
import { JOVALTUS_MODE_CYCLE, type JovaltusMode } from "./jovaltus-ui";
import { ModelOnboardingNoticeBanner } from "./model-onboarding-notice";
import type { ModelOnboardingState, ModelOnboardingSettingsSection } from "./model-onboarding";
import { ModelSelector } from "./model-selector";

interface NewThreadViewProps {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly runtime?: RuntimeSnapshot;
  readonly environment: NewThreadEnvironment;
  readonly prompt: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly lastError?: string;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly modelOnboarding: ModelOnboardingState;
  // Cardo: Jovaltus mode selection (standard / plan / debug) on the
  // new-thread page, available before the conversation exists.
  readonly mode: JovaltusMode;
  readonly onSelectJovaltusMode: (mode: JovaltusMode) => void;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly activeSlashCommand?: ComposerSlashCommand;
  readonly activeSlashCommandMeta?: string;
  readonly slashSections: readonly ComposerSlashCommandSection[];
  readonly slashOptions: readonly ComposerSlashOption[];
  readonly selectedSlashCommand?: ComposerSlashCommand;
  readonly selectedSlashOption?: ComposerSlashOption;
  readonly showSlashMenu: boolean;
  readonly showSlashOptionMenu: boolean;
  readonly slashOptionEmptyState?: ComposerSlashOptionEmptyState;
  readonly showMentionMenu: boolean;
  readonly mentionOptions: readonly MentionOption[];
  readonly selectedMentionIndex: number;
  readonly onChangePrompt: (prompt: string) => void;
  readonly onSelectEnvironment: (environment: NewThreadEnvironment) => void;
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly onOpenModelSettings: (section: ModelOnboardingSettingsSection) => void;
  readonly onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onComposerPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onComposerDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onClearSlashCommand: () => void;
  readonly onSelectSlashCommand: (command: ComposerSlashCommand) => void;
  readonly onSelectSlashOption: (option: ComposerSlashOption) => void;
  readonly onSelectMention: (option: MentionOption) => void;
  readonly onEnableMentionExtension: (option: Extract<MentionOption, { kind: "extension" }>) => void;
  readonly onAddAttachments: (files: File[]) => void;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly onSubmit: () => void;
}

export function NewThreadView({
  workspaces,
  selectedWorkspaceId,
  runtime,
  environment,
  prompt,
  attachments,
  lastError,
  provider,
  modelId,
  thinkingLevel,
  modelOnboarding,
  mode,
  onSelectJovaltusMode,
  composerRef,
  activeSlashCommand,
  activeSlashCommandMeta,
  slashSections,
  slashOptions,
  selectedSlashCommand,
  selectedSlashOption,
  showSlashMenu,
  showSlashOptionMenu,
  slashOptionEmptyState,
  showMentionMenu,
  mentionOptions,
  selectedMentionIndex,
  onChangePrompt,
  onSelectEnvironment,
  onSelectWorkspace,
  onSetModel,
  onSetThinking,
  onOpenModelSettings,
  onComposerKeyDown,
  onComposerPaste,
  onComposerDrop,
  onClearSlashCommand,
  onSelectSlashCommand,
  onSelectSlashOption,
  onSelectMention,
  onEnableMentionExtension,
  onAddAttachments,
  onRemoveAttachment,
  onSubmit,
}: NewThreadViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workspace = workspaces.find((entry) => entry.id === selectedWorkspaceId);

  useEffect(() => {
    composerRef.current?.focus();
  }, [composerRef]);

  if (!workspace) {
    return (
      <section className="canvas canvas--empty">
        <div className="empty-panel">
          <div className="session-header__eyebrow">New thread</div>
          <h1>Open a folder to begin</h1>
          <p>Select a repository from the sidebar first, then start a local or worktree-backed thread.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="canvas canvas--new-thread">
      <div className="new-thread">
        <div className="new-thread__hero">
          <div className="new-thread__logo" data-testid="new-thread-logo">
            <PiLogoMark />
          </div>
          <div className="new-thread__eyebrow">New thread</div>
          <h1 className="new-thread__title">Let&apos;s build</h1>
          <label className="new-thread__workspace-picker">
            <span className="sr-only">Workspace</span>
            <select
              className="new-thread__workspace"
              value={workspace.id}
              onChange={(event) => onSelectWorkspace(event.target.value)}
            >
              {workspaces.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          {/* Cardo: Jovaltus mode selection — available before the
              conversation exists, not only inside an open thread. */}
          <div
            aria-label="Mode"
            className="new-thread__mode"
            data-testid="new-thread-mode"
            role="group"
          >
            {JOVALTUS_MODE_CYCLE.map((option) => (
              <button
                aria-pressed={mode === option}
                className={`new-thread__mode-option ${mode === option ? "new-thread__mode-option--active" : ""}`}
                data-testid={`new-thread-mode-${option}`}
                key={option}
                type="button"
                onClick={() => onSelectJovaltusMode(option)}
              >
                <span aria-hidden="true" className="new-thread__mode-dot" />
                {option}
              </button>
            ))}
          </div>
        </div>

        <div className="new-thread__composer composer">
          <div className="conversation conversation--composer">
            <ComposerSurface
              lastError={lastError}
              activeSlashCommand={activeSlashCommand}
              activeSlashCommandMeta={activeSlashCommandMeta}
              topNotice={(
                <ModelOnboardingNoticeBanner notice={modelOnboarding.notice} onOpenSettings={onOpenModelSettings} />
              )}
              queuedMessages={[]}
              composerDraft={prompt}
              setComposerDraft={onChangePrompt}
              composerRef={composerRef}
              attachments={attachments}
              slashSections={slashSections}
              slashOptions={slashOptions}
              selectedSlashCommand={selectedSlashCommand}
              selectedSlashOption={selectedSlashOption}
              showSlashMenu={showSlashMenu}
              showSlashOptionMenu={showSlashOptionMenu}
              slashOptionEmptyState={slashOptionEmptyState}
              onClearSlashCommand={onClearSlashCommand}
              onComposerKeyDown={onComposerKeyDown}
              onComposerPaste={onComposerPaste}
              onComposerDrop={onComposerDrop}
              onEditQueuedMessage={() => undefined}
              onCancelQueuedEdit={() => undefined}
              onRemoveQueuedMessage={() => undefined}
              onSteerQueuedMessage={() => undefined}
              onRemoveAttachment={onRemoveAttachment}
              onSelectSlashCommand={onSelectSlashCommand}
              onSelectSlashOption={onSelectSlashOption}
              showMentionMenu={showMentionMenu}
              mentionOptions={mentionOptions}
              selectedMentionIndex={selectedMentionIndex}
              onSelectMention={onSelectMention}
              onEnableMentionExtension={onEnableMentionExtension}
              textareaLabel="New thread prompt"
              textareaTestId="new-thread-composer"
              textareaPlaceholder="Ask pi anything, or use / for commands"
              leadingControls={(
                <button
                  aria-label="Attach files"
                  className="icon-button composer__attach"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PlusIcon />
                </button>
              )}
              trailingControls={(
                <NewThreadComposerControls
                  runtime={runtime}
                  environment={environment}
                  provider={provider}
                  modelId={modelId}
                  thinkingLevel={thinkingLevel}
                  modelOnboarding={modelOnboarding}
                  hasContent={Boolean(prompt.trim() || attachments.length > 0)}
                  onSelectEnvironment={onSelectEnvironment}
                  onSetModel={onSetModel}
                  onSetThinking={onSetThinking}
                  onSubmit={onSubmit}
                />
              )}
            />
          </div>
        </div>
        <input
          ref={fileInputRef}
          hidden
          type="file"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) {
              onAddAttachments(files);
            }
            event.currentTarget.value = "";
          }}
        />
      </div>
    </section>
  );
}

interface NewThreadComposerControlsProps {
  readonly runtime?: RuntimeSnapshot;
  readonly environment: NewThreadEnvironment;
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly modelOnboarding: ModelOnboardingState;
  readonly hasContent: boolean;
  readonly onSelectEnvironment: (environment: NewThreadEnvironment) => void;
  readonly onSetModel: (provider: string, modelId: string) => void;
  readonly onSetThinking: (level: string) => void;
  readonly onSubmit: () => void;
}

function NewThreadComposerControls({
  runtime,
  environment,
  provider,
  modelId,
  thinkingLevel,
  modelOnboarding,
  hasContent,
  onSelectEnvironment,
  onSetModel,
  onSetThinking,
  onSubmit,
}: NewThreadComposerControlsProps) {
  return (
    <>
      <label className="new-thread__environment-picker">
        <select
          aria-label="Environment"
          className="new-thread__environment-select"
          value={environment}
          onChange={(event) => onSelectEnvironment(event.target.value as NewThreadEnvironment)}
        >
          <option value="local">Local</option>
          <option value="worktree">Worktree</option>
        </select>
        <ChevronDownIcon />
      </label>
      <ModelSelector
        runtime={runtime}
        provider={provider}
        modelId={modelId}
        thinkingLevel={thinkingLevel}
        dropdownPlacement="below"
        showEmptyModelControl
        unselectedModelLabel={modelOnboarding.unselectedModelLabel}
        emptyModelLabel={MODEL_OPTIONS_EMPTY_TITLE}
        emptyModelTitle={modelOnboarding.emptyModelTitle}
        onSetModel={onSetModel}
        onSetThinking={onSetThinking}
      />
      <button
        aria-label="Start thread"
        className="button button--primary button--cta-icon"
        type="button"
        disabled={!hasContent || modelOnboarding.requiresModelSelection}
        onClick={onSubmit}
      >
        <ArrowUpIcon />
      </button>
    </>
  );
}
