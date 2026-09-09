# callback-worker

Email ingestion for [callback](https://github.com/mrestine/callback). Polls a
Gmail label, cleans each message, extracts structure with a **local** model
(Ollama), and submits the result to callback's `/api/ingest`.

This repo owns *all* model interaction and every prompt. It never touches
callback's database — the only coupling is one HTTP endpoint and a bearer token.
See `../callback/PHASE-2-PLAN.md` for the full design.

## Status: Stage 1 — the model-tuning harness

Two CLIs, no Gmail, no container, no callback API. They run against `.eml`
fixtures and a local Ollama so you can iterate on the extraction prompt and the
preprocessing until the output is good — *then* commit to a model.

```
preprocess   .eml / {raw} JSON  ──▶  normalized JSON   (deterministic; mailparser + unwrap-forward + strip-replies)
extract      normalized JSON    ──▶  extraction JSON   (Ollama, temperature 0, JSON-schema-constrained)
```

`prompts/extract.system.md` is the file you tune. `src/schemas.ts` defines both
contracts; the extraction schema is fed to Ollama as `format` so decoding is
grammar-constrained (the model cannot emit prose or invalid JSON).

## Setup

```sh
npm install
cp .env.example .env          # OLLAMA_URL / OLLAMA_MODEL
ollama pull qwen2.5:7b-instruct
```

## Getting fixtures

Forward a real job-search email to yourself, open it in Gmail, **⋮ → Download
message**, drop the `.eml` in `fixtures/private/` (gitignored). In production the
worker gets the same bytes from the Gmail API's `format=raw` response.

## Commands

```sh
npm run preprocess -- fixtures/sample/agency-blind-forward.eml     # normalized JSON
npm run pipe       -- fixtures/private/some-real.eml               # normalized -> extraction, one shot
npm run pipe       -- fixtures/private/some-real.eml --norm        # also print the normalized JSON (stderr)
npm run pipe       -- fixtures/private/some-real.eml --model llama3.1:8b-instruct
npm run extract    -- foo.norm.json --show-prompt                 # dump the exact prompt (stderr)
npm run batch      -- fixtures/private                            # run everything; writes *.out.json beside each
npm run typecheck
```

Extraction JSON goes to **stdout**; timings, warnings, and failures go to
**stderr** — so `preprocess | extract > out.json` stays clean.

The tuning loop: `npm run batch -- fixtures/private`, eyeball the
`*.extract.out.json` files against your expectations, edit
`prompts/extract.system.md` or `src/clean.ts`, repeat.

## Later stages (not built yet)

2. containerise (`Dockerfile` + `docker-compose.yml`: ollama + worker on one network)
3. `gmail.ts` (OAuth, poll, `format=raw`, label) + `store.ts` (local SQLite: cursor + outbox)
4. `submit.ts` (outbox → `/api/ingest`) + `disambiguator.ts` + `loop.ts`
