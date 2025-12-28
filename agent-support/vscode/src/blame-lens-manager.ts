import * as vscode from "vscode";
import { BlameService, BlameResult, LineBlameInfo } from "./blame-service";

export class BlameLensManager implements vscode.CodeLensProvider {
  private context: vscode.ExtensionContext;
  private blameService: BlameService;
  private currentBlameResult: BlameResult | null = null;
  private currentDocumentUri: string | null = null;
  private pendingBlameRequest: Promise<BlameResult | null> | null = null;
  // private statusBarItem: vscode.StatusBarItem;
  private currentSelection: vscode.Selection | null = null;
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
  
  // In-memory toggle for showing all AI code (not persisted, per-workspace)
  private toggleAICodeEnabled: boolean = false;
  
  // Virtual document provider for markdown content
  private static readonly VIRTUAL_SCHEME = 'git-ai-blame';
  private markdownContentStore: Map<string, string> = new Map();
  private _onDidChangeVirtualDocument: vscode.EventEmitter<vscode.Uri> = new vscode.EventEmitter<vscode.Uri>();
  
  // Decoration types for colored borders (one per color)
  private colorDecorations: vscode.TextEditorDecorationType[] = [];
  
  // 40 readable colors for AI hunks
  private readonly HUNK_COLORS = [
    'rgba(96, 165, 250, 0.8)',   // Blue
    'rgba(167, 139, 250, 0.8)',  // Purple
    'rgba(251, 146, 60, 0.8)',   // Orange
    'rgba(244, 114, 182, 0.8)',  // Pink
    'rgba(250, 204, 21, 0.8)',   // Yellow
    'rgba(56, 189, 248, 0.8)',   // Sky Blue
    'rgba(249, 115, 22, 0.8)',   // Deep Orange
    'rgba(168, 85, 247, 0.8)',   // Violet
    'rgba(236, 72, 153, 0.8)',   // Hot Pink
    'rgba(34, 197, 94, 0.8)',    // Green
    'rgba(59, 130, 246, 0.8)',   // Bright Blue
    'rgba(139, 92, 246, 0.8)',   // Purple Violet
    'rgba(234, 179, 8, 0.8)',    // Gold
    'rgba(236, 72, 85, 0.8)',    // Red
    'rgba(20, 184, 166, 0.8)',   // Teal
    'rgba(251, 191, 36, 0.8)',   // Amber
    'rgba(192, 132, 252, 0.8)',  // Light Purple
    'rgba(147, 197, 253, 0.8)',  // Light Blue
    'rgba(252, 165, 165, 0.8)',  // Light Red
    'rgba(134, 239, 172, 0.8)',  // Light Green
    'rgba(253, 224, 71, 0.8)',   // Bright Yellow
    'rgba(165, 180, 252, 0.8)',  // Indigo
    'rgba(253, 186, 116, 0.8)',  // Light Orange
    'rgba(249, 168, 212, 0.8)',  // Light Pink
    'rgba(94, 234, 212, 0.8)',   // Cyan
    'rgba(199, 210, 254, 0.8)',  // Pale Indigo
    'rgba(254, 240, 138, 0.8)',  // Pale Yellow
    'rgba(191, 219, 254, 0.8)',  // Pale Blue
    'rgba(254, 202, 202, 0.8)',  // Pale Red
    'rgba(187, 247, 208, 0.8)',  // Pale Green
    'rgba(167, 243, 208, 0.8)',  // Pale Teal
    'rgba(253, 230, 138, 0.8)',  // Pale Amber
    'rgba(216, 180, 254, 0.8)',  // Pale Purple
    'rgba(254, 215, 170, 0.8)',  // Pale Orange
    'rgba(251, 207, 232, 0.8)',  // Pale Pink
    'rgba(129, 140, 248, 0.8)',  // Medium Indigo
    'rgba(248, 113, 113, 0.8)',  // Medium Red
    'rgba(74, 222, 128, 0.8)',   // Medium Green
    'rgba(45, 212, 191, 0.8)',   // Medium Teal
    'rgba(251, 146, 189, 0.8)',  // Medium Pink
  ];

