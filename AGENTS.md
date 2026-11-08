# Page Lock development

- This directory is the authoritative source repository. Do not develop from the installed copy in an Obsidian vault.
- `origin` is the private Forgejo repository; `github` is the public GitHub repository (`obsidian-page-lock`).
- Keep `main` clean and release the exact same commit to both remotes.
- Run lint and the production build before publishing.
- Publish through `/Users/robertfleming/vaults/obsidian-vault/_obsidian-os/scripts/release-obsidian-plugin page-lock`.
- The publisher installs only runtime artifacts into the primary vault and preserves its existing `data.json` settings.
- Never add a vault's `data.json` or other user-specific settings to this source repository.
- `npm run publish:vault` builds and installs the runtime artifacts into the
  primary vault (`/Users/robertfleming/vaults/obsidian-vault`, overridable via
  `OBSIDIAN_VAULT`), preserving the vault's `data.json` and writing a
  `.release.json` provenance record. `npm run ship` does that and then pushes
  `origin`. Neither command touches the `github` remote — GitHub remains a
  deliberate, manual release push.

## Design notes

- Lock state is the frontmatter property (default `locked`); `lockStates` in `src/main.ts` is
  only an optimistic cache for flip detection — frontmatter is the source of truth.
- The editor transaction filter allows one escape hatch: a single full-document replacement with
  no `userEvent` annotation (Obsidian's disk→editor reload). A plugin doing a programmatic
  full-document replace can therefore transiently change the display, but the vault guard blocks
  persistence — accepted trade-off.
- The write guards patch `vault.modify`/`append`/`process` and
  `fileManager.processFrontMatter`. Rendered controls are guarded at the view capture phase. The adapter is deliberately
  untouched so Obsidian Sync and external tools can always update locked files.
- `workspace.updateOptions()` is expensive; call it only on actual lock flips.
- Automatic link updates intercept the feature-detected internal
  `metadataCache.updateInternalLinks` batch. Locked notes use the captured atomic
  `vault.process` with only verified reference replacements; no temporary unlock,
  bypass flag, or broad permission window. Other files retain the native updater.
- `src/link-updates.ts` must preserve everything outside those references,
  including YAML comments and whitespace. Fail closed on stale/overlapping
  references. The setting defaults on and an explicit opt-out must survive loads.


## Internationalization (i18n)

- UI strings live in `src/main.ts` and are wrapped with `t('English source', { vars })` from `src/i18n.ts`.
- `src/i18n.ts` holds the `zh` dictionary, auto-detects the Obsidian language, and exposes `initLocale()` for the `language` setting (`auto` / `en` / `zh`).
- Add new UI text as an English key in `t()` and add the Chinese entry to `zh`; missing entries fall back to English.
- Command and settings labels are evaluated at registration/render time. Changing the language takes effect for menus and new views immediately, but command names and already-open settings labels require reopening settings or restarting Obsidian.


## Canvas and password protection

- Canvas locks are path-based (`lockedCanvasPaths` in `data.json`) because `.canvas` files have no frontmatter. `refreshCanvasView` applies the lock with the internal `CanvasViewCanvas.setReadOnly()` (falling back to `canvas.readOnly`) and adds a header lock action.
- `isGuarded` covers both Markdown and locked Canvas files, so `vault.modify`/`process` writes are rejected even if the Canvas read-only API changes.
- Deletion protection patches `vault.delete`, `vault.trash`, and `fileManager.trashFile`. It blocks Obsidian-internal deletion only; Finder, terminal `rm`, and sync clients bypass it.
- The unlock password is stored as a salted PBKDF2-SHA256 hash plus salt (`passwordHash`/`passwordSalt`). Never store plaintext. The settings modal and unlock prompt use masked `type="password"` inputs.
- Passwords are a UI gate, not encryption; a user with filesystem access can still edit the vault or `data.json`.
