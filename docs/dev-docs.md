## Dev Docs

### 📁 Project structure

-   `src/` - source code
    -   `src/graph/` - Graph data structures and algorithms
    -   `src/settings/` - Settings data structures
    -   `src/utils/` - Utility functions
    -   `src/views/` - Views and UI components
        -   `./atomics/` - Atomic UI components
        -   `./graph/` - Graph UI components
        -   `./settings/` - Settings UI components
    -   `./main.ts` - Main plugin file
-   `scripts/generate-test-vault.mjs` - Builds a large test vault

### 🧪 Test vault

`npm run test-vault` builds the plugin and writes a vault of about 5,000 notes to `test-vault/`, with this build of the plugin installed. Open that folder as a vault in Obsidian and trust it to enable the plugin.

The note text is filler. The links follow a vault that grew over about five years: daily notes, meetings, projects, people, sources, interlinked topic notes, and maps of content. That gives hubs, clusters, bridges between topics, orphans, tags, attachments, and unresolved links. File creation dates follow that history, so the timelapse replays it.

Pass options after `--`, for example `npm run test-vault -- --scale 3` for about 12,000 notes. `--seed` picks a different vault, and `--out` writes it somewhere else. Running it again replaces the notes but keeps the vault's `.obsidian` folder.

### 🤝 Contributing

Contributions are welcome, but please make sure they are understandable and no bloat.

### 🗺️ Roadmap

### Near future

-   [ ] become an official community plugin
-   [ ] await community feedback on the plugin (and fix bugs)