  /**
   * Create a tiny SVG data URI that draws a solid stripe in the requested color.
   * The gutter icon is reused per decoration to keep the stripe inside the gutter.
   */
  private createGutterIconUri(color: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="24"><rect width="4" height="24" fill="${color}" /></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.blameService = new BlameService();

    // Create decoration types for each color
    this.colorDecorations = this.HUNK_COLORS.map(color => 
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        gutterIconPath: this.createGutterIconUri(color),
        gutterIconSize: 'contain',
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      })
    );

    // Create status bar item for model display
    // this.statusBarItem = vscode.window.createStatusBarItem(
    //   vscode.StatusBarAlignment.Right,
    //   500
    // );
    // this.statusBarItem.name = 'git-ai Model';
    // this.statusBarItem.hide();
  }

  public activate(): void {
    // Register virtual document provider for markdown content
    const documentProvider = new class implements vscode.TextDocumentContentProvider {
      constructor(private manager: BlameLensManager) {}
      
      provideTextDocumentContent(uri: vscode.Uri): string {
        // Extract content ID from path (remove leading / and trailing extension like .md or .diff)
        const contentId = uri.path.replace(/^\//, '').replace(/\.(md|diff)$/, '');
        const content = this.manager.markdownContentStore.get(contentId);
        if (!content) {
          return '// Content not found';
        }
        return content;
      }
      
      get onDidChange(): vscode.Event<vscode.Uri> {
        return this.manager._onDidChangeVirtualDocument.event;
      }
    }(this);
    
    this.context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(BlameLensManager.VIRTUAL_SCHEME, documentProvider)
    );
    
    // Register CodeLens provider for all languages
    this.context.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ scheme: '*', language: '*' }, this)
    );

    // Register selection change listener
    this.context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.handleSelectionChange(event);
      })
    );

    // Register hover provider for all languages
    this.context.subscriptions.push(
      vscode.languages.registerHoverProvider({ scheme: '*', language: '*' }, {
        provideHover: (document, position, token) => {
          return this.provideHover(document, position, token);
        }
      })
    );

    // Handle tab/document close to cancel pending blames
    this.context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.handleDocumentClose(document);
      })
    );

    // Handle active editor change to refresh CodeLens when switching documents
    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.handleActiveEditorChange(editor);
      })
    );

    // Handle file save to invalidate cache and potentially refresh blame
    this.context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.handleDocumentSave(document);
      })
    );

    // Handle document content changes to refresh blame with shifted line attributions
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.handleDocumentChange(event);
      })
    );

    // Handle scroll to recalculate which CodeLens (first visible per prompt) to show
    this.context.subscriptions.push(
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        this.handleVisibleRangesChange(event);
      })
    );

    // Register CodeLens click handler
    this.context.subscriptions.push(
      vscode.commands.registerCommand('git-ai.showAuthorDetails', (lineInfo: LineBlameInfo, line: number) => {
        this.handleCodeLensClick(lineInfo);
      })
    );

    // Register status bar item click handler
    // this.statusBarItem.command = 'git-ai.showModelHover';
    // this.context.subscriptions.push(
    //   vscode.commands.registerCommand('git-ai.showModelHover', () => {
    //     this.handleStatusBarClick();
    //   })
    // );

    // Register command to show commit diff
    this.context.subscriptions.push(
      vscode.commands.registerCommand('git-ai.showCommitDiff', async (commitSha: string, workspacePath: string) => {
        await this.showCommitDiff(commitSha, workspacePath);
      })
    );

    // Register Toggle AI Code command
    this.context.subscriptions.push(
      vscode.commands.registerCommand('git-ai.toggleAICode', () => {
        this.handleToggleAICode();
      })
    );

    // Add status bar item to context subscriptions for proper cleanup
    // this.context.subscriptions.push(this.statusBarItem);

    console.log('[git-ai] BlameLensManager activated, CodeLens provider registered');
  }

  /**
   * Handle document save - invalidate cache and refresh blame if there's an active selection or toggle is enabled.
   */
  private handleDocumentSave(document: vscode.TextDocument): void {
    const documentUri = document.uri.toString();
    
    // Invalidate cached blame for this document
    this.blameService.invalidateCache(document.uri);
    
    // If this is the current document with blame, clear and re-fetch
    if (this.currentDocumentUri === documentUri) {
      this.currentBlameResult = null;
      this.pendingBlameRequest = null;
      
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.toString() === documentUri) {
        // Clear existing colored borders
        this.clearColoredBorders(activeEditor);
        
        // Re-fetch blame based on current mode
        if (this.toggleAICodeEnabled) {
          // Toggle mode: re-fetch blame for full file
          this.requestBlameForFullFile(activeEditor);
        } else {
          // Check if there's a multi-line selection
          const selection = activeEditor.selections[0];
          if (selection && selection.start.line !== selection.end.line) {
            // Re-fetch blame with the current selection
            this.requestBlameAndRefresh(activeEditor, selection);
          }
        }
      }
    }
    
    console.log('[git-ai] Document saved, invalidated blame cache for:', document.uri.fsPath);
  }

  /**
   * Handle document content change - invalidate cached blame and re-fetch with shifted line attributions.
   * This is called on every keystroke, so we debounce the refresh.
   */
  private documentChangeTimer: NodeJS.Timeout | null = null;
  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const documentUri = event.document.uri.toString();
    
    // Only handle changes to the current document we have blame for
    if (this.currentDocumentUri !== documentUri) {
      return;
    }
    
    // Skip if no content changes (e.g., just metadata changes)
    if (event.contentChanges.length === 0) {
      return;
    }
    
    // Clear the current blame result since line numbers have shifted
    this.currentBlameResult = null;
    this.pendingBlameRequest = null;
    
    // Debounce the refresh to avoid hammering git-ai on every keystroke
    if (this.documentChangeTimer) {
      clearTimeout(this.documentChangeTimer);
    }
    
    this.documentChangeTimer = setTimeout(() => {
      this.documentChangeTimer = null;
      
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.toString() === documentUri) {
        // Clear existing colored borders
        this.clearColoredBorders(activeEditor);
        
        // Re-fetch blame based on current mode
        if (this.toggleAICodeEnabled) {
          // Toggle mode: re-fetch blame for full file
          this.requestBlameForFullFile(activeEditor);
        } else {
          const selection = activeEditor.selections[0];
          if (selection && selection.start.line !== selection.end.line) {
            // Re-fetch blame with the current selection
            this.requestBlameAndRefresh(activeEditor, selection);
          }
        }
        
        // Update status bar for current line
        // this.updateStatusBarForCurrentLine(activeEditor);
        
        // Fire CodeLens change event
        this._onDidChangeCodeLenses.fire();
      }
    }, 300); // 300ms debounce
  }

  /**
   * Handle document close - cancel any pending blame requests and clean up cache.
   */
  private handleDocumentClose(document: vscode.TextDocument): void {
    const documentUri = document.uri.toString();
    
    // Clear colored borders if this was the current document
    const editor = vscode.window.visibleTextEditors.find(
      e => e.document.uri.toString() === documentUri
    );
    if (editor) {
      this.clearColoredBorders(editor);
    }
    
    // Cancel any pending blame for this document
    this.blameService.cancelForUri(document.uri);
    
    // Clear cached blame result if it matches
    if (this.currentDocumentUri === documentUri) {
      this.currentBlameResult = null;
      this.currentDocumentUri = null;
      this.pendingBlameRequest = null;
    }
    
    // Invalidate cache
    this.blameService.invalidateCache(document.uri);
    
    console.log('[git-ai] Document closed, cancelled blame for:', document.uri.fsPath);
  }

  /**
   * Handle visible ranges change (scroll) - refresh CodeLens to update which headings are visible.
   */
  private handleVisibleRangesChange(event: vscode.TextEditorVisibleRangesChangeEvent): void {
    // Refresh if we have blame data and either:
    // 1. Toggle AI Code is enabled, or
    // 2. There's a multi-line selection
    if (this.currentBlameResult && (this.toggleAICodeEnabled || this.currentSelection)) {
      this._onDidChangeCodeLenses.fire();
    }
  }

  /**
   * Handle active editor change - refresh CodeLens and reset state.
   */
  private handleActiveEditorChange(editor: vscode.TextEditor | undefined): void {
    // Clear colored borders from previous editor
    const previousEditor = vscode.window.visibleTextEditors.find(
      e => e.document.uri.toString() === this.currentDocumentUri
    );
    if (previousEditor) {
      this.clearColoredBorders(previousEditor);
    }

    // Reset selection state
    this.currentSelection = null;
    // this.statusBarItem.hide();
    
    // If the new editor is a different document, reset our state
    if (editor && editor.document.uri.toString() !== this.currentDocumentUri) {
      this.currentBlameResult = null;
      this.currentDocumentUri = null;
      this.pendingBlameRequest = null;
    }
    
    // If Toggle AI Code is enabled, automatically request blame for the new editor
    if (this.toggleAICodeEnabled && editor) {
      this.requestBlameForFullFile(editor);
    }
    
    // Refresh CodeLens for the new editor
    this._onDidChangeCodeLenses.fire();
  }

  /**
   * Handle Toggle AI Code command - toggles the in-memory state for showing all AI code.
   */
  private handleToggleAICode(): void {
    this.toggleAICodeEnabled = !this.toggleAICodeEnabled;
    
    const editor = vscode.window.activeTextEditor;
    
    if (this.toggleAICodeEnabled) {
      // Toggled ON: request blame and show all AI code
      if (editor) {
        this.requestBlameForFullFile(editor);
      }
      vscode.window.showInformationMessage('Toggle AI Code: ON - Showing all AI-authored code');
    } else {
      // Toggled OFF: clear decorations
      if (editor) {
        this.clearColoredBorders(editor);
      }
      this.currentBlameResult = null;
      this.currentDocumentUri = null;
      this._onDidChangeCodeLenses.fire();
      vscode.window.showInformationMessage('Toggle AI Code: OFF');
    }
  }

  /**
   * Request blame for the full file and apply decorations to all AI-authored lines.
   * Used when Toggle AI Code is enabled.
   */
  private async requestBlameForFullFile(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const documentUri = document.uri.toString();

    // Check if we already have blame for this document
    if (this.currentDocumentUri === documentUri && this.currentBlameResult) {
      this.applyFullFileDecorations(editor, this.currentBlameResult);
      this._onDidChangeCodeLenses.fire();
      return;
    }

    // Request blame
    try {
      // Cancel any pending request for a different document
      if (this.currentDocumentUri !== documentUri) {
        this.pendingBlameRequest = null;
      }

      // Start new request if not already pending
      if (!this.pendingBlameRequest) {
        this.pendingBlameRequest = this.blameService.requestBlame(document, 'high');
        this.currentDocumentUri = documentUri;
      }

      const result = await this.pendingBlameRequest;
      this.pendingBlameRequest = null;

      if (result) {
        this.currentBlameResult = result;
        
        // Check if editor is still active and toggle is still enabled
        const currentEditor = vscode.window.activeTextEditor;
        if (this.toggleAICodeEnabled && currentEditor && currentEditor.document.uri.toString() === documentUri) {
          this.applyFullFileDecorations(currentEditor, result);
          this._onDidChangeCodeLenses.fire();
        }
      }
    } catch (error) {
      console.error('[git-ai] Blame request failed:', error);
      this.pendingBlameRequest = null;
    }
  }

  /**
   * Apply colored borders to ALL AI-authored lines in the entire file.
   * Used when Toggle AI Code is enabled.
   */
  private applyFullFileDecorations(editor: vscode.TextEditor, blameResult: BlameResult): void {
    // Clear existing decorations first
    this.clearColoredBorders(editor);

    // Collect all AI-authored lines grouped by color
    const colorToRanges = new Map<number, vscode.Range[]>();
    
    for (const [gitLine, lineInfo] of blameResult.lineAuthors) {
      if (lineInfo?.isAiAuthored) {
        const colorIndex = this.getColorIndexForPromptId(lineInfo.commitHash);
        const line = gitLine - 1; // Convert to 0-indexed
        
        if (!colorToRanges.has(colorIndex)) {
          colorToRanges.set(colorIndex, []);
        }
        colorToRanges.get(colorIndex)!.push(new vscode.Range(line, 0, line, 0));
      }
    }

    // Apply decorations grouped by color
    colorToRanges.forEach((ranges, colorIndex) => {
      const decoration = this.colorDecorations[colorIndex];
      editor.setDecorations(decoration, ranges);
    });
  }

  private handleSelectionChange(event: vscode.TextEditorSelectionChangeEvent): void {
    const editor = event.textEditor;
    const selection = event.selections[0]; // Primary selection

    // Check if "Show Prompts on Select" is enabled in settings
    const config = vscode.workspace.getConfiguration('gitai');
    const showPromptsOnSelect = config.get<boolean>('showPromptsOnSelect', true);
    
    // If showPromptsOnSelect is disabled, don't respond to selection changes
    // (unless Toggle AI Code is enabled, which handles its own display)
    if (!showPromptsOnSelect) {
      return;
    }

    if (!selection || !editor) {
      this.currentSelection = null;
      this.clearColoredBorders(editor);
      // this.updateStatusBarForCurrentLine(editor);
      this._onDidChangeCodeLenses.fire();
      return;
    }

    // Check if multiple lines are selected
    const isMultiLine = selection.start.line !== selection.end.line;

    if (isMultiLine) {
      this.currentSelection = selection;
      // Request blame for this document and refresh CodeLens
      this.requestBlameAndRefresh(editor, selection);
    } else {
      // Single line - update status bar based on current line
      this.currentSelection = null;
      // Only clear borders if Toggle AI Code is not enabled
      if (!this.toggleAICodeEnabled) {
        this.clearColoredBorders(editor);
      }
      // this.updateStatusBarForCurrentLine(editor);
      this._onDidChangeCodeLenses.fire();
    }
  }

  /**
   * Update status bar based on the current line (cursor position).
   * Shows model name if the current line is AI-authored, otherwise shows human emoji.
   */
  // private async updateStatusBarForCurrentLine(editor: vscode.TextEditor | undefined): Promise<void> {
  //   if (!editor) {
  //     this.statusBarItem.text = '🧑‍💻';
  //     this.statusBarItem.tooltip = 'Human-authored code';
  //     this.statusBarItem.show();
  //     return;
  //   }

  //   const document = editor.document;
  //   const documentUri = document.uri.toString();
  //   const currentLine = editor.selection.active.line;
  //   const gitLine = currentLine + 1; // Convert to 1-indexed

  //   // Check if we have blame for this document
  //   if (this.currentDocumentUri !== documentUri || !this.currentBlameResult) {
  //     // Show human emoji while loading
  //     this.statusBarItem.text = '🧑‍💻';
  //     this.statusBarItem.tooltip = 'Loading...';
  //     this.statusBarItem.show();
  //     
  //     // Request blame for the document
  //     try {
  //       const result = await this.blameService.requestBlame(document, 'normal');
  //       if (result) {
  //         this.currentBlameResult = result;
  //         this.currentDocumentUri = documentUri;
  //       } else {
  //         // Keep showing human emoji if blame fails
  //         this.statusBarItem.text = '🧑‍💻';
  //         this.statusBarItem.tooltip = 'Human-authored code';
  //         this.statusBarItem.show();
  //         return;
  //       }
  //     } catch (error) {
  //       console.error('[git-ai] Failed to get blame for status bar:', error);
  //       // Keep showing human emoji on error
  //       this.statusBarItem.text = '🧑‍💻';
  //       this.statusBarItem.tooltip = 'Human-authored code';
  //       this.statusBarItem.show();
  //       return;
  //     }
  //   }

  //   // Check the current line
  //   const lineInfo = this.currentBlameResult.lineAuthors.get(gitLine);
  //   if (lineInfo?.isAiAuthored) {
  //     const model = lineInfo.promptRecord?.agent_id?.model;
  //     const modelName = this.extractModelName(model);
  //     if (modelName) {
  //       const logo = this.getModelLogo(modelName);
  //       this.statusBarItem.text = logo;
  //       this.statusBarItem.tooltip = `AI Model: ${modelName}`;
  //       this.statusBarItem.show();
  //     } else {
  //       // Show robot emoji if AI-authored but no model name
  //       this.statusBarItem.text = '🤖';
  //       this.statusBarItem.tooltip = 'AI-authored code';
  //       this.statusBarItem.show();
  //     }
  //   } else {
  //     // Show human emoji for human-authored code
  //     this.statusBarItem.text = '🧑‍💻';
  //     this.statusBarItem.tooltip = 'Human-authored code';
  //     this.statusBarItem.show();
  //   }
  // }

  private async requestBlameAndRefresh(
    editor: vscode.TextEditor,
    selection: vscode.Selection
  ): Promise<void> {
    const document = editor.document;
    const documentUri = document.uri.toString();

    // Check if we already have blame for this document
    if (this.currentDocumentUri === documentUri && this.currentBlameResult) {
      this._onDidChangeCodeLenses.fire();
      // this.updateStatusBarForSelection(selection, this.currentBlameResult);
      this.applyColoredBorders(editor, selection, this.currentBlameResult);
      return;
    }

    // Request blame with high priority (current selection)
    try {
      // Cancel any pending request for a different document
      if (this.currentDocumentUri !== documentUri) {
        this.pendingBlameRequest = null;
      }

      // Start new request if not already pending
      if (!this.pendingBlameRequest) {
        this.pendingBlameRequest = this.blameService.requestBlame(document, 'high');
        this.currentDocumentUri = documentUri;
      }

      const result = await this.pendingBlameRequest;
      this.pendingBlameRequest = null;

      if (result) {
        this.currentBlameResult = result;
        
        // Check if the selection is still valid and editor is still active
        const currentEditor = vscode.window.activeTextEditor;
        if (currentEditor && currentEditor.document.uri.toString() === documentUri) {
          const currentSelection = currentEditor.selections[0];
          if (currentSelection && currentSelection.start.line !== currentSelection.end.line) {
            this._onDidChangeCodeLenses.fire();
            // this.updateStatusBarForSelection(currentSelection, result);
            this.applyColoredBorders(currentEditor, currentSelection, result);
          }
        }
      }
    } catch (error) {
      console.error('[git-ai] Blame request failed:', error);
      this.pendingBlameRequest = null;
    }
  }

  /**
   * Provide CodeLens for the document.
   * Shows only ONE CodeLens per unique prompt (commitHash), positioned at the first visible hunk.
   * When Toggle AI Code is enabled, shows CodeLens for ALL AI prompts in the file.
   */
  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];

    // Only show CodeLens for the current document
    if (document.uri.toString() !== this.currentDocumentUri) {
      return codeLenses;
    }

    // If we don't have blame yet, return empty (we'll refresh when we get it)
    if (!this.currentBlameResult) {
      return codeLenses;
    }

    // Determine the line range to scan for AI prompts
    let startLine: number;
    let endLine: number;
    
    if (this.toggleAICodeEnabled) {
      // Toggle mode: scan the entire file
      startLine = 0;
      endLine = document.lineCount - 1;
    } else {
      // Selection mode: only show CodeLens if there's a multi-line selection
      if (!this.currentSelection || this.currentSelection.start.line === this.currentSelection.end.line) {
        return codeLenses;
      }
      startLine = Math.min(this.currentSelection.start.line, this.currentSelection.end.line);
      endLine = Math.max(this.currentSelection.start.line, this.currentSelection.end.line);
    }

    // Get visible range from active editor
    const activeEditor = vscode.window.activeTextEditor;
    let visibleStartLine = startLine;
    let visibleEndLine = endLine;
    
    if (activeEditor && activeEditor.visibleRanges.length > 0) {
      // Use the first visible range (main viewport)
      const visibleRange = activeEditor.visibleRanges[0];
      visibleStartLine = visibleRange.start.line;
      visibleEndLine = visibleRange.end.line;
    }

    // First, count TOTAL lines per prompt across the ENTIRE file
    const totalLinesByPrompt = new Map<string, number>();
    for (const [gitLine, lineInfo] of this.currentBlameResult.lineAuthors) {
      if (lineInfo?.isAiAuthored) {
        const count = totalLinesByPrompt.get(lineInfo.commitHash) || 0;
        totalLinesByPrompt.set(lineInfo.commitHash, count + 1);
      }
    }

    // Group AI lines within the range by commitHash (prompt), tracking line numbers
    const linesByPrompt = new Map<string, { lines: number[]; lineInfo: LineBlameInfo }>();
    
    for (let line = startLine; line <= endLine; line++) {
      const gitLine = line + 1; // Convert to 1-indexed
      const lineInfo = this.currentBlameResult.lineAuthors.get(gitLine);
      
      if (lineInfo?.isAiAuthored) {
        const existing = linesByPrompt.get(lineInfo.commitHash);
        if (existing) {
          existing.lines.push(line);
        } else {
          linesByPrompt.set(lineInfo.commitHash, { lines: [line], lineInfo });
        }
      }
    }

    // For each unique prompt, create one CodeLens at the first visible line
    for (const [commitHash, { lines, lineInfo }] of linesByPrompt) {
      // Use the TOTAL line count from the entire file, not just the selection
      const totalLineCount = totalLinesByPrompt.get(commitHash) || lines.length;
      
      // Find the first line that's in the visible range
      let targetLine = lines.find(line => line >= visibleStartLine && line <= visibleEndLine);
      
      // If no line is visible, use the first line
      if (targetLine === undefined) {
        targetLine = lines[0];
      }
      
      const tool = lineInfo.author;
      const model = lineInfo.promptRecord?.agent_id?.model || 'unknown';
      const humanAuthor = lineInfo.promptRecord?.human_author || '';
      const humanName = this.extractHumanName(humanAuthor);
      
      // Calculate percentage of file
      const totalFileLines = document.lineCount;
      const percentage = Math.round((totalLineCount / totalFileLines) * 100);
      const linesSuffix = `(${totalLineCount} ${totalLineCount === 1 ? 'line' : 'lines'} ${percentage}% of file)`;
      
      const title = `🤖 ${tool}|${model} <${humanName}> ${linesSuffix}`;
      
      const range = new vscode.Range(targetLine, 0, targetLine, 0);
      const codeLens = new vscode.CodeLens(range, {
        title: title,
        command: 'git-ai.showAuthorDetails',
        arguments: [lineInfo, targetLine]
      });
      
      codeLenses.push(codeLens);
    }

    return codeLenses;
  }

  /**
   * Resolve CodeLens (optional, but we can use it to lazy-load data if needed).
   */
  public resolveCodeLens(
    codeLens: vscode.CodeLens,
    token: vscode.CancellationToken
  ): vscode.CodeLens | Thenable<vscode.CodeLens> {
    // We've already provided all the info in provideCodeLenses
    return codeLens;
  }

  /**
   * Get a deterministic color index for a prompt ID using hash modulo.
   * This ensures all users see the same color for the same prompt_id.
   */
  private getColorIndexForPromptId(promptId: string): number {
    // Simple string hash function
    let hash = 0;
    for (let i = 0; i < promptId.length; i++) {
      hash = ((hash << 5) - hash) + promptId.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash) % 40;
  }

  /**
   * Apply colored borders to ALL lines in the file from prompts that appear in the selection.
   * This shows the full extent of each selected prompt's contribution across the entire file.
   */
  private applyColoredBorders(
    editor: vscode.TextEditor,
    selection: vscode.Selection,
    blameResult: BlameResult
  ): void {
    // Clear existing decorations first
    this.clearColoredBorders(editor);

    const startLine = Math.min(selection.start.line, selection.end.line);
    const endLine = Math.max(selection.start.line, selection.end.line);

    // Step 1: Find which prompts (commitHashes) are present in the selection
    const selectedPrompts = new Set<string>();
    for (let line = startLine; line <= endLine; line++) {
      const gitLine = line + 1; // Convert to 1-indexed
      const lineInfo = blameResult.lineAuthors.get(gitLine);
      if (lineInfo?.isAiAuthored) {
        selectedPrompts.add(lineInfo.commitHash);
      }
    }

    if (selectedPrompts.size === 0) {
      return;
    }

    // Step 2: Scan the ENTIRE file and collect all lines from selected prompts
    const colorToRanges = new Map<number, vscode.Range[]>();
    
    for (const [gitLine, lineInfo] of blameResult.lineAuthors) {
      if (lineInfo?.isAiAuthored && selectedPrompts.has(lineInfo.commitHash)) {
        const colorIndex = this.getColorIndexForPromptId(lineInfo.commitHash);
        const line = gitLine - 1; // Convert to 0-indexed
        
        if (!colorToRanges.has(colorIndex)) {
          colorToRanges.set(colorIndex, []);
        }
        colorToRanges.get(colorIndex)!.push(new vscode.Range(line, 0, line, 0));
      }
    }

    // Apply decorations grouped by color
    colorToRanges.forEach((ranges, colorIndex) => {
      const decoration = this.colorDecorations[colorIndex];
      editor.setDecorations(decoration, ranges);
    });
  }

  /**
   * Clear all colored border decorations.
   */
  private clearColoredBorders(editor: vscode.TextEditor): void {
    this.colorDecorations.forEach(decoration => {
      editor.setDecorations(decoration, []);
    });
  }

  /**
   * Update status bar based on the current selection.
   */
  // private updateStatusBarForSelection(
  //   selection: vscode.Selection,
  //   blameResult: BlameResult
  // ): void {
  //   const startLine = Math.min(selection.start.line, selection.end.line);
  //   const endLine = Math.max(selection.start.line, selection.end.line);

  //   // Collect unique model names from AI-authored lines
  //   const modelNames = new Set<string>();
  //   for (let line = startLine; line <= endLine; line++) {
  //     const gitLine = line + 1; // Convert to 1-indexed
  //     const lineInfo = blameResult.lineAuthors.get(gitLine);
  //     if (lineInfo?.isAiAuthored) {
  //       const model = lineInfo.promptRecord?.agent_id?.model;
  //       const modelName = this.extractModelName(model);
  //       if (modelName) {
  //         modelNames.add(modelName);
  //       }
  //     }
  //   }

  //   // Update status bar with model logos
  //   if (modelNames.size > 0) {
  //     // Get unique logos for each model
  //     const logos = Array.from(modelNames).map(name => this.getModelLogo(name));
  //     const uniqueLogos = Array.from(new Set(logos));
  //     const logoText = uniqueLogos.join(' ');
  //     const modelText = Array.from(modelNames).join(' | ');
  //     this.statusBarItem.text = logoText;
  //     this.statusBarItem.tooltip = `AI Models: ${modelText}`;
  //     this.statusBarItem.show();
  //   } else {
  //     // Show human emoji if no AI content in selection
  //     this.statusBarItem.text = '🧑‍💻';
  //     this.statusBarItem.tooltip = 'Human-authored code';
  //     this.statusBarItem.show();
  //   }
  // }

  /**
   * Get the display text for an author.
   * Returns "🤖 {tool}|{model} <Name (human)>" for AI-authored lines.
   */
  private getAuthorDisplayText(lineInfo: LineBlameInfo | undefined, isLoading: boolean): string {
    if (isLoading) {
      return 'Loading...';
    }

    if (lineInfo?.isAiAuthored) {
      const tool = lineInfo.author;
      const model = lineInfo.promptRecord?.agent_id?.model || 'unknown';
      const humanAuthor = lineInfo.promptRecord?.human_author || '';
      const humanName = this.extractHumanName(humanAuthor);
      
      return `🤖 ${tool}|${model} <${humanName}>`;
    }

    return '';
  }

  /**
   * Extract just the name from a git author string like "Aidan Cunniffe <acunniffe@gmail.com>"
   */
  private extractHumanName(authorString: string): string {
    if (!authorString) {
      return 'Unknown';
    }
    
    // Handle format: "Name <email>"
    const match = authorString.match(/^([^<]+)/);
    if (match) {
      return match[1].trim();
    }
    
    return authorString;
  }

  /**
   * Extract model name from model string (e.g., "claude-3-opus-20240229" -> "Claude")
   * Returns the part before the first "-" with first letter capitalized, or null if no model.
   */
  private extractModelName(modelString: string | undefined): string | null {
    if (!modelString || modelString.trim() === '') {
      return null;
    }
    
    const parts = modelString.split('-');
    const firstPart = parts[0];
    
    if (!firstPart || firstPart.trim() === '') {
      return null;
    }
    
    // Capitalize first letter
    return firstPart.charAt(0).toUpperCase() + firstPart.slice(1);
  }

  /**
   * Get the display icon/logo for a model name.
   * Returns the logo/emoji for the model, or 🤖 as fallback.
   * 
   * To add a new model logo, add an entry to the MODEL_LOGOS map below.
   * You can use:
   * - Unicode emojis: '🤖'
   * - Unicode symbols: '⚡'
   * - Text: 'Claude'
   * - Or any string that will be displayed in the status bar
   */
  private getModelLogo(modelName: string | null): string {
    if (!modelName) {
      return '🤖';
    }

    const MODEL_LOGOS: Record<string, string> = {
      // Claude models
      'Claude': '🤖', // TODO: Replace with Claude logo
      
      // OpenAI/Codex models
      'Openai': '🤖', // TODO: Replace with OpenAI Codex logo
      'Codex': '🤖', // TODO: Replace with OpenAI Codex logo
      'Gpt': '🤖', // TODO: Replace with OpenAI logo
      
      // Cursor
      'Cursor': '🤖', // TODO: Replace with Cursor logo
      
      // Grok
      'Grok': '🤖', // TODO: Replace with Grok logo
      
      // Gemini
      'Gemini': '🤖', // TODO: Replace with Gemini logo
    };

    // Normalize model name for lookup (case-insensitive)
    const normalizedName = modelName.charAt(0).toUpperCase() + modelName.slice(1).toLowerCase();
    
    return MODEL_LOGOS[normalizedName] || MODEL_LOGOS[modelName] || '🤖';
  }

  /**
   * Handle CodeLens click - open virtual tab with markdown content.
   */
  private async handleCodeLensClick(lineInfo: LineBlameInfo): Promise<void> {
    // Get document URI from current document or active editor
    let documentUri: vscode.Uri | undefined;
    if (this.currentDocumentUri) {
      documentUri = vscode.Uri.parse(this.currentDocumentUri);
    } else {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        documentUri = activeEditor.document.uri;
      }
    }
    
    const hoverContent = this.buildHoverContent(lineInfo, documentUri);
    const mdString = hoverContent.value;
    
    // Generate a unique ID for this content (using commit hash + timestamp for uniqueness)
    const contentId = `${lineInfo.commitHash}-${Date.now()}`;
    
    // Store the markdown content
    this.markdownContentStore.set(contentId, mdString);
    
    // Create a virtual document URI (use three slashes for empty authority)
    const uri = vscode.Uri.parse(`${BlameLensManager.VIRTUAL_SCHEME}:///${contentId}.md`);
    
    // Open the virtual document in a new tab
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false
      });
    } catch (error) {
      console.error('[git-ai] Failed to open virtual document:', error);
      // Fallback to information message if virtual document fails
      vscode.window.showInformationMessage(mdString, { modal: false });
    }
  }

  private provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.Hover | undefined {
    // Only provide hover if we have blame data
    if (!this.currentBlameResult) {
      return undefined;
    }

    // If Toggle AI Code is enabled, allow hover on any AI-authored line
    // Otherwise, only provide hover within the current selection
    if (!this.toggleAICodeEnabled) {
      if (!this.currentSelection) {
        return undefined;
      }
      
      // Check if the hover position is within the current selection
      const startLine = Math.min(this.currentSelection.start.line, this.currentSelection.end.line);
      const endLine = Math.max(this.currentSelection.start.line, this.currentSelection.end.line);
      
      if (position.line < startLine || position.line > endLine) {
        return undefined;
      }
    }

    // Get blame info for this line (1-indexed)
    const gitLine = position.line + 1;
    const lineInfo = this.currentBlameResult.lineAuthors.get(gitLine);
    
    // Only show hover for AI-authored lines
    if (lineInfo?.isAiAuthored) {
      const hoverContent = this.buildHoverContent(lineInfo, document.uri);
      return new vscode.Hover(hoverContent);
    }

    return undefined;
  }

  /**
   * Build hover content showing author details.
   * Shows a polished chat-style conversation view with clear visual hierarchy.
   */
  private buildHoverContent(lineInfo: LineBlameInfo | undefined, documentUri?: vscode.Uri): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    if (!lineInfo || !lineInfo.isAiAuthored) {
      md.appendMarkdown('👤 **Human-authored code**\n');
      return md;
    }

    const record = lineInfo.promptRecord;
    const messages = record?.messages || [];
    const hasMessages = messages.length > 0 && messages.some(m => m.text);

    // Fallback if no messages saved
    if (!hasMessages) {
      md.appendMarkdown('🔒 *Transcript not saved*\n\n');
      md.appendMarkdown('Enable prompt saving:\n');
      md.appendCodeblock('git-ai config set --add share_prompts_in_repositories "*"', 'bash');
      return md;
    }

    // Parse timestamps and calculate relative times
    const messagesWithTimestamps = messages.map((msg, index) => {
      let timestamp: Date | null = null;
      if (msg.timestamp) {
        timestamp = new Date(msg.timestamp);
      }
      return { ...msg, parsedTimestamp: timestamp, originalIndex: index };
    });

    // Use message 0 as the base if it has a timestamp, otherwise find the first message with a timestamp
    const baseMessage = messagesWithTimestamps[0]?.parsedTimestamp 
      ? messagesWithTimestamps[0]
      : messagesWithTimestamps.find(m => m.parsedTimestamp);
    const baseTimestamp = baseMessage?.parsedTimestamp;
    const baseIndex = baseMessage?.originalIndex ?? -1;

    // Calculate time formats for all messages
    const timeFormats = messagesWithTimestamps.map((msg, index) => {
      if (!msg.parsedTimestamp) {
        return null;
      }
      if (index === baseIndex) {
        // Base message (preferably message 0): show actual date/time
        return this.formatAbsoluteTimestamp(msg.parsedTimestamp);
      } else if (baseTimestamp) {
        // Subsequent messages: show relative time from base message
        const diffMs = msg.parsedTimestamp.getTime() - baseTimestamp.getTime();
        return this.formatRelativeTime(diffMs);
      }
      return null;
    });

    // ═══════════════════════════════════════════════════════════════
    // USER SECTION
    // ═══════════════════════════════════════════════════════════════
    const humanName = this.extractHumanName(record?.human_author || '');
    md.appendMarkdown(`### 💬 ${humanName}\n\n`);

    // Get timestamp from last user message to show right after header
    const userMessages = messagesWithTimestamps.filter(m => m.type === 'user');
    const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
    const lastUserTimestamp = lastUserMessage ? timeFormats[lastUserMessage.originalIndex] : null;
    if (lastUserTimestamp) {
      md.appendMarkdown(`*${lastUserTimestamp}*\n\n`);
    }

    // User messages with left padding via blockquote
    for (const msg of userMessages) {
      if (msg.text) {
        md.appendMarkdown(this.formatMessageWithPadding(msg.text) + '\n\n');
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // AI SECTION
    // ═══════════════════════════════════════════════════════════════
    const model = record?.agent_id?.model || '';
    const tool = record?.agent_id?.tool || lineInfo.author;
    const toolCapitalized = tool.charAt(0).toUpperCase() + tool.slice(1);
    
    // Build AI header: show "model tool" or just "tool" if model is default/auto/empty
    const modelLower = model.toLowerCase();
    const hideModel = !model || modelLower === 'default' || modelLower === 'auto';
    const aiHeader = hideModel ? toolCapitalized : `${model} ${toolCapitalized}`;
    
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`### 🤖 ${aiHeader}\n\n`);

    // Get timestamp from last assistant message to show right after header
    const assistantMessages = messagesWithTimestamps.filter(m => m.type === 'assistant');
    const lastAssistantMessage = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
    const lastAssistantTimestamp = lastAssistantMessage ? timeFormats[lastAssistantMessage.originalIndex] : null;
    if (lastAssistantTimestamp) {
      md.appendMarkdown(`*${lastAssistantTimestamp}*\n\n`);
    }

    // Assistant responses with left padding via blockquote
    for (const msg of assistantMessages) {
      if (msg.text) {
        md.appendMarkdown(this.formatMessageWithPadding(msg.text) + '\n\n');
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // FOOTER
    // ═══════════════════════════════════════════════════════════════
    md.appendMarkdown(`---\n\n`);
    
    // Accepted lines count with checkmark
    const acceptedLines = record?.accepted_lines;
    if (acceptedLines !== undefined && acceptedLines > 0) {
      md.appendMarkdown(`✅ **+${acceptedLines} accepted lines**\n\n`);
    }

    // Other files section - show as clickable links
    const otherFiles = record?.other_files;
    if (otherFiles && otherFiles.length > 0) {
      md.appendMarkdown(`📁 **Other files:**\n\n`);
      
      // Get workspace folder to resolve relative paths
      let workspaceFolder: vscode.WorkspaceFolder | undefined;
      if (documentUri) {
        workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
      }
      
      for (const filePath of otherFiles) {
        // Construct file URI - filePath is relative to repo root
        let fileUri: vscode.Uri;
        if (workspaceFolder) {
          // Resolve relative to workspace folder
          fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
        } else if (documentUri) {
          // Fallback: try to resolve relative to current document's directory
          const docDir = vscode.Uri.joinPath(documentUri, '..');
          fileUri = vscode.Uri.joinPath(docDir, filePath);
        } else {
          // Last resort: assume it's relative to workspace root
          // This might not work, but it's better than nothing
          fileUri = vscode.Uri.file(filePath);
        }
        
        // Create clickable link using command URI to open the file
        // Format: command:commandId?[encodeURIComponent(JSON.stringify([args]))]
        const commandArgs = encodeURIComponent(JSON.stringify([fileUri.toString()]));
        md.appendMarkdown(`- [${filePath}](command:vscode.open?${commandArgs})\n`);
      }
      md.appendMarkdown('\n');
    }

    // Commits section - show as clickable links to view diff
    const commits = record?.commits;
    if (commits && commits.length > 0) {
      md.appendMarkdown(`📝 **Commits:**\n\n`);
      
      // Get workspace folder to resolve git repository
      let workspaceFolder: vscode.WorkspaceFolder | undefined;
      if (documentUri) {
        workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
      }
      
      for (const commitSha of commits) {
        const shortSha = commitSha.substring(0, 7);
        
        if (workspaceFolder) {
          const repoPath = workspaceFolder.uri.fsPath;
          // Use our custom command to open the commit diff
          const commandArgs = encodeURIComponent(JSON.stringify([commitSha, repoPath]));
          md.appendMarkdown(`- \`${shortSha}\` [view diff](command:git-ai.showCommitDiff?${commandArgs})\n`);
        } else {
          // Fallback: just show the SHA without link if we can't resolve repo
          md.appendMarkdown(`- \`${shortSha}\`\n`);
        }
      }
      md.appendMarkdown('\n');
    }

    return md;
  }

  /**
   * Format an absolute timestamp for the first message.
   * Shows a readable date/time format.
   */
  private formatAbsoluteTimestamp(date: Date): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const messageDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    
    // If it's today, show time only
    if (messageDate.getTime() === today.getTime()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    // If it's this year, show month and day
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    
    // Otherwise show full date
    return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Format a relative time difference for subsequent messages.
   * Shows increments like "5 mins later", "1 hr later", etc.
   */
  private formatRelativeTime(diffMs: number): string {
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffDays > 0) {
      return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} later`;
    } else if (diffHours > 0) {
      return `${diffHours} ${diffHours === 1 ? 'hr' : 'hrs'} later`;
    } else if (diffMinutes > 0) {
      return `${diffMinutes} ${diffMinutes === 1 ? 'min' : 'mins'} later`;
    } else if (diffSeconds > 0) {
      return `${diffSeconds} ${diffSeconds === 1 ? 'sec' : 'secs'} later`;
    } else {
      return 'just now';
    }
  }

  /**
   * Format a message for display in the hover with left padding.
   * Uses blockquotes to create a left border/indent effect.
   * Preserves markdown formatting while keeping reasonable length.
   */
  private formatMessageWithPadding(text: string): string {
    // Trim excessive whitespace but preserve structure
    let content = text.trim();
    
    // If message is very long, show first portion with indicator
    const MAX_CHARS = 2000;
    if (content.length > MAX_CHARS) {
      const truncated = content.substring(0, MAX_CHARS);
      // Try to break at a word boundary
      const lastSpace = truncated.lastIndexOf(' ');
      const breakPoint = lastSpace > MAX_CHARS - 200 ? lastSpace : MAX_CHARS;
      content = truncated.substring(0, breakPoint) + '\n\n*... message truncated ...*';
    }
    
    // Convert to blockquote for left padding effect
    // Each line gets prefixed with "> "
    return content
      .split('\n')
      .map(line => '> ' + line)
      .join('\n');
  }

  /**
   * Handle status bar item click - show hover content for first AI-authored line.
   */
  // private handleStatusBarClick(): void {
  //   const editor = vscode.window.activeTextEditor;
  //   if (!editor || !this.currentSelection || !this.currentBlameResult) {
  //     return;
  //   }

  //   const startLine = Math.min(this.currentSelection.start.line, this.currentSelection.end.line);
  //   const endLine = Math.max(this.currentSelection.start.line, this.currentSelection.end.line);

  //   // Find first AI-authored line in selection
  //   let firstAiLine: number | undefined = undefined;
  //   let firstAiLineInfo: LineBlameInfo | undefined = undefined;
  //   for (let line = startLine; line <= endLine; line++) {
  //     const gitLine = line + 1; // Convert to 1-indexed
  //     const lineInfo = this.currentBlameResult.lineAuthors.get(gitLine);
  //     if (lineInfo?.isAiAuthored) {
  //       firstAiLine = line;
  //       firstAiLineInfo = lineInfo;
  //       break;
  //     }
  //   }

  //   if (!firstAiLineInfo || firstAiLine === undefined) {
  //     return;
  //   }

  //   // Build hover content and show as information message
  //   const hoverContent = this.buildHoverContent(firstAiLineInfo, editor.document.uri);
  //   vscode.window.showInformationMessage(hoverContent.value, { modal: false });
  // }

  /**
   * Show commit diff by running git show and displaying in a new tab.
   */
  private async showCommitDiff(commitSha: string, workspacePath: string): Promise<void> {
    const shortSha = commitSha.substring(0, 7);
    
    try {
      const { spawn } = await import('child_process');
      
      // Run git show to get the commit diff
      const diffOutput = await new Promise<string>((resolve, reject) => {
        const proc = spawn('git', ['show', '--color=never', commitSha], {
          cwd: workspacePath
        });
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });
        
        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        proc.on('error', (error) => {
          reject(error);
        });
        
        proc.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`git show failed: ${stderr}`));
          } else {
            resolve(stdout);
          }
        });
      });
      
      // Store the diff content and open as virtual document
      const contentId = `commit-${shortSha}-${Date.now()}`;
      this.markdownContentStore.set(contentId, diffOutput);
      
      // Create a virtual document URI with .diff extension for syntax highlighting
      const uri = vscode.Uri.parse(`${BlameLensManager.VIRTUAL_SCHEME}:///${contentId}.diff`);
      
      // Open the virtual document in a new tab
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: true
      });
      
    } catch (error) {
      console.error('[git-ai] Failed to open commit diff:', error);
      vscode.window.showErrorMessage(
        `Failed to open commit diff for ${shortSha}. ` +
        `You can view it manually with: git show ${commitSha}`
      );
    }
  }

  public dispose(): void {
    // Clear any pending document change timer
    if (this.documentChangeTimer) {
      clearTimeout(this.documentChangeTimer);
      this.documentChangeTimer = null;
    }
    
    this.blameService.dispose();
    // this.statusBarItem.dispose();
    this._onDidChangeCodeLenses.dispose();
    this._onDidChangeVirtualDocument.dispose();
    
    // Clear markdown content store
    this.markdownContentStore.clear();
    
    // Dispose all color decorations
    this.colorDecorations.forEach(decoration => decoration.dispose());
  }
}

/**
 * Register the View Author command (stub for future use)
 */
export function registerBlameLensCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('git-ai.viewAuthor', (lineNumber: number) => {
      vscode.window.showInformationMessage('Hello World');
    })
  );
}
