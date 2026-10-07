# callback-worker

Email ingestion for [callback](https://github.com/mrestine/callback). Polls a
Gmail label, cleans each message, extracts structure with a **local** model
(Ollama), submits the result to callback's `/api/inbound`, and replies in the
forwarded email's thread with a digest of what got queued for review.

It will also optionally generate a company summary based on a web search 
of the company if the company doesn't already exist within Callback.
This is a separate model prompt, and the results will be appended to the review item.

This repo owns *all* model interaction and every prompt. It never touches
callback's database - the only coupling is one HTTP endpoint and a bearer token.

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
**stderr** - so `preprocess | extract > out.json` stays clean.

The tuning loop: `npm run batch -- fixtures/private`, eyeball the
`*.extract.out.json` files against your expectations, edit
`prompts/extract.system.md` or `src/clean.ts`, repeat.

## Evals and tests

Run these after any change to a prompt, a guard, or `src/clean.ts`. The two
evals call the real local model; the test needs no model and no network.

```sh
npm run eval                  # extraction: fixtures/sample/*.eml vs *.expected.json
npm run eval:company          # company summary: canned search results in fixtures/company
npm run test:company-notes    # the new-company step's logic, offline (stubbed fetch)
npm run eval:note             # operator note: fixtures/note, what the model picks out of a note
npm run test:operator-note    # operator note: capture, guards and leftover notes, offline
npm run typecheck
```

Both evals take a fixtures directory and `--model <tag>`, and exit non-zero if
anything fails:

```sh
npm run eval -- fixtures/sample --model llama3.2:3b
npm run eval:company -- fixtures/company --model llama3.2:3b
```

- **`eval`** runs each `.eml` through the same clean → extract → guards path as
  production and diffs the result against its hand-written `.expected.json`.
  Confidence scores and free-text fields (`event.summary`, `notes`) are not
  compared; `occurred_at` is compared as an instant.
- **`eval:company`** feeds saved search results to the summarizer and checks the
  description: non-empty, at most 3 sentences, no buzzwords, no number that isn't
  in the sources, plus per-fixture `must_include` / `must_not_include`. No Serper
  calls, no cost.
- **`eval:note`** gives the operator-note model call real-looking notes (a bare
  link and range, labeled lines, a recruiter's profile link next to the job
  link, a number that is not pay...) and checks the fields it picks and what is
  left over for the notes. Fixtures are `fixtures/note/*.json`.
- **`test:operator-note`** covers the parts of that step that need no model:
  capturing the note, the checks on what the model picked, and the leftover
  notes.
- **`test:company-notes`** covers the plumbing around the summarizer: which
  companies get a lookup, failure handling, the callback lookup client, the
  two-query search merge, and the digest reply.

**Adding a fixture.** For extraction, drop `name.eml` in `fixtures/sample/` and
write `name.expected.json` beside it (copy an existing one; start from the
model's output and correct it by hand). For the summarizer, add a `name.json`
to `fixtures/company/` with the company `name`, canned search `results`
(`title`, `link`, `snippet`) and any `must_include`, `must_include_any` or
`must_not_include` strings. A `_note` field in either kind documents what the
case is testing and is ignored by the runner.

Treat the evals as a regression net, not a score. Output is stable within a
loaded model session but borderline fixtures can flip after Ollama reloads the
model, so re-run a failure before assuming a regression.

To try a single company by hand: `npm run lookup-company -- "Name" --summarize`.

## Container

The worker runs as its own container. **Ollama runs separately** (its own
container publishing `11434`, or on the host) - not in this compose. On Docker
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

`*.out.json` results land in `./fixtures/private/` on the host (gitignored) -
open them from the desktop or `scp` them off.

Reference Ollama container:

```sh
docker run -d --name ollama --gpus=all --restart unless-stopped \
  -v ollama:/root/.ollama -p 11434:11434 ollama/ollama
docker exec ollama ollama pull qwen2.5:7b-instruct
```

Image: `node:24-bookworm-slim`, multi-stage (compile → `dist/`, run `node dist/main.js`).
No native deps, so the slim image needs nothing extra.

## The live worker

`src/main.ts` now runs the real loop:

```
poll Gmail by label  →  clean  →  extract (local model)  →  POST /api/inbound
                     →  (disambiguate, a 2nd model call)  →  digest reply  →  relabel
```

**Gmail labels are the entire state machine** - no local DB, no cursor, no
outbox:

```
callback/inbox  →  callback/processing  →  callback/processed | callback/error
```

`callback/inbox` is applied by a Gmail filter on the forwarding address; the
worker owns the other three. Anything left in `callback/processing` (crash, lost
response) is re-run next poll - `/api/inbound` dedups on `(source, external_ref)`
so a re-send is a no-op.

### One-time Gmail auth

The worker needs an OAuth **desktop-app** client. Put the downloaded client secrets JSON at `secrets/gmail-credentials.json`,
then, on a machine with a browser:

```sh
mkdir -p secrets   # drop gmail-credentials.json in here
GMAIL_CREDENTIALS_PATH=./secrets/gmail-credentials.json \
GMAIL_TOKEN_PATH=./secrets/gmail-token.json \
npm run gmail:auth          # prints a URL - open it, approve, done
```

That writes `secrets/gmail-token.json` (an `authorized_user` refresh token).
Both files are bind-mounted into the container via `./secrets:/app/secrets`.

### Run

```sh
cp .env.example .env        # set CALLBACK_TOKEN (minted in the callback webapp), OLLAMA_URL
docker compose up --build -d
docker compose logs -f worker
```

`DRY_RUN=true` extracts and prints but never submits, relabels, or replies -
useful for a first pass over a backlog.

### Describing new companies (optional)

With `SERPER_API_KEY` set (a free serper.dev key, no card needed), the worker
asks callback which of an email's companies it doesn't have yet. For each new
one it runs two web searches (what the company does, and its age, size and
funding, and where it is headquartered). In one model call it fills a few
fields (what each result is about, founded, headcount, latest funding round,
headquarters) and writes one plain sentence on what the company does. The
sentence plus one labeled line per fact (`Founded: 2019`, `Employees:
412-500`, `Funding: Series B, $120M, 2025`) is sent as `hiring_company.notes`;
callback stores it as the new company's notes when you accept the proposal. The headquarters
goes along as `hiring_company.hq_location` and prefills the new application's
location. It is only kept if every word of it appears in the search results. callback decides what
counts as "new" (the same match it uses to link or create companies), so the
worker keeps no threshold of its own, and an existing company's notes are
never touched. Leave the key unset to turn the step off; it is also off in
`DRY_RUN`.

Try it by hand with `npm run lookup-company -- "Name" --summarize`
(`--context "applying for a ... role"` helps with common names). The checks
for this step are under [Evals and tests](#evals-and-tests).

### Context you add above the forward

Anything you type above the "Forwarded message" divider is yours, not the
sender's. `clean.ts` keeps it apart from the email (the extraction prompt never
sees it) and, only when there is a note, one small model call sorts it into the
application fields: the job posting link (`jd_url`), the pay range
(`salary_range`, a string, as you wrote it) and `remote` / `hybrid` / `onsite`.
No labels are needed; a bare link is taken to be the posting. Everything else in
the note stays as the application's notes, as written: code builds that by
taking the picked values (and the word that introduced them, like "JD:" or
"pays") out of the note, so the model never rewrites your words.

Each pick is checked against the note: a link must appear in it, every number in
the pay range must, and the work mode needs a matching word. Something that does
not check out is dropped and stays in the notes. If the model call fails, the
whole note becomes the notes. The fields go to callback as
`extracted.operator_note` and fill in the new application the email creates (the
first one, if the email covers several); the digest reply lists what was found
under "From your note". Try it: `npm run eval:note`.

### Failure modes

| what breaks | what happens |
|---|---|
| model returns invalid JSON | message → `callback/error`; strip the label to retry |
| callback unreachable | message stays in `callback/processing`; retried next poll |
| the note step's model call fails | the email is submitted anyway and your whole note becomes the application's notes |
| company lookup, search or summary fails | the email is submitted anyway, without a description; the step never blocks a submission |
| Gmail refresh token dead | loop logs `FATAL` and idles; re-run `gmail:auth`, restart. Set `HEALTHCHECK_URL` so a check service alerts you out-of-band. |
