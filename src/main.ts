import {
  App,
  type ItemView,
  MarkdownView,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  type TAbstractFile,
  TFile,
  editorInfoField,
  setIcon
} from 'obsidian';
import { Annotation, EditorState, Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { applyLinkUpdates, LinkUpdateBatch } from './link-updates';
import { applyGalleryLinkUpdates as applyGalleryUpdates, GalleryLinkUpdate, GalleryUpdateStatus } from './gallery-links';
import { initLocale, t } from './i18n';
import { createSalt, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password';

/** Marks note-lock's own editor re-sync transactions so the filter lets them through. */
const reloadAnnotation = Annotation.define<boolean>();

// --- Settings ---------------------------------------------------------------

interface NoteLockSettings {
  propertyName: string;
  confirmUnlock: boolean;
  showLockBanner: boolean;
  allowLinkUpdates: boolean;
  language: 'auto' | 'en' | 'zh';
  lockedCanvasPaths: string[];
  passwordHash: string;
  passwordSalt: string;
}

const DEFAULT_SETTINGS: NoteLockSettings = {
  propertyName: 'locked',
  confirmUnlock: false,
  showLockBanner: true,
  allowLinkUpdates: true,
  language: 'auto',
  lockedCanvasPaths: [],
  passwordHash: '',
  passwordSalt: ''
};

// --- Constants --------------------------------------------------------------

const BANNER_CLASS = 'note-lock-banner';
const HAS_BANNER_CLASS = 'note-lock-has-banner';
const ACTION_CLASS = 'note-lock-action';
const TITLE_LOCKED_CLASS = 'note-lock-title-locked';
const NOTICE_DEBOUNCE_MS = 2000;

interface CanvasViewLike extends ItemView {
  file?: TFile;
  canvas?: {
    readonly?: boolean;
    readOnly?: boolean;
    setReadOnly?: (readOnly: boolean) => void;
    setReadonly?: (readOnly: unknown) => unknown;
  };
}


// --- Helpers ----------------------------------------------------------------

/** Small confirmation dialog used when "Confirm before unlocking" is enabled. */
class ConfirmUnlockModal extends Modal {
  private resolved = false;

  static confirm(app: App, noteName: string): Promise<boolean> {
    return new Promise((resolve) => {
      new ConfirmUnlockModal(app, noteName, resolve).open();
    });
  }

  constructor(
    app: App,
    private readonly noteName: string,
    private readonly resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t('Unlock "{name}"?', { name: this.noteName }));
    this.contentEl.createEl('p', { text: t('The note will become editable again.') });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t('Unlock'))
        .setCta()
        .onClick(() => {
          this.settle(true);
          this.close();
        }))
      .addButton((button) => button
        .setButtonText(t('Cancel'))
        .onClick(() => this.close()));
  }

  onClose(): void {
    this.settle(false);
    this.contentEl.empty();
  }

  private settle(confirmed: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(confirmed);
  }
}


/** Masked password prompt used before unlocking anything. */
class PasswordPromptModal extends Modal {
  private resolved = false;
  private value = '';

  static ask(app: App, title: string): Promise<string | null> {
    return new Promise((resolve) => {
      new PasswordPromptModal(app, title, resolve).open();
    });
  }

  constructor(
    app: App,
    private readonly title: string,
    private readonly resolve: (value: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.title);
    new Setting(this.contentEl).addText((text) => {
      text.inputEl.type = 'password';
      text.inputEl.autocomplete = 'off';
      text.inputEl.setAttribute('aria-label', t('Password'));
      text.onChange((value) => (this.value = value));
      text.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t('Unlock'))
        .setCta()
        .onClick(() => this.submit()))
      .addButton((button) => button
        .setButtonText(t('Cancel'))
        .onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
  }

  private submit(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(this.value);
    this.close();
  }
}

/** Set, change, or clear the unlock password. All inputs are masked. */
class PasswordSettingsModal extends Modal {
  private current = '';
  private next = '';
  private confirm = '';
  private errorEl!: HTMLElement;

  constructor(app: App, private readonly plugin: NoteLockPlugin) {
    super(app);
  }

  onOpen(): void {
    const hasPassword = this.plugin.settings.passwordHash.length > 0;
    this.setTitle(hasPassword ? t('Change password') : t('Set password'));

    if (hasPassword) {
      this.addPasswordField(t('Current password'), (value) => (this.current = value));
    }
    this.addPasswordField(t('New password'), (value) => (this.next = value));
    this.addPasswordField(t('Confirm new password'), (value) => (this.confirm = value));

    this.errorEl = this.contentEl.createEl('p', { cls: 'note-lock-password-error' });

    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t('Save'))
        .setCta()
        .onClick(() => void this.save()))
      .addButton((button) => button
        .setButtonText(t('Cancel'))
        .onClick(() => this.close()));

