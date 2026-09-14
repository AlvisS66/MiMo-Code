---
feature: read-finite-media-mimes
status: in-progress
updated: 2026-09-12
branch: fix/read-finite-media-mimes
commits: 
---

# read finite media MIME allowlist

## Report

## [S1] Problem

The `read` tool decides media modality with prefix checks (`isAudioAttachment` / `isVideoAttachment` / `isImageAttachment`) on a MIME derived from `sniffAttachmentMime(sample, AppFileSystem.mimeType(filepath))`. `mime-types` maps source extensions such as `.ts` and `.mts` to `video/mp2t` (MPEG-2 TS), so TypeScript source enters the video branch. The provider only accepts `video/mp4|quicktime|x-msvideo|x-ms-wmv`, so `read` refuses the file and never falls through to text. The same prefix rule would treat any future `audio/*` or `video/*` lookup as attachable media even when MiMo cannot take it.

Audio/video attachment was added on 2026-09-12 (`049fe862` feat(media): read audio and video as inline attachments; `cca753c0` fix(media): treat video as a first-class modality). Image/PDF attachment predates that; content sniffing landed earlier (`7fa302e3`, 2026-09-07).

## [S2] Design

`read` attaches media only when the resolved MIME is in a finite allowlist that matches what MiMo and the wired adapters actually take. Prefix matches are no longer sufficient to enter an attachment branch.

Finite allowlists in `packages/opencode/src/util/media.ts` — deliberately stricter than the full MiMo API surface; only familiar formats:

| Modality | MIME allowlist |
| --- | --- |
| image | `image/jpeg`, `image/png`, `image/webp`, `image/gif` |
| PDF | `application/pdf` |
| audio | `audio/wav`, `audio/x-wav`, `audio/mp3`, `audio/mpeg` |
| video | `video/mp4` |

Official MiMo also lists BMP/FLAC/M4A/OGG/MOV/AVI/WMV; `read` will not attach those. User direction: 最熟悉的几个处理，别的都不要，避免 ts 被当视频。GIF stays (explicitly allowed).

Helpers: `isReadImageMime`, `isReadPdfMime`, `isReadAudioMime`, `isReadVideoMime`, `isReadAttachmentMime`.

`read.ts` branching after `sniffAttachmentMime`:

1. MIME in a finite list → existing size / model-capability / adapter-declaration gates, then attach.
2. MIME looks like media (`image/*`, `audio/*`, `video/*`, `application/pdf`) but is **outside** every finite list:
   - sample is binary → refuse with a convert hint that names that modality’s finite list (preserves real-media UX for e.g. `.webm`, `.aac`).
   - sample is text-like → **fall through** to the text path. This is the `.ts` / `.mts` fix: `video/mp2t` is not on the video list, and TypeScript source is not binary.
3. Otherwise → existing text / binary-fail path.

No `modality` tool parameter in this change. Sniffing still overrides extension for known image/pdf/wav headers, but a sniffed MIME outside the finite list (e.g. BMP) is not attached.

`describeMedia` names only the finite read allowlist formats so the tool description matches what `read` will actually attach.

`view_image`, prompt-attachment routing, and MCP sampling keep their current prefix/capability logic (out of scope).

## [S3] Out of Scope

- Adding a `modality` parameter to `read`.
- Changing `AppFileSystem.mimeType` / `mime-types` itself.
- Broadening or narrowing provider capability declarations in `capability-registry.ts`.
- prompt-side user attachments, MCP sampling, or `view_image` MIME policy.
- Supporting MPEG-TS video (`.ts`/`.m2ts`) even when binary — callers convert to `video/mp4` first.

## Tasks
- [ ] T1: Export finite read-attachment MIME allowlists and membership helpers from `util/media.ts` — acceptance: helpers return true only for listed MIMEs; `video/mp2t` is not a read image/audio/video/pdf mime (covers: S2)
- [ ] T2: Gate `tool/read.ts` media branches on the finite lists; binary media-like files outside the list still refuse with a convert hint naming the allowed list; text-like media-like MIMEs fall through to text — acceptance: `.ts` TypeScript source reads as text; `.webm` binary still refuses with convert hint (covers: S2; depends: T1)
- [ ] T3: Add/adjust regression tests in `test/util/media.test.ts` and `test/tool/read.test.ts` — acceptance: tests cover `.ts`/`.mts` as text, finite-list attach still works for wav/mp4, out-of-list binary media still refuses (covers: S2; depends: T2)
