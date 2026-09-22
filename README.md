# callback-worker

Email ingestion for [callback](https://github.com/mrestine/callback). Polls a
Gmail label, cleans each message, extracts structure with a **local** model
(Ollama), submits the result to callback's `/api/inbound`, and replies in the
forwarded email's thread with a digest of what got queued.

This repo owns *all* model interaction and every prompt. It never touches
callback's database — the only coupling is one HTTP endpoint and a bearer token.

## The model-tuning harness

Two CLIs, no Gmail, no container, no callback API. They run against `.eml`
fixtures and a local Ollama so you can iterate on the extraction prompt and the
preprocessing until the output is good. (Model chosen: `qwen2.5:7b-instruct`.)

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

## Container

The worker runs as its own container. **Ollama runs separately** (its own
container publishing `11434`, or on the host) — not in this compose. On Docker
Desktop set `OLLAMA_URL=http://host.docker.internal:11434` in `.env`.

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

## Stage 3 / 4 — the live worker

`src/main.ts` now runs the real loop:

```
poll Gmail by label  →  clean  →  extract (local model)  →  POST /api/inbound
                     →  (disambiguate, a 2nd model call)  →  digest reply  →  relabel
```

**Gmail labels are the entire state machine** — no local DB, no cursor, no
outbox:

```
callback/inbox  →  callback/processing  →  callback/processed | callback/error
```

`callback/inbox` is applied by a Gmail filter on the forwarding address; the
worker owns the other three. Anything left in `callback/processing` (crash, lost
response) is re-run next poll — `/api/inbound` dedups on `(source, external_ref)`
so a re-send is a no-op.

### One-time Gmail auth

The worker needs an OAuth **desktop-app** client. Put the downloaded client secrets JSON at `secrets/gmail-credentials.json`,
then, on a machine with a browser:

```sh
mkdir -p secrets   # drop gmail-credentials.json in here
GMAIL_CREDENTIALS_PATH=./secrets/gmail-credentials.json \
GMAIL_TOKEN_PATH=./secrets/gmail-token.json \
npm run gmail:auth          # prints a URL — open it, approve, done
```

That writes `secrets/gmail-token.json` (an `authorized_user` refresh token).
Both files are bind-mounted into the container via `./secrets:/app/secrets`.

### Run

```sh
cp .env.example .env        # set CALLBACK_TOKEN (minted in the callback webapp), OLLAMA_URL
docker compose up --build -d
docker compose logs -f worker
```

`DRY_RUN=true` extracts and prints but never submits, relabels, or replies —
useful for a first pass over a backlog.

### Failure modes

| what breaks | what happens |
|---|---|
| model returns invalid JSON | message → `callback/error`; strip the label to retry |
| callback unreachable | message stays in `callback/processing`; retried next poll |
| Gmail refresh token dead | loop logs `FATAL` and idles; re-run `gmail:auth`, restart. Set `HEALTHCHECK_URL` so a check service alerts you out-of-band. |
