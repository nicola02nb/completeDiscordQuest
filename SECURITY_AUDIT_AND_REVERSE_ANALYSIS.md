# Full Reverse-Engineering Audit of Discord Quest Anti-Fraud Protection (`discord_utils.node`, `libdiscore-wasm`, `discord_web_bundle.js`)

## 1. Executive Summary: Why Existing Quest Tools Trigger `Quest Activity Notice`

Through static and dynamic reverse engineering of the Windows Discord Desktop client (`app-1.0.9265`), specifically:
- **`discord_utils.node`** (Native C++ process scanner & Authenticode verifier, analyzed in IDA Pro)
- **`libdiscore-wasm`** (Rust/WASM telemetry & client-modification detector)
- **`discord_web_bundle.js`** (Webpack modules `396813`, `378187`, `973522`, `952818`, `499785`, `174459`, `70298`)

we identified the exact client-side and server-side detection vectors that cause Discord to issue **`Quest Activity Notice`** warnings and suspend Quest access when users run:
1. **`aamiaa/CompleteDiscordQuest.md`** (DevTools Console script)
2. **`nicola02nb/completeDiscordQuest`** (Vencord / BetterDiscord plugin)
3. **`Masterain98/discord-quest-helper`** (Tauri + Rust + CDP + dummy PE runner)

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

$$\text{Key} = \text{SHA-256}(\text{userId} \mathbin{\Vert} \text{"https:}\text{//discord.com/careers"})$$

keeps byte `0x00` (`version = 0x01`) un-XORed, and XORs bytes `i = 1..145` (`0x01..0x91`):

$$\text{cipher}[0] = 1, \quad \text{cipher}[i] = \text{plain}[i] \oplus \text{Key}[(i - 1) \bmod 32] \quad (1 \le i \le 145)$$

Finally, `sub_116790` Base64-encodes the 146-byte buffer into a **196-character string** (`executableFingerprint`).

---

## 3. Quest Heartbeat & Telemetry Pipeline in `discord_web_bundle.js`

### 3.1 `Module 396813` (`ea(e)` — `QUESTS_HEARTBEAT`) & `Module 973522` (`o.Ic`)

When `QuestProgressManager` (`Module 378187`) sends a desktop play heartbeat, it executes `ea(e)` in `Module 396813`:
```js
let t = m.Ay.getRunningGames().find(t => t.id === n),
    r = (0, o.Ic)(t?.exePath),
    i = t?.executableFingerprint;
return L.A.post({
    url: R.Rsh.QUESTS_HEARTBEAT(e),
    body: {
        stream_key: a,
        container_id: s,
        application_id: n,
        terminal: l,
        executable_path: r,
        executable_fingerprint: i
    }
});
```
where `o.Ic` (`Module 973522`) normalizes `exePath` to the **last 2 lowercase `/` segments**:
```js
function u(e) {
    return null == e ? null : e.toLowerCase().replaceAll("\\", "/").split("/").filter(e => "" !== e).slice(-2).join("/");
}
```

### 3.2 `Module 499785` (`L.A.post` — `HTTPWithAnalytics`) Stack Trace Leak

Crucially, `Module 396813` does **not** use raw `RestAPI.post` (`o.Bo.post`). It calls `L.A.post` (`Module 499785`), which wraps `RestAPI.post` and dispatches the `network_action_quest_heartbeat` science analytics event containing:
```js
{
    quest_id: i,
    application_id: t.body?.application_id,
    executable_path: t.body?.executable_path,
    executable_fingerprint: t.body?.executable_fingerprint,
    stack_trace: Error().stack ?? "",
    is_playtime_eligible: a
}
```
- If a tool calls raw `RestAPI.post({ url: "/quests/.../heartbeat" })`, Discord's backend receives the HTTP heartbeat **without** the corresponding `network_action_quest_heartbeat` science event.
- If a tool triggers `QuestProgressManager` from a Vencord plugin or DevTools console without sanitizing `Error.prototype.stack`, `stack_trace` directly transmits `vencord://`, `CompleteDiscordQuest`, or `<anonymous>:` frames!

