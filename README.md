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
npm run pipe       -- fixtures/private/some-real.eml --model llama3.1:8b
npm run extract    -- foo.norm.json --show-prompt                 # dump the exact prompt (stderr)
npm run batch      -- fixtures/private                            # run everything; writes *.out.json beside each
npm run typecheck
```

Extraction JSON goes to **stdout**; timings, warnings, and failures go to
**stderr** — so `preprocess | extract > out.json` stays clean.

The tuning loop: `npm run batch -- fixtures/private`, eyeball the
`*.extract.out.json` files against your expectations, edit
`prompts/extract.system.md` or `src/clean.ts`, repeat.

## Stage 2 — container

The worker runs as its own container. **Ollama runs separately** (its own
container publishing `11434`, or on the host) — not in this compose.

```sh
cp .env.example .env
# in .env, for the container on Docker Desktop:
#   OLLAMA_URL=http://host.docker.internal:11434
docker compose up --build
```

`src/main.ts` is a connectivity heartbeat for now — it logs whether Ollama is
reachable and which models are pulled. `docker compose logs -f worker` should
show something like:

```
callback-worker up · OLLAMA_URL=http://host.docker.internal:11434 · model=qwen2.5:7b-instruct
[ollama] http://host.docker.internal:11434 ok · 2 model(s): qwen2.5:7b-instruct, llama3.1:8b
```

### Tuning from another machine

`docker-compose.yml` bind-mounts `./fixtures` and `./prompts`, so you can drop
`.eml` files and edit `prompts/extract.system.md` on the host and re-run without
rebuilding. SSH into the desktop, then:

```sh
cd callback-worker
docker exec -it callback-worker sh          # shell in the container
# or run directly:
docker exec callback-worker node dist/cli/batch.js fixtures/private
docker exec callback-worker node dist/cli/batch.js fixtures/private --model llama3.1:8b
```

`*.out.json` results land in `./fixtures/private/` on the host (gitignored) —
open them from the desktop or `scp` them off.

Reference Ollama container:

```sh
docker run -d --name ollama --gpus=all --restart unless-stopped \
  -v ollama:/root/.ollama -p 11434:11434 ollama/ollama
docker exec ollama ollama pull qwen2.5:7b-instruct
```

Image: `node:24-bookworm-slim`, multi-stage (compile → `dist/`, run `node dist/main.js`).
No native deps, so the slim image needs nothing extra.

## Later stages (not built yet)

3. `gmail.ts` (OAuth, poll, `format=raw`, label) + `store.ts` (`node:sqlite`: cursor + outbox)
4. `submit.ts` (outbox → `/api/ingest`) + `disambiguator.ts` — replaces the heartbeat in `main.ts`
