/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

interface GuildData {
    "4": _4[];
    id: string;
    SELECTABLE: SELECTABLE[];
    VOCAL: VOCAL[];
    count: number;
}

interface VOCAL {
    channel: Channel3;
    comparator: number;
}

interface Channel3 {
    bitrate_: number;
    flags_: number;
    guild_id: string;
    iconEmoji: IconEmoji;
    id: string;
    lastMessageId: string;
    name: string;
    nsfw_: boolean;
    parent_id: string;
    permissionOverwrites_: PermissionOverwrites3;
    position_: number;
    rateLimitPerUser_: number;
    rtcRegion: null;
    type: number;
    userLimit_: number;
}

interface PermissionOverwrites3 {
    "710398144927760385": _732946168241455134;
    "86004744966914048": _732946168241455134;
    "125166040689803264": _732946168241455134;
    "119598727512981504": _732946168241455134;
    "812676843178033163"?: _732946168241455134;
    "165005972970930176": _732946168241455134;
    "732946168241455134": _732946168241455134;
    "123589140313931776"?: _732946168241455134;
    "179801557666234368"?: _732946168241455134;
}

interface SELECTABLE {
    channel: Channel2;
    comparator: number;
}

interface Channel2 {
    flags_: number;
    guild_id: string;
    iconEmoji?: IconEmoji;
    id: string;
    lastMessageId: string;
    name: string;
    nsfw_: boolean;
    parent_id: string;
    permissionOverwrites_: PermissionOverwrites2;
    position_: number;
    rateLimitPerUser_: number;
    topic_: null | string;
    type: number;
    availableTags?: AvailableTag[];
    defaultThreadRateLimitPerUser?: number;
    template?: string;
    defaultAutoArchiveDuration?: number;
    defaultReactionEmoji?: DefaultReactionEmoji;
    lastPinTimestamp?: string;
    themeColor?: null;
}

interface DefaultReactionEmoji {
    emojiId: null;
    emojiName: string;
}

interface AvailableTag {
    id: string;
    name: string;
    emojiId: null | string;
    emojiName: null | string;
    moderated: boolean;
    color: null;
}

interface PermissionOverwrites2 {
    "732946168241455134": _732946168241455134;
    "115233569315487746"?: _732946168241455134;
    "86004744966914048": _732946168241455134;
    "303821663341117453"?: _732946168241455134;
    "179801557666234368"?: _732946168241455134;
    "119598727512981504"?: _732946168241455134;
    "166901598491115520"?: _732946168241455134;
    "123589140313931776"?: _732946168241455134;
    "81388395867156480"?: _732946168241455134;
    "710398144927760385"?: _732946168241455134;
    "887483732905328740"?: _732946168241455134;
    "170566292535902208"?: _732946168241455134;
    "1024119105067954179"?: _732946168241455134;
    "125166040689803264"?: _732946168241455134;
    "204353455077195776"?: _732946168241455134;
    "165005972970930176"?: _732946168241455134;
    "1050102447848312962"?: _732946168241455134;
    "192058515202768906"?: _732946168241455134;
    "777264613867257857"?: _732946168241455134;
    "813904264615034911"?: _732946168241455134;
    "678469587444170762"?: _732946168241455134;
    "829448516869816341"?: _732946168241455134;
    "776580096479330314"?: _732946168241455134;
    "813232108226478120"?: _732946168241455134;
    "1024427322142634065"?: _732946168241455134;
    "853635340694716436"?: _732946168241455134;
    "812676843178033163"?: _732946168241455134;
    "1319711858009051238"?: _732946168241455134;
}

interface IconEmoji {
    id: null;
    name: string;
}

interface _4 {
    comparator: number;
    channel: Channel;
}

interface Channel {
    id: string;
    type: number;
    name: string;
    guild_id: null | string;
    permissionOverwrites_: PermissionOverwrites;
    flags_?: number;
    nsfw_?: boolean;
    position_?: number;
    rateLimitPerUser_?: number;
}

interface PermissionOverwrites {
    "732946168241455134"?: _732946168241455134;
    "86004744966914048"?: _732946168241455134;
    "125166040689803264"?: _732946168241455134;
    "165005972970930176"?: _732946168241455134;
    "119598727512981504"?: _732946168241455134;
    "813904264615034911"?: _732946168241455134;
    "812676843178033163"?: _732946168241455134;
    "887483732905328740"?: _732946168241455134;
    "303821663341117453"?: _732946168241455134;
    "179801557666234368"?: _732946168241455134;
    "828750276986536027"?: _732946168241455134;
    "732255961871548578"?: _732946168241455134;
}

interface _732946168241455134 {
    id: string;
    type: number;
    allow: string;
    deny: string;
}