### 3.3 `libdiscore-wasm` `generateLaunchSignature` (128-Bit Client-Mod Bitfield)

Every API request includes `X-Super-Properties` (Base64 JSON). Inside `libdiscore-wasm` (called by `Module 174459` / `Module 70298`), `generateLaunchSignature()` generates a 128-bit UUIDv4 and probes `window` properties (`window.$`, `window.Vencord`, `window.VencordNative`, `window.BdApi`, `window.BetterDiscord`, etc.), setting specific bits in the UUID (`[0, 19, 27, 36, 43, 52, 66, 72, 79, 89, 103, 116]`, MSB-first where Bit 0 is `window.$` and Bit 43 is `window.Vencord`).
- Deleting `window.$` in the console *after* Discord has already booted does **not** clear Bit 0 from the already-cached `X-Super-Properties.launch_signature`.
- Running inside Vencord sets **Bit 43** on every `/quests/*` request unless `launch_signature` is scrubbed.

### 3.4 `Module 396813`, `Module 710969`, & `Module 738822`: Sealed Ad-Decision Metadata, Interactive Quests (`ACHIEVEMENT_IN_ACTIVITY`), & Multi-Platform Reward Claiming

1. **Background Fetching & Backfilling of `metadata_sealed` / `traffic_metadata_sealed` (`Module 396813` & `Module 710969`):**
   - When Discord fetches quests or ad decisions (`N1` = `fetchCurrentQuests("quest_home")`, `r8` = `fetchQuestToDeliver(placement)`, `yO` = `fetchEarnedQuestToDeliver()`), `QuestsStore` and `AdDeliveryStore` (`getQuestAdDecisionByQuestId(questId)`) populate `metadataSealed`, `trafficMetadataRaw`, and `trafficMetadataSealed`.
   - When enrolling (`Oy` -> `POST /quests/{id}/enroll`) or claiming a reward (`Oq` -> `POST /quests/{id}/claim-reward`), `Module 396813` uses `Module 710969` (`p(questContent)`) to map `questContent` (`1` = `QUEST_BAR_V2`, `10` = `QUEST_HOME_DESKTOP`) to placement `1`, attaches `metadata_sealed` when `p(location) === 1`, and always attaches `traffic_metadata_raw` and `traffic_metadata_sealed`.
   - Enrolling or claiming in the background without opening Quest Home previously omitted `metadata_sealed` and `traffic_metadata_sealed`. Invoking `N1("quest_home")` / `r8(1)` / `yO()` in the background and backfilling `metadata_sealed`, `traffic_metadata_raw`, and `traffic_metadata_sealed` from `QuestsStore` and `AdDeliveryStore` guarantees identical payloads without opening the Quest Home tab.
