# Full Reverse-Engineering Audit of Discord Quest Anti-Fraud Protection (`discord_utils.node`, `libdiscore-wasm`, `discord_web_bundle.js`)

## 1. Executive Summary: Why Unpatched `completeDiscordQuest` Triggers `Quest Activity Notice`

Through static and dynamic reverse engineering of the Windows Discord Desktop client (`app-1.0.9265`), specifically:
- **`discord_utils.node`** (Native C++ process scanner & Authenticode verifier, analyzed in IDA Pro)
- **`libdiscore-wasm`** (Rust/WASM telemetry & client-modification detector)
- **`discord_web_bundle.js`** (Webpack modules `396813`, `378187`, `973522`, `952818`, `499785`, `174459`, `70298`)

we identified the exact client-side and server-side detection vectors that cause Discord to issue **`Quest Activity Notice`** warnings when users run `nicola02nb/completeDiscordQuest`:

1. **Missing `executableFingerprint` in `fakeGame` (`index.tsx:327-339`):**
   - When `RunningGameStore.getRunningGames()` is spoofed, `QuestProgressManager` (`Module 378187`) calls `sendHeartbeat` (`Module 396813` `ea(e)`), which extracts `executable_path: (0, o.Ic)(t?.exePath)` and `executable_fingerprint: t?.executableFingerprint`.
   - Because `fakeGame` omits `executableFingerprint` (and 10 other native scanner properties), every `POST /quests/{id}/heartbeat` sends `executable_fingerprint: undefined`.
2. **Vencord Client-Mod Bitfield in `X-Super-Properties.launch_signature` (`libdiscore-wasm`):**
   - `libdiscore-wasm`'s `generateLaunchSignature()` probes `window` globals (`window.Vencord`, `window.VencordNative`, `window.$`, `window.BdApi`, etc.) and sets 12 specific bits (`[0, 19, 27, 36, 43, 52, 66, 72, 79, 89, 103, 116]`, MSB-first) inside the 128-bit `launch_signature` UUIDv4 sent in `X-Super-Properties` on every `/quests/*` request. Bit 43 specifically flags `window.Vencord`.
3. **`vencord://` Stack Trace Leak in `network_action_quest_heartbeat` (`Module 499785`):**
   - `Module 396813` (`ea(e)`) sends quest heartbeats via `HTTPWithAnalytics.post` (`Module 499785`), which dispatches a `network_action_quest_heartbeat` science event containing `stack_trace: Error().stack ?? ""`. Without an `Error.prototype.stack` sanitizer, `stack_trace` directly leaks `vencord://` and `CompleteDiscordQuest` frames to Discord's telemetry pipeline.
4. **Self-Identifying String in `STREAM_ON_DESKTOP` (`index.tsx:374`):**
   - `fakeApp` sets `name: "FakeApp ${applicationName} (CompleteDiscordQuest)"` inside `ApplicationStreamingStore.getStreamerActiveStreamMetadata()`.
5. **Destructive `RunningGameStore.getRunningGames` Override (`index.tsx:72, 126`):**
   - When `fakeGames.size > 0`, `getRunningGames()` replaces all genuinely running games instead of merging them, causing an unnatural simultaneous drop of all background games in `RUNNING_GAMES_CHANGE` and breaking `stopAllFarming()` cleanup (since `RunningGameStore.getRunningGames()` called on line 240 while `fakeGames` was just cleared or active returns inconsistent state).
6. **Integer `timestamp` on Final `WATCH_VIDEO` Request & Legacy `PLAY_ACTIVITY` Payload:**
   - Line 314 sends `{ timestamp: secondsNeeded }` as an exact integer on the final `/video-progress` request, and `PLAY_ACTIVITY` uses a 20s `stream_key` loop instead of Discord's 60s `{ application_id, terminal }` contract.

---

## 2. Native Process Fingerprinting (`discord_utils.node`: `sub_a3990` -> `sub_a4120` -> `sub_1350`)

When a real game is detected by Discord's native process observer (`setObservedGamesCallback` in `discord_utils.node`), function `sub_a3990` (`0x1800a3990`) invokes `sub_a4120` (`0x1800a4120`), `sub_a3f60` (`0x1800a3f60`), and `sub_1350` (`0x180001350`) to construct and encrypt a **146-byte (`0x92`) binary fingerprint** for the running `.exe` into a **196-character Base64 string** named **`executableFingerprint`**.

### 2.1 Binary Layout of the 146-Byte (`0x92`) Struct (`sub_1350` at `0x180001350`)

