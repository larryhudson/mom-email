# Dev Commands

This project uses `tsgo` (the native TypeScript compiler from `@typescript/native-preview`) instead of `tsc`.

- `npm run type-check` — fast type-check without emitting files (use this to verify changes compile)
- `npm run build` — full build (tsgo + chmod), outputs to `dist/`
- `npm run dev` — run dev server with dry-run mode (no real emails sent), watches for changes
- `npm run send-email` — send a test email via `scripts/send-email.ts`
- `npm run clean` — remove `dist/`