2. **Interactive Activity Quests (`ACHIEVEMENT_IN_ACTIVITY` / `PLAY_ACTIVITY` — `Module 396813` `R2`, `Module 876620` `GET_QUEST`, & Arise Activity Backend `/.proxy/acf/*`):**
   - Interactive activity quests (such as `VALORANT Aces: Round 3`, Quest ID `1551980932276293683`, Application ID `1536318183873454090` hosted at `https://1536318183873454090.discordsays.com`) use task type `ACHIEVEMENT_IN_ACTIVITY` with `target: 1`.
   - **Discord Client Bug in `GET_QUEST` RPC (`Module 876620`):** When an Embedded Activity calls `discordSdk.commands.getQuest()`, Discord's RPC handler filters `QuestsStore.quests` by matching `application.id` and `enrolledAt != null`, sorts by `enrolledAt` ascending, and returns `e[0]` **without checking `completedAt == null`**. If a user previously completed Round 1 or Round 2 under the same `applicationId` (`1536318183873454090`), `getQuest()` returns the old completed quest instead of Round 3 (`1551980932276293683`), causing the Activity's `POST /.proxy/acf/quest/progress` to submit the wrong `quest_id` (`HTTP 400`)! Temporarily shifting `userStatus.enrolledAt` of already-completed sibling quests to `"2099-01-01T00:00:00.000Z"` ensures `GET_QUEST` always resolves the active uncompleted quest.
   - **Headless Activity Backend Completion (`/.proxy/acf/*` & `/.proxy/api/*`):**
     1. Pre-acknowledge `/applications/{applicationId}/disclosures` (`GET` -> `POST { disclosures }` when `!all_acked`) so Discord's `AUTHORIZE` handler `k2` never blocks on first-time disclosure consent, then obtain an OAuth2 authorization code via `POST /oauth2/authorize?client_id=1536318183873454090&response_type=code&scope=identify&prompt=none`.
     2. Exchange the code at `POST https://1536318183873454090.discordsays.com/.proxy/acf/authorize` (`{ code, activityId }`) to obtain the ACF session JWT (`token`), and register at `POST /.proxy/acf/arise/register` to obtain the Arise session JWT (`authToken`).
     3. **`module "lDfAK"` `X-Request-Id` 122-Bit Cryptographic MAC:** On `/.proxy/api/*` endpoints (`POST /.proxy/api/profileTitle/add` with `{"id":"f0rsaken-ace"}` and `POST /.proxy/api/profile/mission-completed`), `arise-frontend.ba2cc06e.js` (`module "9K8Jg"` & `module "lDfAK"`) computes `X-Request-Id` by packing a 58-bit random nonce $o$ and a 64-bit MAC tag $i = \text{FNV-1a}_{64}(\text{UTF8}(\text{body})) \oplus \text{SplitMix64}(\text{0x6c1fd93a84b7250e} \oplus ((o + \text{0x9e3779b97f4a7c15}) \bmod 2^{64}))$ into the 122 non-version/non-variant bit positions (`[127..80, 75..64, 61..0]`) of a UUIDv4 string (`4n << 76n | 2n << 62n`). Sending a plain `randomUUID()` on `/.proxy/api/*` causes the Arise backend to shadow-drop the request, whereas `buildAriseRequestId(bodyStr)` passes server-side MAC verification. (By contrast, `/.proxy/acf/*` endpoints in `module "7jzTX"` do not send `X-Request-Id`.)
     4. Submit `POST https://1536318183873454090.discordsays.com/.proxy/acf/quest/progress` with `{ progress: 1, quest_id: "<questId>" }`, which triggers the Activity backend to sign and forward the `ACHIEVEMENT_IN_ACTIVITY` completion directly to Discord's Partner API (`{"status":"ok"}`).
   - **Minimized PIP Frame + `AriseBridgeHost` `postMessage` Fallback:** If an Activity iframe is open (or auto-launched in minimized PIP mode via `FrameManager.launchFrame` + `updateFrameLayoutMode({ layoutMode: 1 })`), posting `{ type: "award-title", payload: "f0rsaken-ace" }` and `{ type: "quest-completed" }` to the iframe triggers `AriseBridgeHost.handleInternalEvent("quest-completed")` (`module "7jzTX"` `completeQuest()`).
3. **Configurable Multi-Platform Reward Priority (`Module 738822` `QuestRewardPlatform`):**
   - `Module 738822` defines `QuestRewardPlatform`: `CROSS_PLATFORM = 0`, `XBOX = 1`, `PLAYSTATION = 2`, `SWITCH = 3`, `PC = 4`.
   - For multi-platform `REWARD_CODE` quests (`rewardsConfig.platforms.length > 1`), selecting the highest-priority available platform according to a configurable priority order (default `[4, 2, 1, 3, 0]` = `PC -> PS5/PlayStation -> Xbox -> Switch -> Cross-Platform`) enables automatic reward claiming without user intervention.

