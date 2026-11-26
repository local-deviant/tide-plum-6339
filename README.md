# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/local-deviant/site-generator-speed-01-run-20261122-ours/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/local-deviant/site-generator-speed-01-run-20261122-ours/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)


[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![make.fun](https://img.shields.io/badge/make.fun-site--generator--speed--01--run--20261122-green)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![referral](https://img.shields.io/badge/referral-njrtxptt-orange)](https://make.fun/?ref=njrtxptt)

A fast, drop-in replacement for `makefun-site` 1.0.0 — a static site generator
written from scratch in dependency-free JavaScript. It produces byte-identical
output to the reference on every generated case, at roughly 3–4x the speed of
the baseline.

## How it works

- **Markdown**: a single-pass block lexer (no line-array allocation) and a
  fast inline scanner built on `indexOf` for the next special character.
  Front matter, headings, lists, fences, blockquotes, setext headings,
  autolinks and relative link resolution follow the reference dialect exactly.
- **Templates**: a small dialect interpreter plus a compiler that turns each
  template into straight-line JavaScript (`new Function`, with an interpreter
  fallback when code generation is refused). Includes are cached: templates
  that depend only on the case root (`site`, `tags`, `recent`) render once
  per depth; templates with one further input render once per (depth, value).
- **Caching**: memoized slugification, HTML escaping, long dates, link
  resolution, and per-post cards are reused instead of recomputed.

## Run

```sh
node main.ts   # reads /input/cases.json, writes /output/answers.json
```

`main.ts` is the house baseline driver; `solve.js` exports `run(input)`.

## License

MIT — see `LICENSE`.