    if (hasPassword) {
      new Setting(this.contentEl).addButton((button) => button
        .setButtonText(t('Clear password'))
        .onClick(() => void this.clear()));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private addPasswordField(name: string, onChange: (value: string) => void): void {
    new Setting(this.contentEl).setName(name).addText((text) => {
      text.inputEl.type = 'password';
      text.inputEl.autocomplete = 'off';
      text.onChange(onChange);
    });
  }

  private setError(message: string): void {
    this.errorEl.setText(message);
  }

  private async verifyCurrent(): Promise<boolean> {
    if (!this.plugin.settings.passwordHash) return true;
    if (!this.current) {
      this.setError(t('Current password is incorrect.'));
      return false;
    }
    try {
      const ok = await verifyPassword(
        this.current,
        this.plugin.settings.passwordHash,
        this.plugin.settings.passwordSalt
      );
      if (!ok) this.setError(t('Current password is incorrect.'));
      return ok;
    } catch {
      this.setError(t('Current password is incorrect.'));
      return false;
    }
  }

  private async save(): Promise<void> {
    if (!(await this.verifyCurrent())) return;
    if (this.next.length < MIN_PASSWORD_LENGTH) {
      this.setError(t('Password must be at least 4 characters.'));
      return;
    }
    if (this.next !== this.confirm) {
      this.setError(t('Passwords do not match.'));
      return;
    }
    try {
      const salt = createSalt();
      const hash = await hashPassword(this.next, salt);
      this.plugin.settings.passwordHash = hash;
      this.plugin.settings.passwordSalt = salt;
      await this.plugin.saveSettings();
      this.close();
      new Notice(t('Password set.'));
    } catch {
      this.setError(t('Password must be at least 4 characters.'));
    }
  }

  private async clear(): Promise<void> {
    if (!(await this.verifyCurrent())) return;
    this.plugin.settings.passwordHash = '';
    this.plugin.settings.passwordSalt = '';
    await this.plugin.saveSettings();
    this.close();
    new Notice(t('Password cleared.'));
  }
}

// --- Plugin -----------------------------------------------------------------

export default class NoteLockPlugin extends Plugin {
  settings: NoteLockSettings = DEFAULT_SETTINGS;

  /**
   * Last-known lock state per file path. Written optimistically in setLocked()
   * so the editor filter and vault guard are correct in the window before
   * metadataCache re-parses the frontmatter, and used to detect actual lock
   * flips (workspace.updateOptions() is expensive and must only run on flips).
   */
  private readonly lockStates = new Map<string, boolean>();

  /** Path allowed through the vault guard while our own lock/unlock write runs. */
  private bypassPath: string | null = null;
  private galleryProcess: App['vault']['process'] | null = null;

  /**
   * Per-editor lock state. Initialized when an editor is created and updated
   * by dispatching setLockedEffect from the refresh pass — computed facets are
   * only evaluated at editor creation and workspace.updateOptions() does not
   * reliably re-evaluate them, which left unlocked notes read-only until the
   * editor was recreated.
   */
  private readonly setLockedEffect = StateEffect.define<boolean>();

  private readonly lockedField = StateField.define<boolean>({
    create: (state) => this.stateIsLocked(state),
    update: (value, tr) => {
      for (const effect of tr.effects) {
        if (effect.is(this.setLockedEffect)) return effect.value;
      }
      return value;
    }
  });

  private readonly guardedViews = new WeakSet<MarkdownView>();