---

## 4. Vulnerability Breakdown by Repository

### 4.1 `aamiaa/CompleteDiscordQuest.md`
1. **`executableFingerprint` is `undefined`:** `fakeGame` only defines 11 properties and omits `executableFingerprint`. Every `PLAY_ON_DESKTOP` heartbeat sends `executable_fingerprint: undefined`.
2. **Destructive `RunningGameStore` overwrite:** Replaces `getRunningGames()` with `[fakeGame]` and dispatches `removed: realGames`, causing an unnatural simultaneous drop of all background processes.
3. **Late `delete window.$`:** Does not scrub already-set detection bits (`Bit 0`, `Bit 43`, etc.) in `X-Super-Properties.launch_signature`, nor does it sanitize `Error.prototype.stack`.
4. **Exact integer `timestamp` on final `WATCH_VIDEO` POST:** Sends `{ timestamp: secondsNeeded }` as an exact integer and does not rate-gate against `enrolledAt` in the main snippet.

### 4.2 `nicola02nb/completeDiscordQuest` (Vencord Plugin)
1. **Guaranteed Client-Mod Flag (`Bit 43` in `launch_signature`) + `vencord://` in `stack_trace`:** Because it runs as a Vencord plugin without scrubbing `launch_signature` or `Error.prototype.stack`, every Quest heartbeat carries Vencord's bitfield signature in `X-Super-Properties` and Vencord stack frames in `network_action_quest_heartbeat`.
2. **Missing `executableFingerprint` & incomplete 22-key `RunningGameStore` schema:** `fakeGame` in `index.tsx` lacks `executableFingerprint`, sending `executable_fingerprint: undefined` on `PLAY_ON_DESKTOP` heartbeats.
3. **Unnatural `STREAM_ON_DESKTOP` metadata:** Sets `name: "FakeApp ${applicationName} (CompleteDiscordQuest)"` on `fakeApp`.

### 4.3 `Masterain98/discord-quest-helper`
1. **Unsigned Dummy PE (`stagecraft.exe` / `stealth_pe.rs`) Fails `WinVerifyTrust`:**
   - When `discord_utils.node` scans the dummy process, `WinVerifyTrust` (`0x1800a4224`) returns non-zero (`is_signed = 0`, so `flags` bit 0 is `0`), `cert_sha256` (`[0x72..0x91]`) is 32 zero bytes (`00..00`), and `file_size` is ~150 KB instead of a 48–140 MB Authenticode-signed game binary.
2. **CDP Spoof Explicitly Sets `executableFingerprint: undefined` (`cdp_quest.rs:497`):**
   - In CDP mode (`js_spoof_play_game_for`), `fakeGame.executableFingerprint` is hardcoded to `undefined`!
3. **Direct API Game Heartbeat Omits `executable_path` & `executable_fingerprint` (`discord_api.rs:900`):**
   - `GameHeartbeatPayload` only serializes `{ application_id, terminal }`, omitting `executable_path` and `executable_fingerprint` completely.
4. **Video Progress Float Jitter Destroyed by `timestamp.round() as u64` (`discord_api.rs:195`):**
   - `quest_completer.rs:123` adds `rand::rng().random_range(0.0..0.5)`, but `discord_api.rs:195` immediately calls `timestamp.round() as u64`, turning every timestamp back into an integer!

---

## 5. Summary of Applied Stealth Fixes

