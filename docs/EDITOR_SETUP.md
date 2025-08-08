# Editor Setup for TypeKro Development

This document provides setup instructions for various editors to ensure consistent code formatting and linting.

## VS Code Setup

### Required Extensions
- [Biome](https://marketplace.visualstudio.com/items?itemName=biomejs.biome) - For formatting and linting

### Recommended Settings
Add the following to your VS Code settings (`.vscode/settings.json`):

```json
{
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.biome": "explicit"
  },
  "editor.defaultFormatter": "biomejs.biome",
  "[typescript]": {
    "editor.defaultFormatter": "biomejs.biome",
    "editor.formatOnSave": true
  },
  "[javascript]": {
    "editor.defaultFormatter": "biomejs.biome",
    "editor.formatOnSave": true
  },
  "[json]": {
    "editor.defaultFormatter": "biomejs.biome",
    "editor.formatOnSave": true
  },
  "[jsonc]": {
    "editor.defaultFormatter": "biomejs.biome",
    "editor.formatOnSave": true
  },
  "typescript.preferences.importModuleSpecifier": "relative",
  "typescript.suggest.autoImports": true,
  "biome.lspBin": "./node_modules/@biomejs/biome/bin/biome"
}
```

## WebStorm/IntelliJ Setup

### Biome Plugin
1. Install the Biome plugin from the JetBrains marketplace
2. Go to Settings → Tools → Biome
3. Enable "Run Biome on save"
4. Set the Biome executable path to `./node_modules/@biomejs/biome/bin/biome`

### Format on Save
1. Go to Settings → Tools → Actions on Save
2. Enable "Reformat code"
3. Enable "Optimize imports"

## Vim/Neovim Setup

### Using ALE (Asynchronous Lint Engine)
```vim
let g:ale_linters = {
\   'typescript': ['biome'],
\   'javascript': ['biome'],
\}

let g:ale_fixers = {
\   'typescript': ['biome'],
\   'javascript': ['biome'],
\}

let g:ale_fix_on_save = 1
```

### Using null-ls (for Neovim)
```lua
local null_ls = require("null-ls")

null_ls.setup({
    sources = {
        null_ls.builtins.formatting.biome,
        null_ls.builtins.diagnostics.biome,
    },
})
```

## Emacs Setup

### Using lsp-mode
```elisp
(use-package lsp-mode
  :hook ((typescript-mode . lsp)
         (js-mode . lsp))
  :config
  (setq lsp-biome-server-path "./node_modules/@biomejs/biome/bin/biome"))

(add-hook 'before-save-hook 'lsp-format-buffer)
```

## Manual Formatting Commands

If your editor doesn't support automatic formatting, you can use these commands:

```bash
# Format all files
bun run format:fix

# Format specific files
bunx biome format --write src/specific-file.ts

# Check formatting without fixing
bun run format

# Run full quality check (format + lint + typecheck)
bun run quality:fix
```

## EditorConfig Support

This project includes an `.editorconfig` file that most editors support automatically. This ensures consistent:
- Indentation (2 spaces)
- Line endings (LF)
- Character encoding (UTF-8)
- Trailing whitespace handling

Make sure your editor has EditorConfig support enabled.

## Import Organization

**Important**: Import organization (sorting and removing unused imports) is **disabled on save** to prevent disruption during development. Instead, imports are organized automatically during commits.

### Why This Setup?
- **Development Flow**: You can add imports while coding without them being immediately removed
- **Commit Time**: Imports are cleaned up and organized when you commit changes
- **Consistency**: All committed code has properly organized imports

### Manual Import Organization
If you want to organize imports manually:

```bash
# Organize imports for all files
bun run imports:organize

# This is automatically run during pre-commit
```

### Editor Configuration
Make sure your editor is **NOT** configured to organize imports on save. The recommended VS Code settings above already exclude `"source.organizeImports.biome"` for this reason.

## Git Hooks

The project includes pre-commit hooks that will automatically format code and organize imports before commits:

```bash
# This runs automatically on git commit
bun run pre-commit
```

## Troubleshooting

### Biome not found
If your editor can't find Biome, make sure you've installed dependencies:
```bash
bun install
```

### Formatting conflicts
If you see conflicts between different formatters:
1. Disable other formatters (like Prettier) for this project
2. Set Biome as the default formatter for TypeScript/JavaScript files
3. Clear your editor's cache and restart

### Performance issues
If Biome is slow in your editor:
1. Make sure you're using the local installation (`./node_modules/@biomejs/biome/bin/biome`)
2. Check that your editor isn't running multiple formatters simultaneously
3. Consider excluding large files or directories in your editor settings