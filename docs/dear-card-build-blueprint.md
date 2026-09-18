# Dear Card: product teardown and build blueprint

Research date: 16 September 2026

Primary product: [Dear Card](https://dearcard.designedbythanh.com/)

Primary article: [Shipping an AI Product in a Week](https://designedbythanh.substack.com/p/shipping-an-ai-product-in-a-week)

## 1. Executive summary

Dear Card is a deliberately small, account-free AI postcard product. A sender uploads one photo, writes a message, optionally adds a place and recipient details, and receives a private-looking share link. The photo is repainted as a restrained ink-and-watercolor illustration. The application—not the image model—then creates the physical postcard treatment: paper texture, typewriter text, pictorial stamp, postmark, front/back layouts, and the recipient's envelope-opening reveal. The link expires after seven days.

The key product decision is the separation of responsibilities:

- The image model performs one job: repaint the photo as coherent watercolor art.
- Deterministic browser code performs layout, typography, paper texture, stamp extraction, postmark, and export.
- Server functions protect API keys, enforce quotas, submit and poll AI jobs, save final assets, and delete expired cards.

That division makes the output more consistent, reduces prompt complexity, contains cost, and keeps user-controlled text away from generative image typography.

## 2. What is verified and what is inferred

### Explicitly stated by Thanh

- The first version took about one week and was built with Claude Code.
- The frontend is plain HTML and JavaScript with small backend functions on Vercel.
- fal.ai handles the image-generation queue.
- A raw OpenAI image model repaints the uploaded photo.
- The selected quality level is medium because it balanced cost and the desired handmade look.
- The first synchronous approach timed out; the final flow submits a job, receives a request ID, and polls for completion.
- The image prompt was reduced from roughly 1,500 words to roughly 300 after six rewrites.
- The application intentionally keeps only one photo, one message, and one link; there are no user accounts or email addresses.
- Cards and their links disappear after seven days.
- A security review found stored XSS and SSRF issues before launch.
- The next commercial directions are print-on-demand and event/wedding cards.

### Verified in the live public client

- English and French interfaces.
- Photo input is resized in the browser to a maximum 1,280-pixel edge and encoded as JPEG at quality 0.82 in sRGB.
- Message limit: 400 characters.
- Place limit: 40 characters.
- Recipient name limit: 30 characters.
- Recipient address limit: 60 characters.
- Five free generations per visitor per day in production; preview deployments skip the client hint. The server is the authoritative quota gate.
- Quota signals include IP plus a random local device ID.
- Cloudflare Turnstile is used and reset after each submission.
- Draft inputs survive accidental refresh in `sessionStorage`; rendered cards are not stored there.
- The browser polls every three seconds for up to four minutes.
- Re-editing only text or layout reuses the existing watercolor and does not spend another generation.
- The app produces 1,500×1,000 landscape cards or 1,000×1,500 portrait cards.
- Vercel Blob is used for card assets in production.
- Card IDs are 10–32 lowercase hexadecimal characters.
- Card responses use `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
- Vercel Web Analytics is enabled on the composer but deliberately omitted from recipient card pages because the URL contains the card ID.
- A small first-party event endpoint records funnel events such as creating a card from a received card and saving a keepsake.
- The recipient can save a combined front-and-back JPEG before expiry.

### Strong inference, not directly confirmed by the private backend

The likely production endpoint is `openai/gpt-image-2/edit` on fal.ai with `quality: "medium"` and `image_size: "auto"`. The evidence is that Thanh says the model is from OpenAI and has exactly three quality tiers, while the current fal endpoint for GPT Image 2 editing exposes low, medium, and high, auto-infers orientation from the source photo, accepts base64 data URIs, and supports asynchronous queue submission. The public client also expects orientation-preserving output. The exact backend model name is not visible, so treat this as a high-confidence implementation choice, not a confirmed fact.

Some comments in the live `cardgen.js` still mention `flux-kontext`. They are probably remnants of an earlier model iteration or incomplete comment cleanup. Do not use them as proof of the current backend model.

## 3. Product experience

### Sender flow

1. Land on a calm split-screen composition page showing two example postcards.
2. Upload or drag in a photo.
3. Write a message of up to 400 characters.
4. Optionally provide the place. If omitted, the system can ask the image model to infer a plausible place label or leave it blank; do not claim certainty from visual geolocation.
5. Optionally provide a recipient name and an imagined postal address.
6. Complete an invisible/interstitial Turnstile challenge if requested.
7. Tap **Compose the card**.
8. Watch a staged “printing” sequence while the job runs. The visual steps change every five seconds and end on a holding state.
9. Preview and flip the generated front/back card.
10. Edit without re-generating the watercolor when only text changes.
11. Create an expiring link and copy a human-sounding message to send with it.

### Recipient flow

1. Open a URL such as `/c/<opaque-id>`.
2. See a closed airmail envelope and an expiry note.
3. Choose sound on/off; the preference is remembered locally.
4. Tap to open.
5. Skip the unstable first 1.1 seconds of the prerecorded envelope clip, play the clean motion at 0.5× speed, and begin a dissolve at clip-time 3 seconds so the card lands as the 4-second clip finishes.
6. Reveal the interactive postcard with a restrained rise animation and optional 15 ms vibration.
7. Flip between front and back and optionally view the original photo.
8. Save a single JPEG containing both sides.
9. Follow the viral loop CTA to create a new postcard.

## 4. Recommended faithful stack

Use the smallest stack that preserves the product's strengths:

- Frontend: Vite + TypeScript with plain DOM and Canvas 2D. React is optional and unnecessary for this scope.
- Hosting/functions: Vercel static hosting plus Node.js serverless functions.
- AI: fal.ai queue calling `openai/gpt-image-2/edit`, medium quality, auto size, one result.
- Object storage: private Vercel Blob, served through narrow same-origin image routes.
- Metadata/quota store: Vercel KV-compatible Redis or Upstash Redis with native TTLs.
- Anti-abuse: Cloudflare Turnstile plus server-side IP/device/day counters.
- Analytics: Vercel Web Analytics on public composer pages and a minimal first-party aggregate event counter. Do not load analytics on recipient card routes.
- Scheduled deletion: TTL metadata plus a secured Vercel Cron cleanup as defense in depth.
- Styling: CSS variables, Work Sans for interface text, IBM Plex Mono/Courier Prime for postcard text, Caveat only for a small handwritten accent.

If you prefer the direct OpenAI API, use the Image Edits endpoint for a single image edit. Keep the same application architecture, but do not hold a browser request open for the entire render: submit background work through a queue or workflow and poll your own job record.

## 5. System architecture

```text
Sender browser
  ├─ resize/normalize photo locally
  ├─ POST /api/generate
  │    ├─ validate origin, Turnstile, schema, size and quota
  │    ├─ submit fal queue job
  │    └─ return opaque request ID
  ├─ GET /api/status?id=… every 3 s
  │    └─ server asks fal for status/result
  ├─ Canvas 2D composes front + back deterministically
  └─ POST /api/cards with flattened images and text metadata
       ├─ store private blobs
       ├─ store a 7-day card record
       └─ return /c/<opaque-card-id>

Recipient browser
  ├─ GET /api/cards?id=…
  ├─ GET /api/img?tokenized-card-asset-reference
  ├─ plays local envelope video/audio
  ├─ renders/flips postcard
  └─ builds downloadable keepsake locally

Scheduled cleanup
  └─ deletes expired records and blobs, idempotently
```

## 6. Repository structure

```text
dear-card/
  public/
    assets/
      paper.jpg
      envelope.jpg
      envelope-open.mp4
      envelope-open.mp3
      og-send.jpg
      envelope-og.jpg
    samples/
  src/
    compose.ts
    recipient.ts
    postcard/
      build-card.ts
      paper.ts
      palette.ts
      typewriter.ts
      stamp.ts
      postmark.ts
      layouts.ts
      keepsake.ts
    ui/
      loading.ts
      flip-card.ts
    i18n.ts
    styles.css
  api/
    generate.ts
    status.ts
    cards.ts
    img.ts
    track.ts
    cleanup.ts
    _lib/
      env.ts
      schema.ts
      turnstile.ts
      quota.ts
      fal.ts
      storage.ts
      cards-repository.ts
      security.ts
      stats.ts
  tests/
    fixtures/
    prompt-eval/
    rendering/
    security/
  vercel.json
  package.json
  .env.example
```

## 7. API contracts

### `POST /api/generate`

Request:

```json
{
  "photo": "data:image/jpeg;base64,…",
  "location": "Bidart, France",
  "deviceId": "browser-generated UUID",
  "turnstileToken": "…",
  "source": "direct"
}
```

Validation:

- exact same-origin POST;
- JSON only;
- allowed MIME types: JPEG, PNG, WebP;
- decode and verify magic bytes, dimensions and pixel count server-side;
- reject SVG and animated formats;
- base64/request byte ceiling;
- location length ≤ 40 after Unicode normalization;
- valid Turnstile token verified server-side;
- quota available for IP hash + device hash + UTC date;
- prepaid AI budget is healthy.

Response:

```json
{
  "requestId": "fal-request-id",
  "no": "0427",
  "date": "2026-09-16"
}
```

Never expose the fal key or OpenAI key to the browser.

### `GET /api/status?id=<opaque-job-id>`

- Look up a server-side job mapping rather than accepting arbitrary fal IDs from the browser.
- Return `{ "status": "queued" | "processing" }`, `{ "status": "done", "image": "/api/img?..." }`, or a generic error.
- Enforce ownership with a short-lived signed job token.
- Rate-limit polling and add jitter/backoff after the first minute.

### `POST /api/cards`

Accept the flattened front/back JPEGs plus the minimum metadata needed by the recipient experience. Store assets under random immutable paths. Create a record with `expiresAt = now + 7 days` and return a cryptographically random ID.

Do not accept blob URLs from the browser. The server must create storage paths itself.

### `GET /api/cards?id=<card-id>`

- Validate the hex/opaque ID format before lookup.
- Return 404 for unknown IDs and 410 for known expired IDs if that distinction is useful.
- Use `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`.
- Return signed/same-origin asset references, not raw private storage credentials.

### `GET /api/img?asset=<signed-reference>`

This is the SSRF boundary. Never fetch an arbitrary `u=` URL supplied by the caller. Prefer an internal asset ID resolved from your database. If a URL must be used, require an HMAC signature, allowlist the exact Vercel Blob hostname/store prefix, reject credentials and non-HTTPS schemes, disable redirects, and block private/loopback/link-local IPs after DNS resolution.

### `POST /api/track?e=<allowlisted-event>`

Accept only a small enum such as `compose_started`, `generated`, `link_created`, `opened`, `saved`, `cta_create`. Store daily aggregates, not card IDs, message contents, IP addresses, or full recipient URLs.

## 8. Minimal data model

```ts
type CardRecord = {
  id: string;
  frontPath: string;
  backPath: string;
  originalPhotoPath?: string;
  location?: string;
  cardNumber?: string;
  cardDate: string;
  createdAt: string;
  expiresAt: string;
  version: 1;
};

type JobRecord = {
  id: string;
  falRequestId: string;
  status: "queued" | "processing" | "done" | "error";
  createdAt: string;
  expiresAt: string;
  ownerHash: string;
  resultAssetPath?: string;
};
```

The postcard message and recipient fields can be flattened into the back image before upload, avoiding a second copy of personal text in the database. If the interactive recipient page needs raw text, keep it only in the seven-day record, validate it, render it through safe text sinks, and delete it with the card.

## 9. Image model call

Recommended fal submission:

```ts
const { request_id } = await fal.queue.submit("openai/gpt-image-2/edit", {
  input: {
    prompt: WATERCOLOR_PROMPT,
    image_urls: [validatedDataUri],
    image_size: "auto",
    quality: "medium",
    num_images: 1,
    output_format: "jpeg"
  }
});
```

At current listed fal prices, one medium edit including one input image is approximately $0.043 at 1,024×768, $0.054 at 1,024×1,536, and $0.061 at 1,024×1,024. Verify prices again before launch and treat them as variable.

### Original prompt scaffold to test

This is a new prompt based on the product behavior, not Thanh's unreleased exact prompt:

```text
Repaint the supplied photograph as an original travel sketch made with waterproof
black ink and transparent watercolor on warm, cold-pressed cotton paper.

Preserve the photograph's recognizable subject, viewpoint, major geometry, people,
and important spatial relationships. Do not add landmarks, signs, buildings, people,
objects, lettering, borders, stamps, captions, or postcard design.

Choose one visual subject as the clear center of attention. Give that subject the most
confident ink marks, strongest value contrast, and richest local color. Treat secondary
areas with fewer lines, paler washes, simplified shapes, and more untouched paper as
they approach the edges. The result must feel selected and observed, not uniformly
detailed.

Use quick, varied ink lines with occasional gaps and overlaps. Use translucent washes,
granulation, soft blooms, back-runs, small pigment pools, imperfect edges, and a few
unplanned-looking marks. Keep large areas of clean paper. Avoid airbrushed softness,
digital glow, smooth gradient rendering, photorealism, heavy outlines, fake sepia,
distressed-vintage effects, canvas texture, and generic storybook illustration.

Retain every visible person, including distant, side-view, and back-view figures. Keep
their pose, clothing colors, scale, and location. For a clearly visible face, suggest only
the minimum natural marks needed for expression; do not invent or sharpen identity.

Keep architecture structurally believable but hand-drawn. Straight lines may breathe;
they must not melt, duplicate, or become fantasy ornament. Keep the original lighting
direction and weather. Let color come from the source photo, slightly clarified rather
than oversaturated.

Output only the full-bleed watercolor artwork, matching the source orientation. No text.
```

### Prompt evaluation set

Create a fixed set of 30 licensed test photos:

- 8 landscapes/shorelines;
- 8 streets/façades/villages;
- 6 interiors or night scenes;
- 4 groups or distant people;
- 4 close portraits.

Score every prompt/model version on subject preservation, composition preservation, visual hierarchy, handmade quality, face restraint, invented objects, text artifacts, edge falloff, color faithfulness, and generation time. Save the model endpoint, quality, prompt hash, input ID, output ID, cost, latency, and reviewer scores. Never tune from one “hero” photo.

## 10. Deterministic postcard rendering

The live product's strongest technical idea is that the model does not draw the postcard. Reproduce this in Canvas 2D:

1. Load a warm paper texture, the generated watercolor, and optionally the original photo as a color reference.
2. Pick portrait or landscape dimensions from the watercolor orientation.
3. Downsample the watercolor and extract dominant color buckets.
4. Derive a dark warm ink and a mid-tone accent from the painting.
5. Apply a subtle corrective grade: protect near-white paper and dark ink, reduce extreme chroma, preserve source-photo color evidence, and add minimal warm-light/cool-shadow balance.
6. Place the painting with either full-bleed, plate, or panel layout. Ship only one approved layout initially.
7. Make the pictorial stamp from a near-square crop of the same watercolor so it shares subject and palette.
8. Draw imperfect perforations, a rotated stamp shadow, a circular cancellation, and three cancellation bars.
9. Render the sender's message character-by-character with tiny random rotation, baseline offsets, ink-density variation, occasional double impressions, and alpha erosion.
10. Add very low-opacity repeated monochrome paper tooth using soft-light blending.
11. Flatten front and back separately to JPEG at quality ~0.92.

Critical rule: escape or render all user text as text. Never concatenate the message into `innerHTML`. Canvas `fillText`, DOM `textContent`, and hardcoded attribute names are safe rendering sinks when used correctly.

## 11. Security and privacy checklist

### Fix the two failures Thanh found

Stored XSS:

- Treat message, location, name, and address as untrusted forever.
- Validate lengths and normalize Unicode, but do not rely on validation as the XSS defense.
- Render with `textContent` or Canvas `fillText`; never `innerHTML`.
- Use `application/json` responses and a strict Content Security Policy.

SSRF:

- Replace arbitrary remote URL fetching with an internal asset ID.
- If a proxy remains, sign the exact asset reference, allowlist the exact storage host and path prefix, require HTTPS, reject userinfo and non-default ports, disable redirects, resolve DNS and reject private/special networks, set byte and time limits, verify `Content-Type`, and stream rather than buffering unlimited data.

### Additional production controls

- Validate Turnstile server-side. Tokens are single-use and expire after five minutes.
- Hash quota identifiers with an application secret; do not store raw IPs.
- Use cryptographically random card IDs with at least 128 bits of entropy rather than a short predictable sequence.
- Rate-limit generate, status, card creation, card retrieval, and image proxy routes separately.
- Enforce a global daily spend cap, a prepaid fal balance with auto top-up disabled, and per-visitor quota.
- Store the fal key, blob credentials, Redis URL, Turnstile secret, signing key, and cron secret only in server environment variables.
- Strip EXIF metadata before sending/storing the resized upload.
- Avoid logging request bodies, data URIs, messages, card IDs, signed asset URLs, or full recipient URLs.
- Keep recipient pages out of analytics and search indexing.
- Add `frame-ancestors 'none'`, `object-src 'none'`, a narrow `img-src`, and a nonce/hash-based `script-src` CSP.
- Make cleanup idempotent and delete both metadata and every referenced blob.
- Publish concise privacy terms describing the AI provider, storage duration, deletion behavior, and the fact that visual place inference can be wrong.

## 12. Cost and abuse model

Use this formula:

```text
monthly AI cost = successful generations × weighted average model cost
monthly storage cost = card count × average bytes × average retained days / 30
```

Example at $0.05 average AI cost:

- 100 successful cards/month ≈ $5 AI cost.
- 1,000 cards/month ≈ $50.
- 10,000 cards/month ≈ $500.

Add storage, function, egress, Turnstile (normally free), and observability costs. Budget for retries and failed generations even when they do not produce a usable card. Do not base a public free tier only on a client-side counter.

Recommended launch limits:

- 5 generations per IP/device pair per UTC day;
- 1 active generation per owner;
- 6 MB incoming request cap after JSON overhead;
- 20 megapixel decoded image ceiling;
- 4-minute client polling ceiling;
- 7-day card TTL;
- fixed global daily generation budget;
- alert at 50%, 75%, and 90% of the prepaid balance.

## 13. Seven-day implementation plan

### Day 1 — product slice and static shell

- Freeze scope: one photo, one message, one link.
- Build the composer and recipient routes, responsive split layout, localization shell, photo resizing, form validation, and session draft.
- Add example images and an explicit test-mode watercolor fixture.

Exit criterion: the full journey works with a fixture and no backend.

### Day 2 — prompt and image pipeline

- Build a standalone prompt harness against the 30-photo evaluation set.
- Compare medium and high only after low/medium baselines.
- Lock the first acceptable prompt and record a hash/version.

Exit criterion: at least 80% of scenery fixtures pass subject/composition/handmade checks with no critical invented content.

### Day 3 — asynchronous backend

- Implement Turnstile validation, upload validation, quota reservation, fal queue submit, job mapping, status polling, error mapping, and quota release/commit semantics.
- Add spend caps before public testing.

Exit criterion: normal, slow, blocked, failed, duplicate, and timed-out jobs all end in a recoverable UI state.

### Day 4 — postcard renderer

- Build paper, palette extraction, painting placement, typewriter treatment, stamp, postmark, front/back layouts, and JPEG flattening.
- Test portrait and landscape outputs at mobile memory limits.

Exit criterion: stable visual output across Safari, Chrome, and Android Chrome without re-generating AI art for text edits.

### Day 5 — sharing and recipient reveal

- Implement card storage, random IDs, expiry metadata, recipient fetch, envelope clip/audio, flip interaction, keepsake export, and viral-loop CTA.
- Omit analytics from card pages.

Exit criterion: a link opened in a second device reveals and saves correctly, then expires in a shortened test TTL.

### Day 6 — security, privacy, and failure testing

- Test stored-XSS payloads in every text field.
- Test SSRF schemes, redirect chains, private IPs, DNS rebinding defenses, oversized images, malformed data URIs, decompression bombs, quota races, replayed Turnstile tokens, guessed IDs, expired links, and stale caches.
- Add CSP, no-store/noindex headers, redacted logging, and secured cron cleanup.

Exit criterion: automated security cases pass and manual testing shows no raw personal content in logs/analytics.

### Day 7 — polish and controlled launch

- Tune loading copy and motion, reduced-motion behavior, sound controls, iOS/in-app-browser save fallbacks, and accessibility labels.
- Launch to a small community with a hard spend ceiling.
- Observe completion, link creation, recipient open, save, and create-from-card conversion.

Exit criterion: real users complete the loop without intervention and no quota, cost, or privacy alarms fire.

## 14. Test plan

### Unit tests

- input schemas and Unicode normalization;
- MIME/magic-byte verification;
- quota reservation/commit/release and midnight rollover;
- signed asset references;
- card TTL and cleanup;
- prompt version selection;
- line wrapping and long-word behavior;
- locale detection and filename slugging.

### Integration tests

- fal queued → processing → completed;
- fal failure, moderation block, rate limit, insufficient balance, and timeout;
- Turnstile valid, missing, expired, and replayed;
- Blob upload/fetch/delete;
- card record creation and expiry;
- image proxy rejects untrusted destinations.

### Visual regression

- portrait and landscape cards;
- empty optional fields;
- 400-character message;
- light/dark/high-chroma watercolors;
- Latin accents and non-Latin text;
- mobile 360 px, tablet, and desktop;
- reduced motion and muted sound.

### End-to-end

- direct visitor creates, edits, shares, recipient opens, flips, saves, and creates their own;
- refresh during compose, generate, and reveal;
- stale deployment/cache test to ensure the client and API versions remain compatible;
- seven-day expiry test with the TTL shortened to minutes in preview.

## 15. Decisions to make before coding

1. Whether the original uploaded photo should be available to the recipient. Keeping it increases emotional value but also increases stored personal data.
2. Whether to reproduce the exact French/European stationery direction or create a distinct brand language.
3. Whether the card must vanish completely after seven days or whether the recipient may save it first. The current product allows a keepsake download.
4. Whether model-generated place inference is shown as a suggestion, omitted, or user-confirmed. Never present visual geolocation as fact.
5. Whether the first paid feature is print fulfillment, event batches, or additional styles. Do not add all three to the MVP.

## 16. Improvements over the observed implementation

- Use a signed internal asset identifier instead of an arbitrary image-proxy URL.
- Use a webhook to finalize long jobs server-side, with polling only for UI progress. This survives tab closure and reduces status traffic.
- Version the prompt, renderer, and stored card schema.
- Make random texture generation seedable per card so re-rendering is deterministic.
- Reserve quota before queue submission and commit only once using an idempotency key.
- Store the final watercolor in your own private blob immediately because fal media URLs are public and lifecycle-controlled by provider settings.
- Use private Blob plus same-origin delivery rather than public asset URLs.
- Run prompt evaluations before layout work, but lock responsibility boundaries before either.
- Add an automated preview smoke test that detects stale client/server version combinations.

## 17. Source map

- Article and design rationale: [Designed by Thanh](https://designedbythanh.substack.com/p/shipping-an-ai-product-in-a-week)
- Live product: [Dear Card](https://dearcard.designedbythanh.com/)
- Public composer behavior: [compose.js](https://dearcard.designedbythanh.com/compose.js)
- Public deterministic renderer: [cardgen.js](https://dearcard.designedbythanh.com/cardgen.js)
- Public recipient flow: [recipient.js](https://dearcard.designedbythanh.com/recipient.js)
- fal GPT Image 2 edit schema and pricing: [fal model page](https://fal.ai/models/openai/gpt-image-2/edit)
- fal queue behavior: [Asynchronous inference](https://fal.ai/docs/documentation/model-apis/inference/queue)
- Current OpenAI image APIs: [official OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- Vercel private storage: [Private Blob documentation](https://vercel.com/docs/vercel-blob/private-storage)
- Vercel function duration: [Function duration documentation](https://vercel.com/docs/functions/configuring-functions/duration)
- Cloudflare anti-bot verification: [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- XSS defense: [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- SSRF defense: [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