  private readonly noticeTimes = new Map<string, number>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerEditorExtension([
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged) return tr;
        const file = tr.startState.field(editorInfoField, false)?.file;
        if (!file || !this.isFileLocked(file)) return tr;
        if (tr.annotation(reloadAnnotation)) return tr;
        // Obsidian reloads an editor from disk as one full-document replacement
        // with no userEvent annotation; sync updates and our own frontmatter
        // write must still render. Anything else is an edit — block it.
        // (Obsidian sometimes reloads as a diff instead; syncEditorsToDisk
        // repairs those after the vault 'modify' event.)
        if (this.isFullDocReplace(tr)) return tr;
        this.notifyBlocked(file);
        return [];
      }),
      this.lockedField,
      EditorView.editable.from(this.lockedField, (locked) => !locked),
      EditorState.readOnly.from(this.lockedField, (locked) => locked),
      // The editable facet above can lose to Obsidian's own higher-precedence
      // provider, leaving a live cursor on locked notes. Attribute sources are
      // applied lowest-precedence first and plugin extensions sit at the
      // bottom of that stack, so the assertion must carry highest precedence
      // to actually land on the DOM. Asserted only while locked so unlocked
      // notes stay entirely Obsidian-managed.
      Prec.highest(EditorView.contentAttributes.from(this.lockedField, (locked): Record<string, string> =>
        locked ? { contenteditable: 'false', 'data-page-lock': 'true' } : {}))
    ]);

    this.installVaultGuard();

    this.addCommand({
      id: 'toggle-lock',
      name: t('Toggle lock on current file'),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || (file.extension !== 'md' && file.extension !== 'canvas')) return false;
        if (!checking) {
          if (file.extension === 'canvas') {
            if (this.isCanvasLocked(file.path)) void this.unlockCanvasFlow(file);
            else void this.setCanvasLocked(file, true);
          } else if (this.isFileLocked(file)) {
            void this.unlockFlow(file);
          } else {
            void this.setLocked(file, true);
          }
        }
        return true;
      }
    });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, abstractFile) => {
      if (!(abstractFile instanceof TFile)) return;
      if (abstractFile.extension !== 'md' && abstractFile.extension !== 'canvas') return;
      const isCanvas = abstractFile.extension === 'canvas';
      const locked = isCanvas ? this.isCanvasLocked(abstractFile.path) : this.isFileLocked(abstractFile);
      const label = isCanvas
        ? t(locked ? 'Unlock canvas' : 'Lock canvas')
        : t(locked ? 'Unlock note' : 'Lock note');
      menu.addItem((item) => item
        .setTitle(label)
        .setIcon(locked ? 'lock-open' : 'lock')
        .setSection('action')
        .onClick(() => {
          if (isCanvas) {
            if (locked) void this.unlockCanvasFlow(abstractFile);
            else void this.setCanvasLocked(abstractFile, true);
          } else if (locked) {
            void this.unlockFlow(abstractFile);
          } else {
            void this.setLocked(abstractFile, true);
          }
        }));
    }));

    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      this.handleMetadataChanged(file);
    }));

    this.registerEvent(this.app.vault.on('rename', (abstractFile, oldPath) => {
      const state = this.lockStates.get(oldPath);
      this.lockStates.delete(oldPath);
      this.noticeTimes.delete(oldPath);
      if (state !== undefined) this.lockStates.set(abstractFile.path, state);
      const canvasIndex = this.settings.lockedCanvasPaths.indexOf(oldPath);
      if (canvasIndex !== -1) {
        this.settings.lockedCanvasPaths[canvasIndex] = abstractFile.path;
        void this.saveSettings();
      }
    }));

    this.registerEvent(this.app.vault.on('delete', (abstractFile) => {
      this.lockStates.delete(abstractFile.path);
      this.noticeTimes.delete(abstractFile.path);
      const canvasIndex = this.settings.lockedCanvasPaths.indexOf(abstractFile.path);
      if (canvasIndex !== -1) {
        this.settings.lockedCanvasPaths.splice(canvasIndex, 1);
        void this.saveSettings();
      }
    }));

    // Obsidian's disk->editor reload is not always the full-document replacement
    // the transaction filter allows — it can apply a cursor-preserving diff,
    // which the filter blocks, leaving the editor stale after our frontmatter
    // write or a sync update. Re-sync stale editors ourselves.
    this.registerEvent(this.app.vault.on('modify', (abstractFile) => {
      if (abstractFile instanceof TFile && this.isFileLocked(abstractFile)) {
        window.setTimeout(() => void this.syncEditorsToDisk(abstractFile), 100);
      }
    }));

    this.registerEvent(this.app.workspace.on('file-open', () => this.refreshAllViews()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshAllViews()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.refreshAllViews()));
    this.app.workspace.onLayoutReady(() => this.refreshAllViews());

    this.addSettingTab(new NoteLockSettingTab(this.app, this));
  }

  onunload(): void {
    for (const view of this.allMarkdownViews()) this.clearViewDecorations(view);
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== 'canvas') return;
      const canvas = (leaf.view as CanvasViewLike).canvas;
      if (!canvas) return;
      if (typeof canvas.setReadonly === 'function') canvas.setReadonly(false);
      else if (typeof canvas.setReadOnly === 'function') canvas.setReadOnly(false);
      else {
        canvas.readonly = false;
        canvas.readOnly = false;
      }
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<NoteLockSettings> | null);
    this.settings.lockedCanvasPaths = Array.isArray(this.settings.lockedCanvasPaths)
      ? this.settings.lockedCanvasPaths.filter((path): path is string => typeof path === 'string')
      : [];
    this.settings.passwordHash = typeof this.settings.passwordHash === 'string' ? this.settings.passwordHash : '';
    this.settings.passwordSalt = typeof this.settings.passwordSalt === 'string' ? this.settings.passwordSalt : '';
    initLocale(this.settings.language);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Re-evaluates every open editor and view after a settings change. */
  applySettingsChange(clearStates: boolean): void {
    if (clearStates) this.lockStates.clear();
    this.refreshAllViews();
  }

  // --- Lock state ---

  isFileLocked(file: TFile): boolean {
    if (file.extension !== 'md') return false;
    const cached = this.lockStates.get(file.path);
    if (cached !== undefined) return cached;
    return this.readFrontmatterLock(file);
  }

  private readFrontmatterLock(file: TFile): boolean {
    const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.settings.propertyName];
    return value === true || value === 'true';
  }

  private stateIsLocked(state: EditorState): boolean {
    const file = state.field(editorInfoField, false)?.file;
    return !!file && this.isFileLocked(file);
  }

  private isFullDocReplace(tr: Transaction): boolean {
    if (tr.annotation(Transaction.userEvent) !== undefined) return false;
    let changeCount = 0;
    let coversWholeDoc = false;
    tr.changes.iterChanges((fromA, toA) => {
      changeCount += 1;
      if (fromA === 0 && toA === tr.startState.doc.length) coversWholeDoc = true;
    });
    return changeCount === 1 && coversWholeDoc;
  }

  private handleMetadataChanged(file: TFile): void {
    if (file.extension !== 'md') return;
    const locked = this.readFrontmatterLock(file);
    const previous = this.lockStates.get(file.path);
    if (previous === locked) return;
    this.lockStates.set(file.path, locked);
    // Refresh on any flip, and on a lock first seen via sync/external edit.
    if (previous !== undefined || locked) {
      this.refreshAllViews();
    }
  }

  // --- Lock toggle (the single write path) ---

  async setLocked(file: TFile, locked: boolean): Promise<void> {
    if (locked) {
      // Flush pending debounced saves so the vault guard can never strand
      // keystrokes typed just before locking.
      for (const view of this.allMarkdownViews()) {
        if (view.file?.path === file.path) await view.save();
      }
    }
    this.lockStates.set(file.path, locked);
    this.bypassPath = file.path;
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        if (locked) frontmatter[this.settings.propertyName] = true;
        else delete frontmatter[this.settings.propertyName];
      });
      if (!locked) await this.removeEmptyFrontmatter(file);
      new Notice(t(locked ? 'Locked "{name}"' : 'Unlocked "{name}"', { name: file.basename }));
    } catch (error) {
      this.lockStates.delete(file.path);
      new Notice(t('Page Lock: could not update "{name}"', { name: file.basename }));
      console.error('Page Lock: failed to update frontmatter', error);
    } finally {
      this.bypassPath = null;
    }
    // Re-sync immediately (not only via the delayed vault-modify path) so
    // anything reacting to the metadata change sees a fresh editor.
    if (locked) await this.syncEditorsToDisk(file);
    this.refreshAllViews();
  }

  /**
   * processFrontMatter can leave an empty `---` block behind when the lock was
   * the note's only property; strip it so no phantom lines remain after unlock.
   */
  private async removeEmptyFrontmatter(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    const match = content.match(/^---[ \t]*\n(?:[ \t]*\n)*---[ \t]*\r?\n?/);
    if (!match) return;
    await this.app.vault.modify(file, content.slice(match[0].length));
  }

  private async syncEditorsToDisk(file: TFile): Promise<void> {
    if (!this.isFileLocked(file)) return;
    let content: string;
    try {
      content = await this.app.vault.cachedRead(file);
    } catch {
      return;
    }
    for (const view of this.allMarkdownViews()) {
      if (view.file?.path !== file.path) continue;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm || cm.state.doc.toString() === content) continue;
      cm.dispatch({
        changes: { from: 0, to: cm.state.doc.length, insert: content },
        annotations: reloadAnnotation.of(true)
      });
    }
  }

  private async unlockFlow(file: TFile): Promise<void> {
    if (this.settings.passwordHash) {
      if (!(await this.requireUnlockPassword())) return;
    } else if (this.settings.confirmUnlock) {
      const confirmed = await ConfirmUnlockModal.confirm(this.app, file.basename);
      if (!confirmed) return;
    }
    await this.setLocked(file, false);
  }

  private async requireUnlockPassword(): Promise<boolean> {
    if (!this.settings.passwordHash) return true;
    const password = await PasswordPromptModal.ask(this.app, t('Enter password to unlock'));
    if (password === null) return false;
    try {
      const ok = await verifyPassword(
        password,
        this.settings.passwordHash,
        this.settings.passwordSalt
      );
      if (!ok) new Notice(t('Incorrect password'));
      return ok;
    } catch {
      new Notice(t('Incorrect password'));
      return false;
    }
  }

  // --- Vault guard (blocks writes from any plugin, not just the editor) ---

  private installVaultGuard(): void {
    const vault = this.app.vault;
    const originalModify = vault.modify.bind(vault);
    const originalAppend = vault.append.bind(vault);
    const originalProcess = vault.process.bind(vault);
    this.galleryProcess = originalProcess;
    this.installLinkUpdateHandler(originalProcess);
    const fileManager = this.app.fileManager;
    const originalFrontMatter = fileManager.processFrontMatter.bind(fileManager);
    const originalDelete = typeof vault.delete === 'function' ? vault.delete.bind(vault) : null;
    const originalTrash = typeof vault.trash === 'function' ? vault.trash.bind(vault) : null;
    const originalTrashFile = typeof fileManager.trashFile === 'function'
      ? fileManager.trashFile.bind(fileManager)
      : null;
    const rejectDelete = (file: TAbstractFile): void => {
      if (!this.isProtected(file)) return;
      new Notice(t('"{name}" is locked — unlock before deleting', { name: file.name }));
      throw new Error(`Page Lock: "${file.path}" is locked`);
    };
    if (originalDelete) {
      vault.delete = async (file, force) => {
        rejectDelete(file);
        return originalDelete(file, force);
      };
    }
    if (originalTrash) {
      vault.trash = async (file, system) => {
        rejectDelete(file);
        return originalTrash(file, system);
      };
    }
    if (originalTrashFile) {
      fileManager.trashFile = async (file) => {
        rejectDelete(file);
        return originalTrashFile(file);
      };
    }
    const guard = (file: TFile): Promise<never> | null => this.guardRejection(file);

    // The read-only editor still flushes saves (mode switches, interval saves);
    // those carry unchanged content and must succeed as no-ops, or Obsidian
    // shows "failed to save" and refuses to switch to reading mode.
    vault.modify = async (file, data, options) => {
      if (this.isGuarded(file)) {
        if (data === await vault.cachedRead(file)) return;
        this.notifyBlocked(file);
        throw new Error(`Page Lock: "${file.path}" is locked`);
      }
      return originalModify(file, data, options);
    };
    vault.append = (file, data, options) => guard(file) ?? originalAppend(file, data, options);
    // Same no-op tolerance for process: a transform that leaves the content
    // unchanged is not an edit, and some Obsidian save paths go through here.
    vault.process = async (file, fn, options) => {
      if (this.isGuarded(file)) {
        const current = await vault.cachedRead(file);
        const result = fn(current);
        if (result === current) return result;
        this.notifyBlocked(file);
        throw new Error(`Page Lock: "${file.path}" is locked`);
      }
      return originalProcess(file, fn, options);
    };

    // Meta Bind and property widgets can use this path without going through
    // the public vault methods. Reject before their callback changes metadata.
    fileManager.processFrontMatter = (file, fn, options) =>
      guard(file) ?? originalFrontMatter(file, fn, options);

    this.register(() => {
      this.galleryProcess = null;
      fileManager.processFrontMatter = originalFrontMatter;
      vault.modify = originalModify;
      vault.append = originalAppend;
      vault.process = originalProcess;
      if (originalDelete) vault.delete = originalDelete;
      if (originalTrash) vault.trash = originalTrash;
      if (originalTrashFile) fileManager.trashFile = originalTrashFile;
    });
  }

  /** Destination-only gallery repair; never opens a general write bypass. */
  async applyGalleryLinkUpdates(file: TFile, updates: GalleryLinkUpdate[]): Promise<GalleryUpdateStatus> {
    const process = this.galleryProcess;
    if (!process || !this.settings.allowLinkUpdates) return 'blocked';
    if (!Array.isArray(updates)) return 'stale';
    let status: GalleryUpdateStatus = 'unchanged';
    await process(file, content => {
      if (this.galleryProcess !== process || !this.settings.allowLinkUpdates) { status = 'blocked'; return content; }
      const changed = applyGalleryUpdates(content, updates);
      if (changed === null) { status = 'stale'; return content; }
      status = changed === content ? 'unchanged' : 'applied';
      return changed;
    });
    return status;
  }

  private installLinkUpdateHandler(process: App['vault']['process']): void {
    // Obsidian exposes no public rename-replacement event. This internal hook
    // receives the exact reference replacements, after its update-links prompt.
    // Feature-detect it: unknown versions retain full write protection.
    const cache = this.app.metadataCache as App['metadataCache'] & {
      updateInternalLinks?: (updates: LinkUpdateBatch) => Promise<void>;
    };
    const original = cache.updateInternalLinks;
    if (typeof original !== 'function') return;
    const handler = async (updates: LinkUpdateBatch): Promise<void> => {
      const remaining: string[] = [];
      for (const path of updates.keys()) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || !this.isGuarded(file)) {
          remaining.push(path);
          continue;
        }
        if (!this.settings.allowLinkUpdates) continue;
        const replacements = updates.get(path);
        // Use the original atomic process method with our own constrained
        // transform. Never unlock the note or bypass guards for other callers.
        await process(file, (content) => {
          if (!this.settings.allowLinkUpdates) return content;
          const result = applyLinkUpdates(content, replacements);
          if (result === null) {
            new Notice(t('Page Lock: links in "{name}" changed before the rename could update them; the note was left unchanged.', { name: file.basename }));
            return content;
          }
          return result;
        });
      }
      if (remaining.length) {
        await original.call(cache, { keys: () => remaining, get: (path) => updates.get(path) });
      }
    };
    cache.updateInternalLinks = handler;
    this.register(() => {
      if (cache.updateInternalLinks === handler) cache.updateInternalLinks = original;
    });
  }

  private isGuarded(file: TFile): boolean {
    if (!(file instanceof TFile)) return false;
    const locked = file.extension === 'canvas'
      ? this.isCanvasLocked(file.path)
      : file.extension === 'md' && this.isFileLocked(file);
    return file.path !== this.bypassPath && locked;
  }

  private isProtected(file: TAbstractFile): boolean {
    if (!(file instanceof TFile)) return false;
    if (file.extension === 'canvas') return this.isCanvasLocked(file.path);
    return file.extension === 'md' && this.isFileLocked(file);
  }

  private guardRejection(file: TFile): Promise<never> | null {
    if (!this.isGuarded(file)) return null;
    this.notifyBlocked(file);
    return Promise.reject(new Error(`Page Lock: "${file.path}" is locked`));
  }

  private notifyBlocked(file: TFile): void {
    const now = Date.now();
    const last = this.noticeTimes.get(file.path) ?? 0;
    if (now - last < NOTICE_DEBOUNCE_MS) return;
    this.noticeTimes.set(file.path, now);
    new Notice(t('"{name}" is locked — unlock to edit', { name: file.basename }));
  }

  // --- View decorations (banner, dim, view action) ---

  private allMarkdownViews(): MarkdownView[] {
    const views: MarkdownView[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) views.push(leaf.view);
    });
    return views;
  }

  refreshAllViews(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view instanceof MarkdownView) this.refreshView(view);
      else if (view.getViewType() === 'canvas') this.refreshCanvasView(view as CanvasViewLike);
    });
  }

  isCanvasLocked(path: string): boolean {
    return this.settings.lockedCanvasPaths.includes(path);
  }

  private async setCanvasLocked(file: TFile, locked: boolean): Promise<void> {
    const paths = new Set(this.settings.lockedCanvasPaths);
    if (locked) paths.add(file.path);
    else paths.delete(file.path);
    this.settings.lockedCanvasPaths = [...paths];
    await this.saveSettings();
    this.refreshAllViews();
    new Notice(t(locked ? 'Locked canvas "{name}"' : 'Unlocked canvas "{name}"', { name: file.basename }));
  }

  private async unlockCanvasFlow(file: TFile): Promise<void> {
    if (this.settings.passwordHash) {
      if (!(await this.requireUnlockPassword())) return;
    } else if (this.settings.confirmUnlock) {
      const confirmed = await ConfirmUnlockModal.confirm(this.app, file.basename);
      if (!confirmed) return;
    }
    await this.setCanvasLocked(file, false);
  }

  private refreshCanvasView(view: CanvasViewLike): void {
    const file = view.file;
    if (!file || file.extension !== 'canvas') return;
    const locked = this.isCanvasLocked(file.path);
    const canvas = view.canvas;
    if (canvas) {
      if (typeof canvas.setReadonly === 'function') canvas.setReadonly(locked);
      else if (typeof canvas.setReadOnly === 'function') canvas.setReadOnly(locked);
      else {
        canvas.readonly = locked;
        canvas.readOnly = locked;
      }
    }
    view.containerEl.querySelectorAll(`.${ACTION_CLASS}`).forEach((el) => el.remove());
    const action = locked
      ? view.addAction('lock', t('Unlock canvas'), () => void this.unlockCanvasFlow(file))
      : view.addAction('lock-open', t('Lock canvas'), () => void this.setCanvasLocked(file, true));
    action.addClass(ACTION_CLASS);
  }

  /** Stop widgets before their handlers update local state or queue a save. */
  private installControlGuard(view: MarkdownView): void {
    if (this.guardedViews.has(view)) return;
    this.guardedViews.add(view);
    const intercept = (event: Event): void => {
      // Use the event path so controls also work in detached Obsidian windows.
      const target = event.composedPath()[0] as Element | undefined;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest(`.${BANNER_CLASS}, .${ACTION_CLASS}`)) return;
      const control = target.closest([
        '.image-resize-corner', '.image-embed .edit-block-button', '.ik-edit-btn',
        '.simple-gallery-item-menu', '.simple-gallery-settings-button',
        '.simple-gallery-caption', '.simple-gallery-section-title', '.simple-gallery-section-remove',
        'input', 'textarea', 'select',
        '[role="checkbox"]', '[role="switch"]', '[role="slider"]',
        '[role="spinbutton"]', '[role="combobox"]',
        '.checkbox-container', '.task-list-item-checkbox',
        '.mb-input', '.mb-input-wrapper', '.mb-button',
        '.metadata-property-value',
        '[contenteditable="true"]:not(.cm-content)'
      ].join(', '));
      // Clicking an associated label activates its input too.
      const label = target.closest('label');
      const image = target.closest('.image-embed, .simple-gallery-item');
      const imageGesture = image && ['dragstart', 'drop', 'cut', 'contextmenu', 'dblclick'].includes(event.type);
      const imageKey = image && event.type === 'keydown' &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete', 'Enter', 'F2'].includes((event as KeyboardEvent).key);
      if (!control && !label?.control && !imageGesture && !imageKey) return;
      let file = view.file;
      const embed = target.closest('.internal-embed:not(.image-embed)[src]');
      const source = embed?.getAttribute('src');
      if (source && file) {
        const embeddedFile = this.app.metadataCache.getFirstLinkpathDest(source.split('#')[0], file.path);
        // A locked host also protects controls bound to other notes.
        if (!this.isFileLocked(file) && embeddedFile) file = embeddedFile;
      }
      if (!file || !this.isFileLocked(file)) return;
      if (event.type === 'keydown') {
        const key = event as KeyboardEvent;
        // Preserve keyboard navigation and copying values from locked fields.
        if (key.key === 'Tab' || key.key === 'Escape' ||
          ((key.ctrlKey || key.metaKey) && ['a', 'c'].includes(key.key.toLowerCase()))) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.notifyBlocked(file);
    };
    // Capture on the view, before native checkbox activation, Meta Bind's
    // handlers, and CodeMirror widgets. Delegation covers subsequent renders.
    for (const name of ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick',
      'keydown', 'beforeinput', 'input', 'change', 'paste', 'cut', 'drop', 'dragstart', 'contextmenu']) {
      this.registerDomEvent(view.contentEl, name as keyof HTMLElementEventMap, intercept,
        { capture: true, passive: false });
    }
  }

  private clearViewDecorations(view: MarkdownView): void {
    view.contentEl.classList.remove('note-lock-images-locked');
    view.contentEl.querySelectorAll(`.${BANNER_CLASS}`).forEach((el) => el.remove());
    view.containerEl.querySelectorAll(`.${ACTION_CLASS}`).forEach((el) => el.remove());
    view.contentEl.querySelector<HTMLElement>('.markdown-source-view')
      ?.removeClasses([HAS_BANNER_CLASS]);
    view.contentEl.querySelectorAll<HTMLElement>(`.inline-title.${TITLE_LOCKED_CLASS}`).forEach((el) => {
      el.contentEditable = 'true';
      el.removeClass(TITLE_LOCKED_CLASS);
    });
  }

  private refreshView(view: MarkdownView): void {
    this.installControlGuard(view);
    this.clearViewDecorations(view);
    const file = view.file;
    if (!file || file.extension !== 'md') return;
    const locked = this.isFileLocked(file);
    view.contentEl.classList.toggle('note-lock-images-locked', locked);

    const cm = (view.editor as unknown as { cm?: EditorView }).cm;
    if (cm && cm.state.field(this.lockedField, false) !== locked) {
      cm.dispatch({ effects: this.setLockedEffect.of(locked) });
    }

    const action = locked
      ? view.addAction('lock', t('Unlock note'), () => void this.unlockFlow(file))
      : view.addAction('lock-open', t('Lock note'), () => void this.setLocked(file, true));
    action.addClass(ACTION_CLASS);

    if (!locked) return;

    // The inline title is a contenteditable element outside CodeMirror; left
    // alone it would still allow renaming a locked note.
    view.contentEl.querySelectorAll<HTMLElement>('.inline-title').forEach((el) => {
      el.contentEditable = 'false';
      el.addClass(TITLE_LOCKED_CLASS);
    });

    if (!this.settings.showLockBanner) return;

    const sourceView = view.contentEl.querySelector<HTMLElement>('.markdown-source-view');
    if (sourceView) {
      const banner = sourceView.createDiv({
        cls: BANNER_CLASS,
        attr: { role: 'button', tabindex: '0', 'aria-label': t('Unlock note') }
      });
      setIcon(banner.createSpan({ cls: 'note-lock-banner-icon' }), 'lock');
      banner.createSpan({
        cls: 'note-lock-banner-text',
        text: t('Locked — {action} to unlock', { action: t(Platform.isMobile ? 'tap' : 'click') })
      });
      banner.addEventListener('click', () => void this.unlockFlow(file));
      banner.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void this.unlockFlow(file);
      });
      // Mobile places the toolbar over the editor. Put our banner in the
      // note's existing content inset, before the inline title, so we reuse
      // Obsidian's safe-area spacing without moving its floating controls.
      const title = Platform.isMobile ? sourceView.querySelector('.inline-title') : null;
      const sizer = Platform.isMobile ? sourceView.querySelector('.cm-sizer') : null;
      if (title?.parentElement) {
        title.before(banner);
      } else if (sizer) {
        sizer.prepend(banner);
      } else {
        sourceView.addClass(HAS_BANNER_CLASS);
        if (Platform.isMobile) banner.addClass('note-lock-banner-fallback');
        sourceView.prepend(banner);
      }
    }
  }
}

