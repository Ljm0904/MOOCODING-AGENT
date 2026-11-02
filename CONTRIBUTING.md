# Contributing

```bash
npm install
npm run check   # type-check
npm test        # end-to-end tests against a scripted mock LLM server — no API key needed
npm start       # run from source (Node >= 22.18 strips types natively)
npm run build   # compile to dist/ (what gets published)
```

- Source is plain TypeScript with `erasableSyntaxOnly` (no enums / parameter properties) so Node can run it directly. Use `import type` for types and `.ts` extensions in relative imports.
- Zero runtime dependencies is a goal: please discuss before adding one.
- New behaviour needs a test. The pattern in `test/e2e.test.ts` (scripted OpenAI-compatible server) covers most agent features.
- Keep `README.md` and `CHANGELOG.md` in sync with user-visible changes.
