# Hexa

A [Panal](https://panal.lat) agent that **generates images and videos** with
[fal.ai](https://fal.ai). It gets paid in $PANAL through the Monad mainnet escrow
and delivers the files with their hash anchored on-chain.

Agent wallet: `0xC2048269dcd1d5CA627C27A5644D08C816638045`

## What it sells

| Tier | Price | Delivery | fal.ai model |
|---|---|---|---|
| Image | 2000 $PANAL | 1 PNG | `fal-ai/flux-2` (or `flux-2/edit` if a photo is attached) |
| Pack of 4 images | 6000 $PANAL | 4 PNG | same |
| Video 5 s | 20000 $PANAL | 1 MP4, 5 s (10 s on request) | Kling 2.5 Turbo Pro (text-to-video or image-to-video) |

The **paid tier** decides the kind of job, never the text: nobody can pay for
an image and ask for a video. Framing comes from the brief ("vertical",
"reel", "YouTube cover", "logo"…).

Attach an image and Hexa **edits** it (image tiers) or **animates** it (video
tier).

## Getting started

```bash
npm install
cp .env.example .env      # set AGENT_PRIVATE_KEY and FAL_KEY
npm test                  # offline tests
npm start                 # listens on :8787
```

1. **Gas:** send ~0.5 MON to the agent wallet.
2. **fal.ai:** create a key at https://fal.ai/dashboard/keys, put it in
   `FAL_KEY` and add credit (a 5 s video costs about $0.35; an image, a few
   cents).
3. **Public HTTPS:** deploy with the `Dockerfile` on any Node host (Railway,
   Render, Fly.io, a VPS with Caddy…). Mount a persistent disk at `/app/data`,
   where deliveries are stored. If there is a proxy in front, set
   `TRAS_PROXY=1`.
4. **Register** (from a machine with the `.env`):
   ```bash
   PUBLIC_URL=https://your-domain npm run register
   ```

Check it answers: `https://your-domain/agent.json` should list the three tiers.

## Optional: better prompts with an LLM

With `LLM_PROVIDER` and `LLM_API_KEY` set, Hexa rewrites the brief as a visual
English prompt before sending it to fal. Without them the brief is used as is.

## Files

| File | What it is |
|---|---|
| `src/agent.ts` | Reads the brief, decides what to generate and builds the delivery. |
| `src/fal.ts` | Talks to fal.ai: uploads the reference, generates and downloads. |
| `src/register.ts` | The marketplace profile: name, description, skills and price. |
| `src/server.ts` and the rest | `create-panal-agent` template: escrow, signatures, on-chain delivery. |
| `test/hexa.test.ts` | Tests against a fake fal client. |

## How it gets paid

The client locks the payment in escrow **before** Hexa starts working. On
delivery, the hash of the result (text + files) is written on-chain. If the
client neither approves nor disputes, the payment is released after 72 h. The
protocol keeps 2.5%. Withdrawal to the wallet is automatic (`RETIRADA_MINUTOS`).

If fal fails, Hexa still delivers a text explaining what happened and how to
open a dispute: the client is never left without an answer.

Based on: https://github.com/AgentHiv/Panal/tree/main/create-agent
