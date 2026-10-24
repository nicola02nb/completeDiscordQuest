> [!CAUTION]
> As of April 7th 2026, Discord has expressed their intent to crack down on automating quest completion (`Quest Activity Notice`).
>
> <img width="836" height="272" alt="574947159-6b439f4b-4381-4524-8540-b6a4777a80d0" src="https://github.com/user-attachments/assets/db4c7641-dd57-412e-a625-f39a363f2138" />
>
> **Why unpatched versions trigger `Quest Activity Notice` (Reverse-Engineered Root Causes):**
> 1. **Missing `executableFingerprint` (`discord_utils.node` `sub_a3990` -> `sub_a4120` -> `sub_1350`):** The unpatched `fakeGame` object omitted `executableFingerprint` (the 196-character Base64 146-byte (`0x92`) struct containing `WinVerifyTrust` signature status, `file_size`, `time_date_stamp`, `size_of_image`, `pe_headers_sha256`, `hw_sha256`, `sections_sha256`, and `cert_sha256` XORed with `SHA256(userId + "https://discord.com/careers")`), causing `Module 396813` (`ea(e)`) to send `executable_fingerprint: undefined` on every `POST /quests/{id}/heartbeat`.
> 2. **Vencord Client-Mod Bitfield (`libdiscore-wasm`) & `Error().stack` Leak (`Module 499785`):** `window.Vencord` sets Bit 43 in the 128-bit `launch_signature` UUID inside `X-Super-Properties`, and `HTTPWithAnalytics.post` (`Module 499785`) captures `Error().stack` into `network_action_quest_heartbeat.stack_trace`, leaking `vencord://` and `CompleteDiscordQuest` stack frames.
> 3. **Self-Identifying `FakeApp ... (CompleteDiscordQuest)` String & Destructive `RunningGameStore` Replacement:** `STREAM_ON_DESKTOP` injected `"FakeApp ... (CompleteDiscordQuest)"` into `ApplicationStreamingStore`, and `getRunningGames()` wiped out all real running games instead of merging them with full 22-key native scanner schemas.
>
> See [`SECURITY_AUDIT_AND_REVERSE_ANALYSIS.md`](./SECURITY_AUDIT_AND_REVERSE_ANALYSIS.md) for the complete IDA / binary reverse-engineering report and applied stealth mitigations.
>
> **Flagship Suite (Console Script, Vencord Plugins, Python CLI & Full IDA Write-up):** [`ccsimplyspolit/discord-quest-stealth`](https://github.com/ccsimplyspolit/discord-quest-stealth)

# CompleteDiscordQuest for Vencord (Stealth Hardened)

This is a porting of the original BetterDiscord(BD) plugin [CompleteDiscordQuest](https://github.com/nicola02nb/BetterDiscord-Stuff/tree/main/Plugins/CompleteDiscordQuest).

A Vencord(VC) plugin that completes multiple Discord quests in background simultaneously with full `discord_utils.node` `executableFingerprint` synthesis and telemetry scrubbing.

## Credits:

This is a porting for BetterDiscord of a [snippet](https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb) made by [aamiaa](https://github.com/aamiaa) ([Stealth Patched Fork](https://gist.github.com/ccsimplyspolit/f323e1b626dff79bfc08b24bc3dc27bd)).

## Features:

- One-time consent prompt before automation starts
- WebCrypto synthesis of 196-character `executableFingerprint` (`sub_a3990` / `sub_a4120` / `sub_1350`) with local `hw_sha256` harvesting
- Full 22-key `RunningGameStore` schema & non-destructive game merging
- Automatic scrubbing of the 12 `libdiscore-wasm` client-mod bits in `X-Super-Properties.launch_signature` and `Error.prototype.stack` sanitization
- Sub-second float jitter on `WATCH_VIDEO` and 60s `{ application_id, terminal }` cadence on `PLAY_ACTIVITY`
- Auto enroll quests & filter by quest/reward type