// --- Settings tab -----------------------------------------------------------

class NoteLockSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: NoteLockPlugin) {
    super(app, plugin);
  }

  /** Declarative settings (Obsidian 1.13+): makes settings appear in Obsidian's settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: t('Lock property name'),
        desc: t('Frontmatter property that marks a note as locked. The lock travels with the note, so it syncs to other devices. Existing notes keep any previously used property.'),
        aliases: ['frontmatter', 'property', 'locked', '属性', '锁定'],
        control: {
          type: 'text',
          key: 'propertyName',
          defaultValue: DEFAULT_SETTINGS.propertyName,
          placeholder: DEFAULT_SETTINGS.propertyName
        }
      },
      {
        name: t('Show locked-note banner'),
        desc: t('Show the locked-note banner above the note. Turn off to use only the header lock icon; editing protection stays active.'),
        aliases: ['notification', 'hide banner', 'lock indicator', '横幅', '提示'],
        control: { type: 'toggle', key: 'showLockBanner', defaultValue: DEFAULT_SETTINGS.showLockBanner }
      },
      {
        name: t('Allow automatic link updates'),
        desc: t('Allow Obsidian to update links in locked notes when linked files are renamed or moved. Only the affected links change; other edits stay blocked. Turn off to keep those links unchanged.'),
        aliases: ['rename', 'move', 'links', 'references', '链接', '重命名'],
        control: { type: 'toggle', key: 'allowLinkUpdates', defaultValue: DEFAULT_SETTINGS.allowLinkUpdates }
      },
      {
        name: t('Confirm before unlocking'),
        desc: t('Ask for confirmation before unlocking a note, preventing accidental unlocks from a stray tap.'),
        aliases: ['confirmation', 'accidental unlock', '确认', '误触'],
        control: {
          type: 'toggle',
          key: 'confirmUnlock',
          defaultValue: DEFAULT_SETTINGS.confirmUnlock
        }
      },
      {
        name: t('Unlock password'),
        desc: this.plugin.settings.passwordHash
          ? t('A password is set. Unlocking requires it.')
          : t('Set a password to require verification before unlocking a note or canvas. Only a hash is stored.'),
        aliases: ['password', '密码', '解锁'],
        render: (setting) => {
          setting.addButton((button) => button
            .setButtonText(this.plugin.settings.passwordHash ? t('Change password') : t('Set password'))
            .onClick(() => new PasswordSettingsModal(this.app, this.plugin).open()));
        }
      },
      {
        name: t('Language'),
        desc: t("Choose the language used by Page Lock. Follow Obsidian keeps it in sync with Obsidian's language."),
        aliases: ['language', '语言', '中文'],
        control: {
          type: 'dropdown',
          key: 'language',
          options: {
            auto: t('Follow Obsidian'),
            en: 'English',
            zh: '简体中文'
          },
          defaultValue: DEFAULT_SETTINGS.language
        }
      }
    ];
  }

  getControlValue(key: string): unknown {
    switch (key) {
      case 'propertyName': return this.plugin.settings.propertyName;
      case 'showLockBanner': return this.plugin.settings.showLockBanner;
      case 'allowLinkUpdates': return this.plugin.settings.allowLinkUpdates;
      case 'confirmUnlock': return this.plugin.settings.confirmUnlock;
      case 'language': return this.plugin.settings.language;
      default: return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    switch (key) {
      case 'propertyName':
        if (typeof value === 'string') await this.applyPropertyName(value);
        return;
      case 'showLockBanner':
        if (typeof value !== 'boolean') return;
        this.plugin.settings.showLockBanner = value;
        this.plugin.applySettingsChange(false);
        await this.plugin.saveSettings();
        return;
      case 'confirmUnlock':
        if (typeof value !== 'boolean') return;
        this.plugin.settings.confirmUnlock = value;
        await this.plugin.saveSettings();
        return;
      case 'allowLinkUpdates':
        if (typeof value !== 'boolean') return;
        this.plugin.settings.allowLinkUpdates = value;
        await this.plugin.saveSettings();
        return;
      case 'language':
        if (value !== 'auto' && value !== 'en' && value !== 'zh') return;
        this.plugin.settings.language = value;
        initLocale(value);
        await this.plugin.saveSettings();
        this.plugin.applySettingsChange(false);
        new Notice(t('Language changed. Restart Obsidian to update command names.'));
        return;
    }
  }

  private async applyPropertyName(raw: string): Promise<void> {
    const name = raw.trim() || DEFAULT_SETTINGS.propertyName;
    if (name === this.plugin.settings.propertyName) return;
    this.plugin.settings.propertyName = name;
    await this.plugin.saveSettings();
    this.plugin.applySettingsChange(true);
  }

  /**
   * Imperative fallback for Obsidian versions older than 1.13.0, where
   * getSettingDefinitions() isn't recognized. Not called at all on 1.13+,
   * where the declarative definitions above render instead.
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(t('Lock property name'))
      .setDesc(t('Frontmatter property that marks a note as locked. The lock travels with the note, so it syncs to other devices. Existing notes keep any previously used property.'))
      .addText((text) => text
        .setPlaceholder(DEFAULT_SETTINGS.propertyName)
        .setValue(this.plugin.settings.propertyName)
        .onChange(async (value) => {
          await this.applyPropertyName(value);
        }));

    new Setting(containerEl)
      .setName(t('Show locked-note banner'))
      .setDesc(t('Show the locked-note banner above the note. Turn off to use only the header lock icon; editing protection stays active.'))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.showLockBanner)
        .onChange(async (value) => {
          await this.setControlValue('showLockBanner', value);
        }));

    new Setting(containerEl)
      .setName(t('Allow automatic link updates'))
      .setDesc(t('Allow Obsidian to update links in locked notes when linked files are renamed or moved. Only the affected links change; other edits stay blocked. Turn off to keep those links unchanged.'))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.allowLinkUpdates)
        .onChange(async (value) => {
          await this.setControlValue('allowLinkUpdates', value);
        }));

    new Setting(containerEl)
      .setName(t('Confirm before unlocking'))
      .setDesc(t('Ask for confirmation before unlocking a note, preventing accidental unlocks from a stray tap.'))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.confirmUnlock)
        .onChange(async (value) => {
          this.plugin.settings.confirmUnlock = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t('Unlock password'))
      .setDesc(this.plugin.settings.passwordHash
        ? t('A password is set. Unlocking requires it.')
        : t('Set a password to require verification before unlocking a note or canvas. Only a hash is stored.'))
      .addButton((button) => button
        .setButtonText(this.plugin.settings.passwordHash ? t('Change password') : t('Set password'))
        .onClick(() => new PasswordSettingsModal(this.app, this.plugin).open()));

    new Setting(containerEl)
      .setName(t('Language'))
      .setDesc(t("Choose the language used by Page Lock. Follow Obsidian keeps it in sync with Obsidian's language."))
      .addDropdown((dropdown) => dropdown
        .addOption('auto', t('Follow Obsidian'))
        .addOption('en', 'English')
        .addOption('zh', '简体中文')
        .setValue(this.plugin.settings.language)
        .onChange(async (value) => {
          await this.setControlValue('language', value);
        }));
  }
}