1. **`sub_a3990` / `sub_a4120` / `sub_a3f60` / `sub_1350` Signed `executableFingerprint` Synthesis:**
   - Synthesizes a valid 146-byte (`0x92`) binary payload with un-XORed `version = 0x01`, `flags = 0x03` (`synthetic is_signed | is_pe64` for `.exe` binaries, or `0x01` `synthetic is_signed` for non-PE paths; not live Authenticode verification), realistic 48–140 MB `file_size`, valid PE `time_date_stamp` and page-aligned `size_of_image`, deterministic `pe_headers_sha256` (`[0x12..0x31]`), real local `hw_sha256` (`[0x32..0x51]`, harvested from existing native process entries or computed from `SHA-256(MachineGuid || userId)`), `sections_sha256` (`[0x52..0x71]`), and `cert_sha256` (`[0x72..0x91]`, `SHA-256(UTF8(Publisher_CN) || SPKI_SHA256)`), XORed on bytes `1..145` with `SHA-256(userId + "https://discord.com/careers")` and Base64-encoded to 196 characters.
2. **`Module 973522` (`o.Ic`) 2-Segment `executable_path` Formatting:**
   - Ensures all `exePath` and `executable_path` values conform to Discord's 2-segment lowercase forward-slash format.
3. **`launch_signature` 12-Bit Client-Mod Scrubber & `Error.prepareStackTrace` Sanitizer:**
   - Clears all 12 client-mod bits (`[0, 19, 27, 36, 43, 52, 66, 72, 79, 89, 103, 116]`) in `X-Super-Properties` and strips `<anonymous>`, `vencord://`, and plugin frames via `Error.prepareStackTrace` (without mutating `Error.prototype.stack`'s property descriptor).
4. **Sub-Second Floating-Point `WATCH_VIDEO` Timestamps, Non-Destructive `RunningGameStore` Merging, & 15s PID Tombstone Cache:**
   - Preserves realistic millisecond float precision (`f64`) on `/video-progress`, merges spoofed games non-destructively with all 22 `RunningGameStore` schema keys, and retains a 15-second PID tombstone in `getGameForPID` so `OverlayRenderStore` never logs `untracked pid` warnings on teardown.
5. **Sealed Metadata Auto-Fetch (`metadata_sealed` / `traffic_metadata_sealed`), `ACHIEVEMENT_IN_ACTIVITY` Support, & Configurable Multi-Platform Auto-Claim (`rewardPlatformPriority`):**
   - Automatically triggers Discord's internal Quest Decision / Current Quests fetchers in the background and backfills `metadata_sealed`, `traffic_metadata_raw`, and `traffic_metadata_sealed` from `QuestsStore` and `AdDeliveryStore` on `/enroll` and `/claim-reward`; supports `ACHIEVEMENT_IN_ACTIVITY` and `PLAY_ACTIVITY` heartbeats with `stream_key` + `application_id`; and automatically selects the preferred reward platform (`PC -> PS5 -> Xbox -> Switch`) on multi-platform `REWARD_CODE` quests.

---

## 6. Reference Implementations & Patches

- **Flagship Repository (Console Script, Vencord Plugins, Python CLI & Full IDA Write-up):** [`ccsimplyspolit/discord-quest-stealth`](https://github.com/ccsimplyspolit/discord-quest-stealth)
- **Standalone Console Script & Full Audit Gist:** [`ccsimplyspolit/CompleteDiscordQuest.md`](https://gist.github.com/ccsimplyspolit/f323e1b626dff79bfc08b24bc3dc27bd)
- **Vencord Plugin Implementation:** [`ccsimplyspolit/completeDiscordQuest`](https://github.com/ccsimplyspolit/completeDiscordQuest) (Upstream PR: [`nicola02nb/completeDiscordQuest#28`](https://github.com/nicola02nb/completeDiscordQuest/pull/28))
- **Rust / Tauri / CDP Implementation:** [`ccsimplyspolit/discord-quest-helper`](https://github.com/ccsimplyspolit/discord-quest-helper) (Upstream PR: [`Masterain98/discord-quest-helper#218`](https://github.com/Masterain98/discord-quest-helper/pull/218))
- **Author & Security Research Portfolio:** [`@ccsimplyspolit`](https://github.com/ccsimplyspolit)