| Offset | Size | Field | Native Source in `discord_utils.node` |
| :--- | :--- | :--- | :--- |
| `0x00` | `1 B` | `version` | Always `0x01` (un-XORed plaintext header byte in `sub_1350`) |
| `0x01` | `1 B` | `flags` | Bitfield (`0x03` for signed PE64): `Bit 0 (0x01)` = `is_signed` (`WinVerifyTrust == 0` at `0x1800a4224`), `Bit 1 (0x02)` = `is_pe64` (`OptionalHeader.Magic == 0x20B` at `0x1800a3d3b`) |
| `0x02..0x09` | `8 B` | `file_size` | `uint64 LE` from `GetFileSizeEx` (`0x1800a3b97`) |
| `0x0A..0x0D` | `4 B` | `time_date_stamp` | `uint32 LE` PE COFF `FileHeader.TimeDateStamp` (`e_lfanew + 0x08`) |
| `0x0E..0x11` | `4 B` | `size_of_image` | `uint32 LE` PE `OptionalHeader.SizeOfImage` (`e_lfanew + 0x50`, page-aligned) |
| `0x12..0x31` | `32 B` | `pe_headers_sha256` | `SHA-256` of DOS + NT + Optional PE headers (`0x1800a3cb3..0x1800a3cd2`) |
| `0x32..0x51` | `32 B` | `hw_sha256` | Hardware + user hash from `sub_a3f60` (`0x1800a3f60`): `SHA-256(RegGetValueW("HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid") \|\| userId)` |
| `0x52..0x71` | `32 B` | `sections_sha256` | `SHA-256` of the PE `IMAGE_SECTION_HEADER` table (`NumSections * 40` bytes at `0x1800a3cd7..0x1800a3d16`) |
| `0x72..0x91` | `32 B` | `cert_sha256` | Authenticode certificate hash from `sub_a4120` (`0x1800a4120`): `SHA-256(UTF8(Publisher_CN) \|\| SHA256(SubjectPublicKeyInfo))` |

### 2.2 Stream Obfuscation (`sub_1350` at `0x180001350` & `sub_116790` at `0x180116790`)

Before returning `executableFingerprint` to JavaScript (`RunningGameStore`), `sub_1350` derives a 32-byte key:
$$\text{Key} = \text{SHA-256}(\text{userId} \mathbin{\Vert} \text{"https://discord.com/careers"})$$
keeps byte `0x00` (`version = 0x01`) un-XORed, and XORs bytes `i = 1..145` (`0x01..0x91`):
$$\text{cipher}[0] = 1, \quad \text{cipher}[i] = \text{plain}[i] \oplus \text{Key}[(i - 1) \bmod 32] \quad (1 \le i \le 145)$$
Finally, `sub_116790` Base64-encodes the 146-byte buffer into a **196-character string** (`executableFingerprint`).

---

## 3. What This Patch Fixes in `completeDiscordQuest`

1. **WebCrypto `sub_a3990` / `sub_a4120` / `sub_1350` `executableFingerprint` Synthesis:**
   - Synthesizes a valid 196-character Base64 `executableFingerprint` for every spoofed `PLAY_ON_DESKTOP` game (`version = 0x01` un-XORed at `[0x00]`, `flags = 0x03` `is_signed | is_pe64` at `[0x01]`, realistic 48–140 MB `file_size`, `time_date_stamp`, page-aligned `size_of_image`, deterministic `pe_headers_sha256`, harvested local `hw_sha256` block `[0x32..0x51]`, `sections_sha256`, and `cert_sha256`), XORing bytes `[1..145]` with `xor_key[(i - 1) & 31]`.
2. **Full 22-Key `RunningGameStore` Schema & Non-Destructive Merging:**
   - Populates all 22 properties expected by `RunningGameStore` (`distributor`, `elevated`, `executableFingerprint`, `fullscreenType`, `gameMetadata`, `lastFocused`, `nativeProcessObserverId`, `origGameName`, `sandboxed`, `sku`, `windowHandle`, etc.) and merges spoofed games with real running games instead of wiping them out.
3. **`launch_signature` 12-Bit Client-Mod Scrubber & `Error.prototype.stack` Sanitizer:**
   - Clears all 12 client-mod detection bits (`[0, 19, 27, 36, 43, 52, 66, 72, 79, 89, 103, 116]`) from `X-Super-Properties.launch_signature` and strips `vencord://` / `CompleteDiscordQuest` frames from `Error().stack`.
4. **Removes Self-Identifying `FakeApp ... (CompleteDiscordQuest)` String & Fixes `WATCH_VIDEO` / `PLAY_ACTIVITY` Telemetry:**
   - Uses clean `applicationName` metadata in `STREAM_ON_DESKTOP`, sub-second float jitter on all `/video-progress` calls, and 60s `{ application_id, terminal }` heartbeats on `PLAY_ACTIVITY`.
